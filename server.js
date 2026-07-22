'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { assertConfig, cors, authorized, safeError, logSafeError, isLoopback } = require('./lib/security');
const { SessionStore } = require('./lib/session');
const { parseToolCallFromOutput, toolPrompt } = require('./lib/tool_parser');
const { createProtocolStream } = require('./lib/api_stream');
const { createSetupController } = require('./lib/setup');
const { MODELS } = require('./lib/models');
const { complete } = require('./client');

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

function sendError(res, status, message, type = 'invalid_request_error') {
  send(res, status, { error: { message, type, code: status } });
}

const STATIC_FILES = {
  '/setup': ['index.html', 'text/html; charset=utf-8'],
  '/setup/': ['index.html', 'text/html; charset=utf-8'],
  '/setup/app.js': ['app.js', 'application/javascript; charset=utf-8'],
  '/setup/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/setup/model-picker.css': ['model-picker.css', 'text/css; charset=utf-8'],
};

function serveSetupAsset(res, pathname) {
  const asset = STATIC_FILES[pathname];
  if (!asset) return false;
  const file = path.join(__dirname, 'public', asset[0]);
  res.writeHead(200, {
    'content-type': asset[1],
    'cache-control': asset[0] === 'index.html' ? 'no-store' : 'public, max-age=300',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
  });
  res.end(fs.readFileSync(file));
  return true;
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

function createProxyServer({ config = assertConfig(), completeImpl = complete, sessionStore, setupController, logger } = {}) {
  const sessions = sessionStore || new SessionStore({ ttlMs: Number(process.env.SESSION_TTL_MS || 1_800_000) });
  const setup = setupController || createSetupController();

  const server = http.createServer(async (req, res) => {
    let stream = null;
    try {
      if (!cors(req, res, config.origins)) return sendError(res, 403, 'Origin is not allowed');
      if (req.method === 'OPTIONS') return res.writeHead(204).end();
      const url = new URL(req.url, 'http://localhost');
      if (!authorized(req, config.key, !isLoopback(config.host))) return sendError(res, 401, 'Invalid local proxy API key', 'authentication_error');

      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(302, { location: '/setup', 'cache-control': 'no-store' });
        return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/favicon.ico') return res.writeHead(204, { 'cache-control': 'public, max-age=86400' }).end();
      if (req.method === 'GET' && serveSetupAsset(res, url.pathname)) return;
      if (req.method === 'GET' && url.pathname === '/api/setup/bootstrap') return send(res, 200, setup.bootstrap(), { 'cache-control': 'no-store' });
      if (req.method === 'GET' && url.pathname === '/api/setup/status') return send(res, 200, setup.status(), { 'cache-control': 'no-store' });
      if (req.method === 'POST' && url.pathname === '/api/setup/action') {
        if (!setup.authorized(req.headers['x-setup-token'])) return sendError(res, 403, 'Setup action token is invalid.', 'authentication_error');
        const setupBody = await readBody(req, Math.min(config.maxBytes, 16 * 1024));
        const result = await setup.action(setupBody.action, { model: setupBody.model, workingDirectory: setupBody.workingDirectory });
        return send(res, result.ok ? 200 : 400, result);
      }

      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { status: 'ok', bind: config.host });
      if (req.method === 'GET' && url.pathname === '/readyz') {
        try { require('./client').loadAuth(); return send(res, 200, { ready: true }); }
        catch { return send(res, 503, { ready: false, action: 'Run npm run auth' }); }
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        return send(res, 200, { object: 'list', data: Object.entries(MODELS).filter(([, model]) => model.available).map(([id]) => ({ id, object: 'model', owned_by: 'deepseek-web' })) });
      }
      if (req.method === 'GET' && url.pathname === '/v1/model-capabilities') {
        return send(res, 200, Object.fromEntries(Object.entries(MODELS).map(([name, model]) => [name, { available: model.available, reasoning: model.reasoning, web_search: model.search, upstream: model.label }])));
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
      if (!model.available) return sendError(res, 400, 'This DeepSeek Web mode is currently unavailable. See GET /v1/model-capabilities.');
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
      const toolCall = parseToolCallFromOutput(output, allowedTools);
      if (!toolCall) sessions.add(session, input.prompt, output.content);
      const openaiIdentity = streamIdentity && kind === 'openai' ? streamIdentity : {};
      const openaiResponse = toOpenAI(modelName, input.prompt, output, toolCall, openaiIdentity);
      const finalResponse = kind === 'anthropic'
        ? toAnthropic(openaiResponse, streamIdentity || {})
        : kind === 'responses' ? toResponses(openaiResponse, streamIdentity || {}) : openaiResponse;
      if (stream) return stream.finish({ output, toolCall, finalResponse });
      return send(res, 200, finalResponse);
    } catch (error) {
      logSafeError(error, logger);
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
