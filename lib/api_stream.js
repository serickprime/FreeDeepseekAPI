'use strict';

function sse(res, event, data) {
  if (res.destroyed || res.writableEnded) return;
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function createProtocolStream(res, { kind, id, model, created, bufferForTools = false }) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders?.();

  let finished = false;
  let anthropicBlock = -1;
  let anthropicMode = null;
  let responseOutputIndex = 0;
  let responseReasoning = null;
  let responseMessage = null;

  if (kind === 'openai') {
    sse(res, null, {
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    });
  } else if (kind === 'anthropic') {
    sse(res, 'message_start', {
      type: 'message_start',
      message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    });
  } else {
    const response = { id, object: 'response', status: 'in_progress', model, output: [] };
    sse(res, 'response.created', { type: 'response.created', response });
    sse(res, 'response.in_progress', { type: 'response.in_progress', response });
  }

  function openAnthropicBlock(mode) {
    if (anthropicMode === mode) return;
    if (anthropicMode !== null) {
      if (anthropicMode === 'reasoning') sse(res, 'content_block_delta', { type: 'content_block_delta', index: anthropicBlock, delta: { type: 'text_delta', text: '\n[/reasoning]\n' } });
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: anthropicBlock });
    }
    anthropicBlock += 1;
    anthropicMode = mode;
    sse(res, 'content_block_start', { type: 'content_block_start', index: anthropicBlock, content_block: { type: 'text', text: '' } });
    if (mode === 'reasoning') sse(res, 'content_block_delta', { type: 'content_block_delta', index: anthropicBlock, delta: { type: 'text_delta', text: '[reasoning]\n' } });
  }

  function openResponseReasoning() {
    if (responseReasoning) return;
    responseReasoning = { id: `rs_${id}`, type: 'reasoning', status: 'in_progress', summary: [] };
    responseReasoning.index = responseOutputIndex++;
    sse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: responseReasoning.index, item: responseReasoning });
  }

  function openResponseMessage() {
    if (responseMessage) return;
    responseMessage = { id: `msg_${id}`, type: 'message', status: 'in_progress', role: 'assistant', content: [] };
    responseMessage.index = responseOutputIndex++;
    sse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: responseMessage.index, item: responseMessage });
    sse(res, 'response.content_part.added', { type: 'response.content_part.added', item_id: responseMessage.id, output_index: responseMessage.index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
  }

  function delta(fragment) {
    if (finished || bufferForTools) return;
    if (kind === 'openai') {
      const value = fragment.reasoning
        ? { reasoning_content: fragment.reasoning }
        : { content: fragment.content || '' };
      sse(res, null, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: value, finish_reason: null }] });
    } else if (kind === 'anthropic') {
      const mode = fragment.reasoning ? 'reasoning' : 'content';
      openAnthropicBlock(mode);
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: anthropicBlock, delta: { type: 'text_delta', text: fragment.reasoning || fragment.content || '' } });
    } else if (fragment.reasoning) {
      openResponseReasoning();
      sse(res, 'response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', item_id: responseReasoning.id, output_index: responseReasoning.index, summary_index: 0, delta: fragment.reasoning });
    } else {
      openResponseMessage();
      sse(res, 'response.output_text.delta', { type: 'response.output_text.delta', item_id: responseMessage.id, output_index: responseMessage.index, content_index: 0, delta: fragment.content || '' });
    }
  }

  function finish({ output, toolCall, finalResponse }) {
    if (finished) return;
    finished = true;

    if (bufferForTools && !toolCall) {
      if (output.reasoning) deltaBuffered({ reasoning: output.reasoning });
      if (output.content) deltaBuffered({ content: output.content });
    }

    if (kind === 'openai') {
      if (toolCall) {
        sse(res, null, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...toolCall }] }, finish_reason: null }] });
      }
      sse(res, null, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: toolCall ? 'tool_calls' : 'stop' }] });
      if (!res.destroyed && !res.writableEnded) res.write('data: [DONE]\n\n');
    } else if (kind === 'anthropic') {
      if (anthropicMode !== null) {
        if (anthropicMode === 'reasoning') sse(res, 'content_block_delta', { type: 'content_block_delta', index: anthropicBlock, delta: { type: 'text_delta', text: '\n[/reasoning]\n' } });
        sse(res, 'content_block_stop', { type: 'content_block_stop', index: anthropicBlock });
      }
      if (toolCall) {
        anthropicBlock += 1;
        sse(res, 'content_block_start', { type: 'content_block_start', index: anthropicBlock, content_block: { type: 'tool_use', id: toolCall.id, name: toolCall.function.name, input: {} } });
        sse(res, 'content_block_delta', { type: 'content_block_delta', index: anthropicBlock, delta: { type: 'input_json_delta', partial_json: toolCall.function.arguments } });
        sse(res, 'content_block_stop', { type: 'content_block_stop', index: anthropicBlock });
      }
      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: toolCall ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: finalResponse.usage });
      sse(res, 'message_stop', { type: 'message_stop' });
    } else {
      closeResponseItems(output);
      if (toolCall) {
        const item = { type: 'function_call', id: `fc_${id}`, call_id: toolCall.id, name: toolCall.function.name, arguments: toolCall.function.arguments, status: 'completed' };
        const index = responseOutputIndex++;
        sse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: index, item: { ...item, status: 'in_progress' } });
        sse(res, 'response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: index, delta: item.arguments });
        sse(res, 'response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: item.id, output_index: index, arguments: item.arguments });
        sse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: index, item });
      }
      sse(res, 'response.completed', { type: 'response.completed', response: finalResponse });
    }
    res.end();
  }

  function deltaBuffered(fragment) {
    const previous = finished;
    finished = false;
    const previousBuffer = bufferForTools;
    bufferForTools = false;
    delta(fragment);
    bufferForTools = previousBuffer;
    finished = previous;
  }

  function closeResponseItems(output) {
    if (responseReasoning) {
      const item = { id: responseReasoning.id, type: 'reasoning', status: 'completed', summary: output.reasoning ? [{ type: 'summary_text', text: output.reasoning }] : [] };
      sse(res, 'response.reasoning_summary_text.done', { type: 'response.reasoning_summary_text.done', item_id: item.id, output_index: responseReasoning.index, summary_index: 0, text: output.reasoning || '' });
      sse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: responseReasoning.index, item });
    }
    if (responseMessage) {
      const part = { type: 'output_text', text: output.content || '', annotations: [] };
      sse(res, 'response.output_text.done', { type: 'response.output_text.done', item_id: responseMessage.id, output_index: responseMessage.index, content_index: 0, text: part.text });
      sse(res, 'response.content_part.done', { type: 'response.content_part.done', item_id: responseMessage.id, output_index: responseMessage.index, content_index: 0, part });
      sse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: responseMessage.index, item: { id: responseMessage.id, type: 'message', status: 'completed', role: 'assistant', content: [part] } });
    }
  }

  function fail(message = 'Upstream streaming request failed') {
    if (finished) return;
    finished = true;
    if (kind === 'responses') sse(res, 'error', { type: 'error', error: { type: 'upstream_error', message } });
    else if (kind === 'anthropic') sse(res, 'error', { type: 'error', error: { type: 'api_error', message } });
    else sse(res, null, { error: { type: 'upstream_error', message } });
    res.end();
  }

  return { delta, fail, finish };
}

module.exports = { createProtocolStream };
