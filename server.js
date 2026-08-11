'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { assertConfig, cors, authorized, safeError, logSafeError, isLoopback } = require('./lib/security');
const { SessionStore } = require('./lib/session');
const { SessionResolver } = require('./lib/session_resolver');
const { inspectToolCallFromOutput, toolPrompt } = require('./lib/tool_parser');
const {
  createFencedToolRetryPrompt,
  createToolRetryPrompt,
  fencedToolFailure,
  hideRetryReasoning,
  logFencedToolRetry,
  logPrefixedToolRetry,
  logToolRetry,
  prefixedToolFailure,
  shouldRetryFencedToolResponse,
  shouldRetryPrefixedToolResponse,
  shouldRetryToolResponse,
} = require('./lib/tool_retry');
const {
  createRepeatedToolCorrectionPrompt,
  createToolContinuationPrompt,
  extractToolResults,
  isExactCompletedToolCall,
  logRepeatedToolRetry,
  repeatedToolFailure,
} = require('./lib/tool_continuation');
const { createProtocolStream } = require('./lib/api_stream');
const { createToolDiagnostics } = require('./lib/tool_diagnostics');
const { estimateTokenCount, validateCountTokensBody } = require('./lib/token_count');
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

function sendAnthropicError(res, status, message, type = 'invalid_request_error') {
  send(res, status, { type: 'error', error: { type, message } });
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

function structuredText(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value ?? {}); } catch { return '{}'; }
}

function sessionToolName(session, callId) {
  if (typeof callId !== 'string' || !(session?.toolCalls instanceof Map)) return '';
  const stored = session.toolCalls.get(callId);
  return typeof stored === 'string' ? stored : stored?.name || '';
}

function rememberToolCall(session, toolCall) {
  const id = toolCall?.id;
  const name = toolCall?.function?.name;
  if (typeof id !== 'string' || typeof name !== 'string') return;
  if (!(session.toolCalls instanceof Map)) session.toolCalls = new Map();
  session.toolCalls.set(id, { name, arguments: toolCall.function.arguments });
  while (session.toolCalls.size > 32) session.toolCalls.delete(session.toolCalls.keys().next().value);
}

function forgetCompletedToolCalls(session, callIds) {
  if (!(session?.toolCalls instanceof Map)) return;
  for (const callId of Array.isArray(callIds) ? callIds : []) session.toolCalls.delete(callId);
}

function toolCallText(name, callId, argumentsValue) {
  return `[Tool Call]\nname: ${name || 'unknown'}\ncall_id: ${callId || 'unknown'}\narguments: ${structuredText(argumentsValue)}`;
}

function toolResultText(name, callId, result) {
  return `[Tool Result]\nname: ${name || 'unknown'}\ncall_id: ${callId || 'unknown'}\nresult:\n${typeof result === 'string' ? result : structuredText(result)}`;
}

function openAIMessageText(message, session) {
  const role = String(message?.role || 'user');
  if (role === 'tool') {
    const callId = message.tool_call_id || '';
    return `${role}: ${toolResultText(message.name || sessionToolName(session, callId), callId, text(message.content))}`;
  }
  const parts = [];
  const content = text(message?.content);
  if (content) parts.push(`${role}: ${content}`);
  for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
    const callId = call?.id || '';
    parts.push(`${role}: ${toolCallText(call?.function?.name || sessionToolName(session, callId), callId, call?.function?.arguments)}`);
  }
  return parts.join('\n');
}

function anthropicMessageText(message, session) {
  if (!Array.isArray(message.content)) return text(message.content);
  return message.content.map(block => {
    if (!block || typeof block !== 'object') return '';
    if (block.type === 'text' || block.type === 'thinking') return text(block.text || block.thinking);
    if (block.type === 'tool_use') return toolCallText(block.name, block.id, block.input);
    if (block.type === 'tool_result') return toolResultText(sessionToolName(session, block.tool_use_id), block.tool_use_id, text(block.content));
    return '';
  }).filter(Boolean).join('\n');
}

function responsesInputText(input, session) {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  const names = new Map(session?.toolCalls instanceof Map ? session.toolCalls : []);
  for (const item of input) {
    if (item?.type === 'function_call' && typeof (item.call_id || item.id) === 'string' && typeof item.name === 'string') names.set(item.call_id || item.id, item.name);
  }
  return input.map(item => {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return '';
    if (item.type === 'function_call') return toolCallText(item.name, item.call_id || item.id, item.arguments);
    if (item.type === 'function_call_output') return toolResultText(item.name || names.get(item.call_id) || '', item.call_id, item.output);
    if (item.type === 'message') return `${item.role || 'user'}: ${text(item.content)}`;
    if (item.type === 'input_text' || item.type === 'output_text') return item.text || '';
    return text(item.content || item.text);
  }).filter(Boolean).join('\n');
}

function normalize(body, kind, session) {
  if (kind === 'anthropic') {
    return {
      model: body.model,
      stream: body.stream === true,
      tools: (body.tools || []).map(tool => ({ function: { name: tool.name, description: tool.description, parameters: tool.input_schema } })),
      prompt: [body.system && `System: ${text(body.system)}`, ...(body.messages || []).map(message => `${message.role}: ${anthropicMessageText(message, session)}`)].filter(Boolean).join('\n'),
    };
  }
  if (kind === 'responses') {
    return {
      model: body.model,
      stream: body.stream === true,
      tools: (body.tools || []).filter(tool => tool.type === 'function').map(tool => ({ function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
      prompt: responsesInputText(body.input, session),
    };
  }
  return {
    model: body.model,
    stream: body.stream === true,
    tools: body.tools || [],
    prompt: (body.messages || []).map(message => openAIMessageText(message, session)).filter(Boolean).join('\n'),
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

function createProxyServer({ config = assertConfig(), completeImpl = complete, sessionStore, sessionResolver, setupController, logger } = {}) {
  const sessions = sessionStore || new SessionStore({ ttlMs: Number(process.env.SESSION_TTL_MS || 1_800_000) });
  const resolver = sessionResolver || new SessionResolver();
  const setup = setupController || createSetupController();
  const toolDiagnostics = createToolDiagnostics({ logger });

  const server = http.createServer(async (req, res) => {
    let stream = null;
    let requestPath = '';
    let diagnosticResponse = null;
    let latestUpstream = { stage: 'unknown', attempt: 1, maxAttempts: 1 };
    let reasoningRetryAttempted = false;
    let fencedToolRetryAttempted = false;
    let prefixedToolRetryAttempted = false;
    let repeatedToolRetryAttempted = false;
    let toolRetryReason = 'none';
    try {
      const url = new URL(req.url, 'http://localhost');
      requestPath = url.pathname;
      const countTokensRequest = requestPath === '/v1/messages/count_tokens';
      if (!cors(req, res, config.origins)) return countTokensRequest
        ? sendAnthropicError(res, 403, 'Origin is not allowed', 'permission_error')
        : sendError(res, 403, 'Origin is not allowed');
      if (req.method === 'OPTIONS') return res.writeHead(204).end();
      if (!authorized(req, config.key, !isLoopback(config.host))) return countTokensRequest
        ? sendAnthropicError(res, 401, 'Invalid local proxy API key', 'authentication_error')
        : sendError(res, 401, 'Invalid local proxy API key', 'authentication_error');

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
      if (url.pathname === '/v1/messages/count_tokens' && req.method !== 'POST') {
        return sendAnthropicError(res, 405, 'Only POST is supported for this endpoint.');
      }

      const body = req.method === 'POST' ? await readBody(req, config.maxBytes) : null;
      if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
        const validationError = validateCountTokensBody(body);
        if (validationError) return sendAnthropicError(res, 400, validationError);
        return send(res, 200, { input_tokens: estimateTokenCount(body) }, { 'x-deepseek-bridge-token-count': 'estimate' });
      }
      if (req.method === 'POST' && url.pathname === '/reset-session') {
        const resolution = resolver.resolve({ headers: req.headers, body });
        sessions.reset(resolution.upstreamKey);
        resolver.releaseSession(resolution.upstreamKey);
        return send(res, 200, { ok: true });
      }

      const paths = { '/v1/chat/completions': 'openai', '/v1/responses': 'responses', '/v1/messages': 'anthropic' };
      const kind = paths[url.pathname];
      if (req.method !== 'POST' || !kind) return sendError(res, 404, 'Not found');
      const requestRef = toolDiagnostics.createRequestRef();
      const resolution = resolver.resolve({ headers: req.headers, body, kind });
      const upstreamKey = resolution.upstreamKey;
      const session = sessions.get(upstreamKey);
      const toolResults = extractToolResults(body, kind, session).filter(result => result.known);
      const isToolContinuation = toolResults.length > 0;
      diagnosticResponse = toolDiagnostics.request({
        protocol: kind,
        route: url.pathname,
        body,
        upstreamSource: resolution.upstreamSource,
        upstreamKey,
        clientSessionSource: resolution.clientSource,
        clientSessionKey: resolution.clientKey,
        isToolContinuation,
        toolResultCount: toolResults.length,
        toolResultErrorCount: kind === 'anthropic'
          ? toolResults.filter(result => result.isError === true).length
          : 0,
        requestRef,
      });
      const onUpstreamStage = (stage, metadata = {}) => {
        latestUpstream = {
          stage,
          attempt: metadata.attempt,
          maxAttempts: metadata.maxAttempts,
        };
        diagnosticResponse?.stage(stage);
      };
      const onUpstreamError = (error, metadata = {}) => {
        latestUpstream = {
          stage: metadata.stage,
          attempt: metadata.attempt,
          maxAttempts: metadata.maxAttempts,
        };
        diagnosticResponse?.upstreamError(error, latestUpstream);
      };
      const input = normalize(body, kind, session);
      const modelName = String(input.model || 'deepseek-chat').toLowerCase();
      const model = MODELS[modelName];
      if (!model) {
        diagnosticResponse?.response({ outcome: 'safe_failure' });
        return sendError(res, 400, 'Unsupported model. See GET /v1/models.');
      }
      if (!model.available) {
        diagnosticResponse?.response({ outcome: 'safe_failure' });
        return sendError(res, 400, 'This DeepSeek Web mode is currently unavailable. See GET /v1/model-capabilities.');
      }
      if (!input.prompt.trim()) {
        diagnosticResponse?.response({ outcome: 'safe_failure' });
        return sendError(res, 400, 'A user input/message is required');
      }

      const allowedTools = input.tools.map(tool => tool?.function?.name).filter(Boolean);
      const hasTools = allowedTools.length > 0;
      const upstreamPrompt = isToolContinuation
        ? createToolContinuationPrompt(toolResults, input.tools)
        : input.prompt + toolPrompt(input.tools);
      let streamIdentity = null;
      if (input.stream) {
        streamIdentity = {
          id: kind === 'anthropic' ? `msg_${crypto.randomUUID()}` : kind === 'responses' ? `resp_${crypto.randomUUID()}` : `chatcmpl_${crypto.randomUUID()}`,
          model: modelName,
          created: Math.floor(Date.now() / 1000),
        };
        stream = createProtocolStream(res, { kind, ...streamIdentity, bufferForTools: hasTools });
      }

      let output = await completeImpl({
        prompt: upstreamPrompt,
        session,
        model,
        timeoutMs: config.timeoutMs,
        onDelta: input.stream ? delta => stream.delta(delta) : undefined,
        onStage: onUpstreamStage,
        onError: onUpstreamError,
      });
      let toolParseResult = inspectToolCallFromOutput(output, allowedTools);
      let toolCall = toolParseResult.toolCall;
      let correctiveAttempted = false;
      let safeFailure = false;
      if (shouldRetryFencedToolResponse({ hasTools, toolCall, retryCount: 0, inspection: toolParseResult })) {
        correctiveAttempted = true;
        fencedToolRetryAttempted = true;
        toolRetryReason = 'code_fence';
        logFencedToolRetry(logger);
        output = await completeImpl({
          prompt: createFencedToolRetryPrompt(allowedTools),
          session,
          model: MODELS['deepseek-chat'],
          timeoutMs: config.timeoutMs,
          onDelta: input.stream ? delta => stream.delta(delta) : undefined,
          onStage: onUpstreamStage,
          onError: onUpstreamError,
        });
        toolParseResult = inspectToolCallFromOutput(output, allowedTools);
        toolCall = toolParseResult.toolCall;
        if (!toolCall) {
          safeFailure = true;
          output = fencedToolFailure(output);
        }
      }
      if (shouldRetryPrefixedToolResponse({
        hasTools,
        toolCall,
        retryCount: correctiveAttempted ? 1 : 0,
        inspection: toolParseResult,
      })) {
        correctiveAttempted = true;
        prefixedToolRetryAttempted = true;
        toolRetryReason = 'prefixed_tool';
        logPrefixedToolRetry(logger);
        output = await completeImpl({
          prompt: createFencedToolRetryPrompt(allowedTools),
          session,
          model: MODELS['deepseek-chat'],
          timeoutMs: config.timeoutMs,
          onDelta: input.stream ? delta => stream.delta(delta) : undefined,
          onStage: onUpstreamStage,
          onError: onUpstreamError,
        });
        toolParseResult = inspectToolCallFromOutput(output, allowedTools);
        toolCall = toolParseResult.toolCall;
        if (!toolCall) {
          safeFailure = true;
          output = prefixedToolFailure(output);
        }
      }
      if (!correctiveAttempted && shouldRetryToolResponse({ hasTools, output, toolCall, retryCount: 0 })) {
        correctiveAttempted = true;
        reasoningRetryAttempted = true;
        toolRetryReason = 'reasoning_only';
        logToolRetry(logger);
        output = await completeImpl({
          prompt: createToolRetryPrompt(allowedTools),
          session,
          model: MODELS['deepseek-chat'],
          timeoutMs: config.timeoutMs,
          onDelta: input.stream ? delta => stream.delta(delta) : undefined,
          onStage: onUpstreamStage,
          onError: onUpstreamError,
        });
        toolParseResult = inspectToolCallFromOutput(output, allowedTools);
        toolCall = toolParseResult.toolCall;
        safeFailure = !toolCall && !String(output?.content || '').trim();
        output = hideRetryReasoning(output, toolCall);
      }
      if (isToolContinuation && isExactCompletedToolCall(toolCall, toolResults)) {
        if (!correctiveAttempted) {
          correctiveAttempted = true;
          repeatedToolRetryAttempted = true;
          toolRetryReason = 'repeated_tool';
          logRepeatedToolRetry(logger);
          output = await completeImpl({
            prompt: createRepeatedToolCorrectionPrompt(toolResults, input.tools),
            session,
            model: MODELS['deepseek-chat'],
            timeoutMs: config.timeoutMs,
            onDelta: input.stream ? delta => stream.delta(delta) : undefined,
            onStage: onUpstreamStage,
            onError: onUpstreamError,
          });
          toolParseResult = inspectToolCallFromOutput(output, allowedTools);
          toolCall = toolParseResult.toolCall;
          if (!toolCall) output = { ...output, reasoning: '' };
        }
        if (isExactCompletedToolCall(toolCall, toolResults)
          || (!toolCall && !String(output?.content || '').trim())) {
          safeFailure = true;
          output = repeatedToolFailure(output);
          toolCall = null;
        }
      }
      if (isToolContinuation && !toolCall && output.reasoning) output = { ...output, reasoning: '' };
      resolver.release(resolution.callIds, upstreamKey);
      forgetCompletedToolCalls(session, resolution.callIds);
      if (toolCall) {
        rememberToolCall(session, toolCall);
        resolver.bind(toolCall.id, upstreamKey);
      }
      if (!toolCall) sessions.add(session, upstreamPrompt, output.content);
      const openaiIdentity = streamIdentity && kind === 'openai' ? streamIdentity : {};
      const openaiResponse = toOpenAI(modelName, upstreamPrompt, output, toolCall, openaiIdentity);
      const finalResponse = kind === 'anthropic'
        ? toAnthropic(openaiResponse, streamIdentity || {})
        : kind === 'responses' ? toResponses(openaiResponse, streamIdentity || {}) : openaiResponse;
      diagnosticResponse?.response({
        strictToolCallDetected: Boolean(toolCall),
        selectedToolName: toolCall?.function?.name,
        reasoningNonempty: Boolean(String(output?.reasoning || '').trim()),
        contentNonempty: Boolean(String(output?.content || '').trim()),
        reasoningRetryAttempted,
        fencedToolRetryAttempted,
        prefixedToolRetryAttempted,
        repeatedToolRetryAttempted,
        toolRetryReason,
        toolParseResult,
        outcome: toolCall ? 'tool_call' : safeFailure || !String(output?.content || '').trim() ? 'safe_failure' : 'final_text',
      });
      if (stream) return stream.finish({ output, toolCall, finalResponse });
      return send(res, 200, finalResponse);
    } catch (error) {
      diagnosticResponse?.upstreamError(error, latestUpstream);
      diagnosticResponse?.response({ reasoningRetryAttempted, fencedToolRetryAttempted, prefixedToolRetryAttempted, repeatedToolRetryAttempted, toolRetryReason, outcome: 'upstream_error' });
      logSafeError(error, logger);
      if (stream) return stream.fail('DeepSeek streaming request failed. Run npm run doctor or re-authenticate.');
      const status = error.status || (error.name === 'TimeoutError' ? 504 : 502);
      if (requestPath === '/v1/messages/count_tokens') {
        const type = status === 413 ? 'request_too_large' : status === 400 ? 'invalid_request_error' : 'api_error';
        return sendAnthropicError(res, status, status >= 500 ? 'Local token estimation failed.' : safeError(error), type);
      }
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
