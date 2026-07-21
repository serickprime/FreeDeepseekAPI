'use strict';

const http = require('http');
const crypto = require('crypto');
const { assertConfig, cors, authorized, safeError, isLoopback } = require('./lib/security');
const { SessionStore } = require('./lib/session');
const { parseToolCall, toolPrompt } = require('./lib/tool_parser');
const { createProtocolStream } = require('./lib/api_stream');
const { complete } = require('./client');

const MODELS = {
  'deepseek-chat': { model_type: 'default', reasoning: false, search: false, label: 'DeepSeek Web default non-thinking mode' },
  'deepseek-reasoner': { model_type: 'default', reasoning: true, search: false, label: 'DeepSeek Web default thinking mode' },
  'deepseek-chat-search': { model_type: 'default', reasoning: false, search: true, label: 'DeepSeek Web default non-thinking mode with web search' },
  'deepseek-reasoner-search': { model_type: 'default', reasoning: true, search: true, label: 'DeepSeek Web default thinking mode with web search' },
  'deepseek-expert': { model_type: 'expert', reasoning: false, search: false, label: 'DeepSeek Web Expert mode (availability checked at runtime)' },
  'deepseek-v4-pro': { model_type: 'expert', reasoning: true, search: false, label: 'Compatibility alias; exact Web upstream model name is not guaranteed' },
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

function sendError(res, status, message, type = 'invalid_request_error') {
  send(res, status, { error: { message, type, code: status } });
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const parts = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) tooLarge = true;
      else if (!tooLarge) parts.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return reject(Object.assign(new Error('Request body exceeds limit'), { status: 413 }));
      try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function text(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(item => typeof item === 'string' ? item : item?.text || item?.content || '').join('\n');
}

function anthropicMessageText(message) {
  if (!Array.isArray(message.content)) return text(message.content);
  return message.content.map(block => {
    if (!block || typeof block !== 'object') return '';
    if (block.type === 'text' || block.type === 'thinking') return text(block.text || block.thinking);
    if (block.type === 'tool_use') return `TOOL_CALL: ${block.name}\narguments: ${JSON.stringify(block.input || {})}`;
    if (block.type === 'tool_result') return `[Tool Result ${block.tool_use_id || ''}]\n${text(block.content)}`;
    return '';
  }).filter(Boolean).join('\n');
}

function normalize(body, kind) {
  if (kind === 'anthropic') {
    return {
      model: body.model,
      stream: body.stream === true,
      tools: (body.tools || []).map(tool => ({ function: { name: tool.name, description: tool.description, parameters: tool.input_schema } })),
      prompt: [body.system && `System: ${text(body.system)}`, ...(body.messages || []).map(message => `${message.role}: ${anthropicMessageText(message)}`)].filter(Boolean).join('\n'),
    };
  }
  if (kind === 'responses') {
    return {
      model: body.model,
      stream: body.stream === true,
      tools: (body.tools || []).filter(tool => tool.type === 'function').map(tool => ({ function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
      prompt: text(body.input),
    };
  }
  return {
    model: body.model,
    stream: body.stream === true,
    tools: body.tools || [],
    prompt: (body.messages || []).map(message => `${message.role}: ${text(message.content)}`).join('\n'),
  };
}

function toOpenAI(model, prompt, output, toolCall, identity = {}) {
  const message = toolCall
    ? { role: 'assistant', content: null, tool_calls: [toolCall] }
    : { role: 'assistant', content: output.content || '', ...(output.reasoning ? { reasoning_content: output.reasoning } : {}) };
  const completionTokens = Math.ceil(((output.content || '') + (output.reasoning || '')).length / 4);
  const promptTokens = Math.ceil(prompt.length / 4);
  return {
    id: identity.id || `chatcmpl_${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: identity.created || Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: toolCall ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  };
}

function toAnthropic(openaiResponse, identity = {}) {
  const choice = openaiResponse.choices[0];
  const content = choice.message.tool_calls
    ? choice.message.tool_calls.map(call => ({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) }))
    : [{ type: 'text', text: choice.message.content || '' }];
  return {
    id: identity.id || `msg_${crypto.randomUUID()}`, type: 'message', role: 'assistant', model: openaiResponse.model,
    content,
    stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
    usage: {
      input_tokens: openaiResponse.usage.prompt_tokens,
      output_tokens: openaiResponse.usage.completion_tokens,
    },
  };
}

function toResponses(openaiResponse, identity = {}) {
  const message = openaiResponse.choices[0].message;
  const output = message.tool_calls
    ? message.tool_calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments }))
    : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: message.content || '' }] }];
  return {
    id: identity.id || `resp_${crypto.randomUUID()}`,
    object: 'response',
    status: 'completed',
    model: openaiResponse.model,
    output,
    usage: {
      input_tokens: openaiResponse.usage.prompt_tokens,
      output_tokens: openaiResponse.usage.completion_tokens,
      total_tokens: openaiResponse.usage.total_tokens,
      input_tokens_details: {},
      output_tokens_details: {},
    },
  };
}

function createProxyServer({ config = assertConfig(), completeImpl = complete, sessionStore } = {}) {
  const sessions = sessionStore || new SessionStore({ ttlMs: Number(process.env.SESSION_TTL_MS || 1_800_000) });

  const server = http.createServer(async (req, res) => {
    let stream = null;
    try {
      if (!cors(req, res, config.origins)) return sendError(res, 403, 'Origin is not allowed');
      if (req.method === 'OPTIONS') return res.writeHead(204).end();
      const url = new URL(req.url, 'http://localhost');
      if (!authorized(req, config.key, !isLoopback(config.host))) return sendError(res, 401, 'Invalid local proxy API key', 'authentication_error');

      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { status: 'ok', bind: config.host });
      if (req.method === 'GET' && url.pathname === '/readyz') {
        try { require('./client').loadAuth(); return send(res, 200, { ready: true }); }
        catch { return send(res, 503, { ready: false, action: 'Run npm run auth' }); }
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        return send(res, 200, { object: 'list', data: Object.keys(MODELS).map(id => ({ id, object: 'model', owned_by: 'deepseek-web' })) });
      }
      if (req.method === 'GET' && url.pathname === '/v1/model-capabilities') {
        return send(res, 200, Object.fromEntries(Object.entries(MODELS).map(([name, model]) => [name, { reasoning: model.reasoning, web_search: model.search, upstream: model.label }])));
      }
      if (req.method === 'GET' && url.pathname === '/v1/sessions') return send(res, 200, { data: sessions.list() });

      const body = req.method === 'POST' ? await readBody(req, config.maxBytes) : null;
      const agentKey = sessions.key(req.headers['x-agent-session'] || body?.metadata?.user_id || body?.user || 'default');
      if (req.method === 'POST' && url.pathname === '/reset-session') {
        sessions.reset(agentKey);
        return send(res, 200, { ok: true });
      }

      const paths = { '/v1/chat/completions': 'openai', '/v1/responses': 'responses', '/v1/messages': 'anthropic' };
      const kind = paths[url.pathname];
      if (req.method !== 'POST' || !kind) return sendError(res, 404, 'Not found');
      const input = normalize(body, kind);
      const modelName = String(input.model || 'deepseek-chat').toLowerCase();
      const model = MODELS[modelName];
      if (!model) return sendError(res, 400, 'Unsupported model. See GET /v1/models.');
      if (!input.prompt.trim()) return sendError(res, 400, 'A user input/message is required');

      const session = sessions.get(agentKey);
      const allowedTools = input.tools.map(tool => tool?.function?.name).filter(Boolean);
      const hasTools = allowedTools.length > 0;
      let streamIdentity = null;
      if (input.stream) {
        streamIdentity = {
          id: kind === 'anthropic' ? `msg_${crypto.randomUUID()}` : kind === 'responses' ? `resp_${crypto.randomUUID()}` : `chatcmpl_${crypto.randomUUID()}`,
          model: modelName,
          created: Math.floor(Date.now() / 1000),
        };
        stream = createProtocolStream(res, { kind, ...streamIdentity, bufferForTools: hasTools });
      }

      const output = await completeImpl({
        prompt: input.prompt + toolPrompt(input.tools),
        session,
        model,
        timeoutMs: config.timeoutMs,
        onDelta: input.stream ? delta => stream.delta(delta) : undefined,
      });
      const toolCall = parseToolCall(output.content, allowedTools);
      if (!toolCall) sessions.add(session, input.prompt, output.content);
      const openaiIdentity = streamIdentity && kind === 'openai' ? streamIdentity : {};
      const openaiResponse = toOpenAI(modelName, input.prompt, output, toolCall, openaiIdentity);
      const finalResponse = kind === 'anthropic'
        ? toAnthropic(openaiResponse, streamIdentity || {})
        : kind === 'responses' ? toResponses(openaiResponse, streamIdentity || {}) : openaiResponse;
      if (stream) return stream.finish({ output, toolCall, finalResponse });
      return send(res, 200, finalResponse);
    } catch (error) {
      if (stream) return stream.fail('DeepSeek streaming request failed. Run npm run doctor or re-authenticate.');
      const status = error.status || (error.name === 'TimeoutError' ? 504 : 502);
      const message = status >= 500 ? 'DeepSeek request failed. Run npm run doctor or re-authenticate.' : safeError(error);
      return sendError(res, status, message, status === 504 ? 'request_timeout' : 'upstream_error');
    }
  });

  server.requestTimeout = config.timeoutMs + 5_000;
  server.headersTimeout = 15_000;
  return server;
}

if (require.main === module) {
  const config = assertConfig();
  const server = createProxyServer({ config });
  server.listen(config.port, config.host, () => console.log(`DeepSeek Web local proxy: http://${config.host}:${config.port}`));
}

module.exports = { MODELS, createProxyServer, normalize, toAnthropic, toOpenAI, toResponses };
