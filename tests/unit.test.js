'use strict';
const test=require('node:test'),assert=require('node:assert/strict'); const {isLoopback,isLocalOrigin,assertConfig,safeError}=require('../lib/security'); const {SessionStore}=require('../lib/session'); const {parseToolCall,toolPrompt}=require('../lib/tool_parser'); const { complete, parseRetryAfter, parseStream }=require('../client'); const {createProxyServer,toAnthropic,toOpenAI,toResponses}=require('../server');
const {createSetupController}=require('../lib/setup');
test('loopback and external bind security',()=>{assert.equal(isLoopback('127.0.0.1'),true);assert.equal(isLoopback('0.0.0.0'),false);assert.throws(()=>assertConfig({HOST:'0.0.0.0'}));assert.equal(assertConfig({HOST:'0.0.0.0',PROXY_API_KEY:'x'.repeat(24)}).host,'0.0.0.0');});
test('localhost browser origins allow explicit ports but reject deceptive hosts',()=>{assert.equal(isLocalOrigin('http://127.0.0.1:9655'),true);assert.equal(isLocalOrigin('http://localhost:3000'),true);assert.equal(isLocalOrigin('https://localhost.evil.example'),false);});
test('error redaction hides credentials',()=>{assert.doesNotMatch(safeError(new Error('Bearer abcdefghijkl token=secret')),/secret|abcdefgh/);});
test('session expiry/reset and bounded history',()=>{const s=new SessionStore({ttlMs:1,maxHistory:2});const x=s.get('a');s.add(x,'one','a');s.add(x,'two','b');s.add(x,'three','c');assert.equal(x.history.length,2);s.reset('a');assert.equal(s.list().length,0);});
test('only explicit complete tool call is accepted',()=>{const c=parseToolCall('<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>',['read_file']);assert.equal(c.function.name,'read_file');assert.equal(parseToolCall('{"name":"read_file","arguments":{}}',['read_file']),null);assert.equal(parseToolCall('<tool_call>{"name":"other","arguments":{}}</tool_call>',['read_file']),null);assert.equal(parseToolCall('<tool_call>{"name":"read_file","arguments":</tool_call>',['read_file']),null);});
test('strict JSON tool envelope is accepted only as the whole response',()=>{const c=parseToolCall('{"tool_call":{"name":"read_file","arguments":{"path":"a"}}}',['read_file']);assert.equal(c.function.name,'read_file');assert.equal(parseToolCall('Example: {"tool_call":{"name":"read_file","arguments":{}}}',['read_file']),null);});
test('tool prompt is declarative and bounded',()=>{const p=toolPrompt([{function:{name:'x',parameters:{type:'object'}}}]);assert.match(p,/Never execute/);assert.match(p,/"x"/);});

test('Retry-After supports seconds and HTTP dates',()=>{
  assert.equal(parseRetryAfter('2'),2000);
  assert.equal(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT',Date.parse('Wed, 21 Oct 2015 07:27:58 GMT')),2000);
  assert.equal(parseRetryAfter('broken'),0);
});

test('DeepSeek stream parser keeps content, reasoning and final unterminated line',async()=>{
  const deltas=[];
  const stream=new ReadableStream({start(controller){
    controller.enqueue(new TextEncoder().encode('data: {"p":"response/reasoning_content","v":"why"}\r\n'));
    controller.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"hel"}\n'));
    controller.enqueue(new TextEncoder().encode('data: {"v":"lo"}'));
    controller.close();
  }});
  const result=await parseStream(stream,delta=>deltas.push(delta));
  assert.deepEqual(result,{content:'hello',reasoning:'why',parentMessageId:null});
  assert.deepEqual(deltas,[{reasoning:'why'},{content:'hel'},{content:'lo'}]);
});

test('DeepSeek stream parser applies fragment append patches used by the live Web API',async()=>{
  const source=[
    'data: {"p":"response/fragments","v":{"type":"RESPONSE","content":"CHECK"}}\n',
    'data: {"p":"response/fragments/-1/content","v":"_4826"}\n',
    'data: {"p":"response/fragments","v":{"type":"THINK","content":"because"}}\n',
    'data: {"p":"response/fragments/-1/content","v":"..."}\n',
    'data: {"response_message_id":"message-1"}\n',
  ];
  const deltas=[];
  const stream=new ReadableStream({start(controller){for(const line of source)controller.enqueue(new TextEncoder().encode(line));controller.close();}});
  const result=await parseStream(stream,delta=>deltas.push(delta));
  assert.deepEqual(result,{content:'CHECK_4826',reasoning:'because...',parentMessageId:'message-1'});
  assert.deepEqual(deltas,[{content:'CHECK'},{content:'_4826'},{reasoning:'because'},{reasoning:'...'}]);
});

test('completion honors Retry-After, resets remote session and retries only a bounded number',async()=>{
  const calls=[]; const waits=[];
  const responses=[
    new Response(JSON.stringify({data:{biz_data:{id:'session-1'}}}),{status:200,headers:{'content-type':'application/json'}}),
    new Response(JSON.stringify({data:{biz_data:{challenge:{challenge:'c',salt:'s',expire_at:1,difficulty:1,algorithm:'a',signature:'sig'}}}}),{status:200}),
    new Response('limited',{status:429,headers:{'retry-after':'2'}}),
    new Response(JSON.stringify({data:{biz_data:{id:'session-2'}}}),{status:200}),
    new Response(JSON.stringify({data:{biz_data:{challenge:{challenge:'c2',salt:'s2',expire_at:2,difficulty:1,algorithm:'a',signature:'sig2'}}}}),{status:200}),
    new Response('data: {"p":"response/content","v":"ok"}\n',{status:200,headers:{'content-type':'text/event-stream'}}),
  ];
  const session={id:null,parentMessageId:null,history:[]};
  const result=await complete({prompt:'test',session,model:{model_type:'default',reasoning:false,search:false},auth:{token:'test-token',cookie:'test-cookie',wasmUrl:'test-wasm'},fetchImpl:async(url)=>{calls.push(url);return responses.shift();},solvePow:async()=>1,sleep:async(ms)=>waits.push(ms)});
  assert.equal(result.content,'ok');
  assert.equal(session.id,'session-2');
  assert.equal(calls.length,6);
  assert.deepEqual(waits,[2000]);
});

async function streamingProtocolCase(path, body, expectedParts) {
  let releaseUpstream;
  let upstreamFinished=false;
  const config={host:'127.0.0.1',port:0,key:'',maxBytes:1024*1024,timeoutMs:5000,origins:new Set(['http://localhost'])};
  const server=createProxyServer({config,completeImpl:async({onDelta})=>{
    onDelta({reasoning:'why'});
    onDelta({content:'hello'});
    await new Promise(resolve=>{releaseUpstream=resolve;});
    upstreamFinished=true;
    return {reasoning:'why',content:'hello',parentMessageId:'parent'};
  }});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const port=server.address().port;
    const response=await fetch(`http://127.0.0.1:${port}${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,stream:true})});
    assert.equal(response.status,200);
    assert.match(response.headers.get('content-type'),/^text\/event-stream/);
    const reader=response.body.getReader();
    const first=await reader.read();
    assert.equal(upstreamFinished,false,'headers/first SSE event must arrive before upstream completion');
    while(!releaseUpstream) await new Promise(resolve=>setImmediate(resolve));
    releaseUpstream();
    let output=new TextDecoder().decode(first.value||new Uint8Array());
    for(;;){const part=await reader.read();if(part.done)break;output+=new TextDecoder().decode(part.value);}
    for(const expected of expectedParts) assert.match(output,expected);
  } finally {
    releaseUpstream?.();
    server.closeAllConnections?.();
    await new Promise(resolve=>server.close(resolve));
  }
}

test('OpenAI SSE forwards deltas before upstream completion',()=>streamingProtocolCase(
  '/v1/chat/completions',
  {model:'deepseek-chat',messages:[{role:'user',content:'test'}]},
  [/"reasoning_content":"why"/,/"content":"hello"/,/data: \[DONE\]/]
));

test('Responses SSE uses incremental reasoning and output-text events',()=>streamingProtocolCase(
  '/v1/responses',
  {model:'deepseek-chat',input:'test'},
  [/event: response\.reasoning_summary_text\.delta/,/event: response\.output_text\.delta/,/event: response\.completed/]
));

test('Anthropic SSE uses message and content block lifecycle events',()=>streamingProtocolCase(
  '/v1/messages',
  {model:'deepseek-chat',max_tokens:64,messages:[{role:'user',content:'test'}]},
  [/event: message_start/,/event: content_block_delta/,/event: content_block_stop/,/event: message_stop/]
));

test('streaming with tools buffers markup and emits a validated tool call',async()=>{
  const config={host:'127.0.0.1',port:0,key:'',maxBytes:1024*1024,timeoutMs:5000,origins:new Set()};
  const server=createProxyServer({config,completeImpl:async({onDelta})=>{
    const content='<tool_call>{"name":"echo","arguments":{"text":"ok"}}</tool_call>';
    onDelta({content});
    return {content,reasoning:'',parentMessageId:null};
  }});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'deepseek-chat',stream:true,messages:[{role:'user',content:'use tool'}],tools:[{type:'function',function:{name:'echo',parameters:{type:'object'}}}]})});
    const output=await response.text();
    assert.doesNotMatch(output,/<tool_call>/);
    assert.match(output,/"tool_calls"/);
    assert.match(output,/"finish_reason":"tool_calls"/);
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve=>server.close(resolve));
  }
});

test('protocol adapters expose protocol-specific usage fields',()=>{
  const openai=toOpenAI('deepseek-chat','1234',{content:'12345678',reasoning:''},null,{id:'chatcmpl_test',created:1});
  assert.deepEqual(openai.usage,{prompt_tokens:1,completion_tokens:2,total_tokens:3});
  const anthropic=toAnthropic(openai,{id:'msg_test'});
  assert.deepEqual(anthropic.usage,{input_tokens:1,output_tokens:2});
  const responses=toResponses(openai,{id:'resp_test'});
  assert.equal(responses.usage.input_tokens,1);
  assert.equal(responses.usage.output_tokens,2);
  assert.equal(responses.usage.total_tokens,3);
});

test('setup UI is served with CSP and actions require the in-memory setup token',async()=>{
  const config={host:'127.0.0.1',port:0,key:'',maxBytes:1024*1024,timeoutMs:5000,origins:new Set()};
  const setupController={
    bootstrap:()=>({token:'setup-test-token',status:{auth:{valid:true}}}),
    status:()=>({auth:{valid:true}}),
    authorized:value=>value==='setup-test-token',
    action:async name=>({ok:name==='doctor',message:'checked'}),
  };
  const server=createProxyServer({config,setupController,completeImpl:async()=>({content:'',reasoning:''})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const base=`http://127.0.0.1:${server.address().port}`;
    const page=await fetch(base+'/setup');
    assert.equal(page.status,200);
    assert.match(page.headers.get('content-security-policy'),/default-src 'self'/);
    assert.match(await page.text(),/DeepSeek Bridge/);
    const denied=await fetch(base+'/api/setup/action',{method:'POST',headers:{'content-type':'application/json'},body:'{"action":"doctor"}'});
    assert.equal(denied.status,403);
    const allowed=await fetch(base+'/api/setup/action',{method:'POST',headers:{'content-type':'application/json','x-setup-token':'setup-test-token'},body:'{"action":"doctor"}'});
    assert.equal(allowed.status,200);
    assert.equal((await allowed.json()).ok,true);
  }finally{
    server.closeAllConnections?.();
    await new Promise(resolve=>server.close(resolve));
  }
});

test('setup controller confirms a launch only after the terminal launcher succeeds',async()=>{
  const calls=[];
  const controller=createSetupController({
    root:process.cwd(),
    launchTerminal:async(root,command)=>{calls.push({root,command});return 4321;},
  });
  const result=await controller.action('auth');
  assert.equal(result.ok,true);
  assert.equal(result.pid,4321);
  assert.equal(calls.length,1);
  assert.match(calls[0].command,/npm\.cmd run auth/);

  const failing=createSetupController({root:process.cwd(),launchTerminal:async()=>{throw new Error('launch failed');}});
  await assert.rejects(failing.action('auth'),/launch failed/);
});
