const base = process.env.PROXY_URL || 'http://127.0.0.1:9655';
const runId = Date.now().toString(36);

async function post(path, body, timeoutMs = 240_000) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-session': `live-${runId}-${path}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${text.slice(0, 300)}`);
  return { response, text };
}

function parseJson(text, label) {
  try { return JSON.parse(text); }
  catch { throw new Error(`${label}: invalid JSON response`); }
}

function parseOpenAIStream(text) {
  let content = '';
  let done = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') { done = true; continue; }
    if (!data) continue;
    const event = parseJson(data, 'OpenAI SSE event');
    content += event.choices?.[0]?.delta?.content || '';
  }
  return { content, done };
}

async function main() {
  const ready = await fetch(base + '/readyz');
  if (!ready.ok) throw new Error('Proxy is not ready: run npm run auth and npm start.');

  const normalMarker = `LIVE_OK_${runId}`;
  const normal = parseJson((await post('/v1/chat/completions', {
    model: 'deepseek-chat', messages: [{ role: 'user', content: `Reply exactly: ${normalMarker}` }], stream: false,
  })).text, 'chat completion');
  if (normal.choices?.[0]?.message?.content?.trim() !== normalMarker) throw new Error('Chat completion marker mismatch.');

  const streamMarker = `STREAM_OK_${runId}`;
  const streamed = parseOpenAIStream((await post('/v1/chat/completions', {
    model: 'deepseek-chat', messages: [{ role: 'user', content: `Reply exactly: ${streamMarker}` }], stream: true,
  })).text);
  if (!streamed.done || streamed.content.trim() !== streamMarker) throw new Error('OpenAI SSE content or terminator missing.');

  const reasonMarker = `REASON_OK_${runId}`;
  const reason = parseJson((await post('/v1/chat/completions', {
    model: 'deepseek-reasoner', messages: [{ role: 'user', content: `Think briefly, then answer exactly: ${reasonMarker}` }], stream: false,
  })).text, 'reasoning completion');
  if (!reason.choices?.[0]?.message?.content?.includes(reasonMarker)) throw new Error('Reasoning answer marker missing.');
  if (!reason.choices?.[0]?.message?.reasoning_content) throw new Error('reasoning_content missing.');

  const toolMarker = `TOOL_OK_${runId}`;
  const tool = parseJson((await post('/v1/chat/completions', {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: `Use echo with text ${toolMarker}. Return only the tool request.` }],
    tools: [{ type: 'function', function: { name: 'echo', description: 'Return supplied text', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } }],
    stream: false,
  })).text, 'tool completion');
  const call = tool.choices?.[0]?.message?.tool_calls?.[0];
  if (tool.choices?.[0]?.finish_reason !== 'tool_calls' || call?.function?.name !== 'echo') throw new Error('Validated tool call missing.');
  const args = parseJson(call.function.arguments, 'tool arguments');
  if (args.text !== toolMarker) throw new Error('Tool arguments marker mismatch.');

  const responsesMarker = `RESPONSES_OK_${runId}`;
  const responses = parseJson((await post('/v1/responses', { model: 'deepseek-chat', input: `Reply exactly: ${responsesMarker}`, stream: false })).text, 'Responses API');
  if (!responses.output?.[0]?.content?.[0]?.text?.includes(responsesMarker)) throw new Error('Responses API marker missing.');

  const anthropicMarker = `ANTHROPIC_OK_${runId}`;
  const anthropic = parseJson((await post('/v1/messages', {
    model: 'deepseek-chat', max_tokens: 64, messages: [{ role: 'user', content: `Reply exactly: ${anthropicMarker}` }], stream: false,
  })).text, 'Anthropic Messages');
  if (!anthropic.content?.[0]?.text?.includes(anthropicMarker)) throw new Error('Anthropic Messages marker missing.');

  const searchMarker = `SEARCH_OK_${runId}`;
  const search = parseJson((await post('/v1/chat/completions', {
    model: 'deepseek-chat-search', messages: [{ role: 'user', content: `Use web search and include this exact marker in the answer: ${searchMarker}` }], stream: false,
  })).text, 'search completion');
  if (!search.choices?.[0]?.message?.content?.includes(searchMarker)) throw new Error('Search-mode marker missing.');

  console.log('✓ auth/session, normal response, OpenAI SSE, reasoning, tool call, Responses, Anthropic and search passed');
}

main().catch(error => {
  console.error(`Live smoke failed: ${error.message}`);
  process.exitCode = 1;
});
