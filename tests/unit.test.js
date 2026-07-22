'use strict';
const test=require('node:test'),assert=require('node:assert/strict'); const {isLoopback,isLocalOrigin,assertConfig,safeError,logSafeError}=require('../lib/security'); const {SessionStore}=require('../lib/session'); const {MAX_TOOL_BYTES,MAX_NESTING_DEPTH,parseToolCall,parseToolCallFromOutput,toolPrompt}=require('../lib/tool_parser'); const { complete, parseRetryAfter, parseStream }=require('../client'); const {createProxyServer,toAnthropic,toOpenAI,toResponses}=require('../server');
const {TOOL_RETRY_FAILURE_MESSAGE,createToolRetryPrompt,hideRetryReasoning,shouldRetryToolResponse}=require('../lib/tool_retry');
const {DOCTOR_PROCESS_TIMEOUT_MS,createSetupController,existingDirectory}=require('../lib/setup');
const {runDiagnostics,boundedTimeout}=require('../scripts/doctor');
test('loopback and external bind security',()=>{assert.equal(isLoopback('127.0.0.1'),true);assert.equal(isLoopback('0.0.0.0'),false);assert.throws(()=>assertConfig({HOST:'0.0.0.0'}));assert.equal(assertConfig({HOST:'0.0.0.0',PROXY_API_KEY:'x'.repeat(24)}).host,'0.0.0.0');});
test('localhost browser origins allow explicit ports but reject deceptive hosts',()=>{assert.equal(isLocalOrigin('http://127.0.0.1:9655'),true);assert.equal(isLocalOrigin('http://localhost:3000'),true);assert.equal(isLocalOrigin('https://localhost.evil.example'),false);});
test('error redaction hides credentials but keeps a useful reason',()=>{
  const message=safeError(new Error('Gateway unavailable: Bearer bearer-secret token=token-secret cookie=session-secret authorization=auth-secret'));
  assert.match(message,/Gateway unavailable/);
  assert.doesNotMatch(message,/bearer-secret|token-secret|session-secret|auth-secret/);
});
test('safe error logging never throws for unusual errors or logger failures',()=>{
  const unusual={get message(){throw new Error('message getter failed');},toString(){throw new Error('toString failed');}};
  assert.doesNotThrow(()=>logSafeError(unusual,()=>{throw new Error('logger failed');}));
  assert.equal(safeError(unusual),'Internal error');
});
test('session expiry/reset and bounded history',()=>{const s=new SessionStore({ttlMs:1,maxHistory:2});const x=s.get('a');s.add(x,'one','a');s.add(x,'two','b');s.add(x,'three','c');assert.equal(x.history.length,2);s.reset('a');assert.equal(s.list().length,0);});
const jsonToolCall=(name='read_file',args={path:'package.json'})=>JSON.stringify({tool_call:{name,arguments:args}});
const xmlToolCall=(name='read_file',args={path:'package.json'})=>`<tool_call>${JSON.stringify({name,arguments:args})}</tool_call>`;

test('strict JSON and XML tool calls are accepted only as the whole content',()=>{
  for(const source of [jsonToolCall(),xmlToolCall()]){
    const call=parseToolCall(source,['read_file']);
    assert.equal(call.function.name,'read_file');
    assert.deepEqual(JSON.parse(call.function.arguments),{path:'package.json'});
  }
});

test('strict reasoning tool calls require empty content and preserve content priority',()=>{
  assert.equal(parseToolCallFromOutput({content:'',reasoning:jsonToolCall()},['read_file']).function.name,'read_file');
  assert.equal(parseToolCallFromOutput({content:'   ',reasoning:xmlToolCall()},['read_file']).function.name,'read_file');
  const selected=parseToolCallFromOutput({content:jsonToolCall('content_tool',{}),reasoning:jsonToolCall('reasoning_tool',{})},['content_tool','reasoning_tool']);
  assert.equal(selected.function.name,'content_tool');
  assert.equal(parseToolCallFromOutput({content:'A normal final answer',reasoning:jsonToolCall()},['read_file']),null);
});

test('reasoning prose, embedded JSON, Markdown and trailing text are never tool calls',()=>{
  const strict=jsonToolCall();
  for(const reasoning of [
    'I should call Read, then continue.',
    `I will use this tool: ${strict}`,
    `${strict}\nNow I will wait.`,
    `\`\`\`json\n${strict}\n\`\`\``,
    `Example request:\n${strict}`,
  ]) assert.equal(parseToolCallFromOutput({content:'',reasoning},['read_file']),null);
});

test('damaged, repeated, multiple and non-envelope tool calls are rejected',()=>{
  const strict=jsonToolCall();
  for(const source of [
    '{"tool_call":{"name":"read_file","arguments":',
    `${strict}${strict}`,
    `${xmlToolCall()}${xmlToolCall()}`,
    JSON.stringify({tool_call:[{name:'read_file',arguments:{}},{name:'read_file',arguments:{}}]}),
    JSON.stringify({name:'read_file',arguments:{}}),
  ]) assert.equal(parseToolCall(source,['read_file']),null);
});

test('tool names and top-level arguments are strictly validated',()=>{
  assert.equal(parseToolCall(jsonToolCall('unknown',{}),['read_file']),null);
  assert.equal(parseToolCall(jsonToolCall('',{}),['']),null);
  assert.equal(parseToolCall(jsonToolCall(`a${'x'.repeat(128)}`,{}),[`a${'x'.repeat(128)}`]),null);
  for(const args of [null,[], 'path', 1, true]) assert.equal(parseToolCall(jsonToolCall('read_file',args),['read_file']),null);
  assert.equal(parseToolCall(jsonToolCall('read_file',{}),[]),null);
});

test('tool argument and source size limits are enforced',()=>{
  assert.equal(parseToolCall(jsonToolCall('read_file',{value:'x'.repeat(MAX_TOOL_BYTES)}),['read_file']),null);
  assert.equal(parseToolCall('x'.repeat(MAX_TOOL_BYTES+1),['read_file']),null);
});

test('dangerous argument keys are rejected at every nested location',()=>{
  const cases=[
    '{"__proto__":{"polluted":true}}',
    '{"safe":{"constructor":{"polluted":true}}}',
    '{"items":[{"prototype":{"polluted":true}}]}',
  ];
  for(const rawArgs of cases){
    const source=`{"tool_call":{"name":"read_file","arguments":${rawArgs}}}`;
    assert.equal(parseToolCall(source,['read_file']),null);
  }
});

test('tool argument nesting is bounded while safe objects and arrays remain valid',()=>{
  let tooDeep={value:'ok'};
  for(let index=0;index<MAX_NESTING_DEPTH+1;index+=1) tooDeep={next:tooDeep};
  assert.equal(parseToolCall(jsonToolCall('read_file',tooDeep),['read_file']),null);
  const safe={path:'package.json',options:{encoding:'utf8',ranges:[{start:1,end:3},['a','b'],null,true]}};
  const call=parseToolCall(jsonToolCall('read_file',safe),['read_file']);
  assert.deepEqual(JSON.parse(call.function.arguments),safe);
});
test('tool retry decision is limited to the first reasoning-only result with tools',()=>{
  const output={content:' ',reasoning:'I need a file'};
  assert.equal(shouldRetryToolResponse({hasTools:true,output,toolCall:null,retryCount:0}),true);
  assert.equal(shouldRetryToolResponse({hasTools:false,output,toolCall:null,retryCount:0}),false);
  assert.equal(shouldRetryToolResponse({hasTools:true,output,toolCall:{},retryCount:0}),false);
  assert.equal(shouldRetryToolResponse({hasTools:true,output:{content:'final',reasoning:'why'},toolCall:null,retryCount:0}),false);
  assert.equal(shouldRetryToolResponse({hasTools:true,output,toolCall:null,retryCount:1}),false);
});
test('corrective tool prompt is bounded to allowed names and retry reasoning is hidden',()=>{
  const prompt=createToolRetryPrompt(['read_file','glob','bad name','read_file']);
  assert.match(prompt,/strict JSON tool call/);
  assert.match(prompt,/\["read_file","glob"\]/);
  assert.doesNotMatch(prompt,/bad name/);
  assert.deepEqual(hideRetryReasoning({content:'final answer',reasoning:'private'},null),{content:'final answer',reasoning:''});
  assert.equal(hideRetryReasoning({content:'',reasoning:'private'},null).content,TOOL_RETRY_FAILURE_MESSAGE);
});
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

test('completion without diagnostic callbacks preserves retries and existing result behavior',async()=>{
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

function doctorAuth(){return JSON.stringify({token:'test-token',cookie:'test-cookie',wasmUrl:'https://example.test/pow.wasm'});}
function doctorChallenge(){return {data:{biz_data:{challenge:{challenge:'c',salt:'s',expire_at:1,difficulty:1,algorithm:'a',signature:'sig'}}}};}
function doctorFetch(marker,{reachabilityStatus=200,sessionStatus=200,challengeStatus=200,completionStatus=200,completionText}={}){
  const responses=[
    new Response('reachable',{status:reachabilityStatus}),
    new Response(sessionStatus===200?JSON.stringify({data:{biz_data:{id:'doctor-session'}}}):'session failed',{status:sessionStatus}),
    new Response(challengeStatus===200?JSON.stringify(doctorChallenge()):'challenge failed',{status:challengeStatus}),
    new Response(completionText===undefined?`data: {"p":"response/content","v":"${marker}"}\n`:completionText,{status:completionStatus}),
  ];
  return async()=>responses.shift();
}
function doctorPow({failureStage}={}){
  return async(challenge,url,timeout,onStage)=>{
    if(failureStage==='download')throw new Error('WASM download failed token=secret');
    onStage('wasm_downloaded');
    onStage('wasm_compile_start');
    if(failureStage==='compile')throw new Error('WASM compilation failed');
    onStage('wasm_compiled');
    onStage('pow_solve_start');
    if(failureStage==='solve')throw new Error('PoW solve failed');
    onStage('pow_solved');
    return 7;
  };
}
async function doctorCase(options={}){
  const marker=options.marker||'DOCTOR_MARKER_TEST';
  const lines=[];
  const result=await runDiagnostics({readFile:()=>doctorAuth(),marker,fetchImpl:options.fetchImpl||doctorFetch(marker,options.fetchOptions),solvePow:options.solvePow||doctorPow(),timeoutMs:options.timeoutMs||10_000,output:line=>lines.push(line),errorOutput:line=>lines.push(line),...options.overrides});
  return {result,lines};
}

test('doctor completes every DeepSeek diagnostic stage with mocked upstream',async()=>{
  const {result,lines}=await doctorCase();
  assert.equal(result.ok,true);
  for(const expected of ['Авторизация загружена','Token и cookie присутствуют','DeepSeek Web доступен','Удалённая сессия создана','PoW challenge получен','WASM загружен','WASM скомпилирован','PoW решён','Completion запрос выполнен','Streaming ответ получен','Streaming ответ разобран','Ответ модели получен'])assert.ok(lines.some(line=>line.includes(expected)),expected);
});
test('doctor treats an HTTP 403 homepage response as network reachability and continues',async()=>{
  const {result,lines}=await doctorCase({fetchOptions:{reachabilityStatus:403}});
  assert.equal(result.ok,true);
  assert.ok(lines.some(line=>line.includes('DeepSeek Web доступен (HTTP 403)')));
  assert.ok(lines.some(line=>line.includes('Ответ модели получен')));
});
test('doctor treats an HTTP 200 homepage response as network reachability',async()=>{
  const {result,lines}=await doctorCase({fetchOptions:{reachabilityStatus:200}});
  assert.equal(result.ok,true);
  assert.ok(lines.some(line=>line.includes('DeepSeek Web доступен (HTTP 200)')));
});
test('doctor reachability uses an unauthenticated GET to the DeepSeek homepage',async()=>{
  const marker='DOCTOR_REACHABILITY_REQUEST';
  const upstream=doctorFetch(marker);
  let first=true;
  const fetchImpl=async(url,options)=>{
    if(first){
      first=false;
      assert.equal(url,'https://chat.deepseek.com');
      assert.equal(options.method,'GET');
      assert.equal(options.headers,undefined);
    }
    return upstream();
  };
  const {result}=await doctorCase({marker,fetchImpl});
  assert.equal(result.ok,true);
});
test('doctor stops on a DeepSeek network connection error',async()=>{const {result}=await doctorCase({fetchImpl:async()=>{throw new Error('DNS lookup failed');}});assert.equal(result.stage,'web');assert.match(result.error,/DNS lookup failed/);});
test('doctor stops on a DeepSeek reachability timeout',async()=>{const {result}=await doctorCase({fetchImpl:async()=>{const error=new Error('Connection timed out');error.name='TimeoutError';throw error;}});assert.equal(result.stage,'web');assert.match(result.error,/timed out/);});
test('doctor identifies remote session creation errors',async()=>{const {result}=await doctorCase({fetchOptions:{sessionStatus:500}});assert.equal(result.stage,'session');assert.match(result.error,/HTTP 500/);});
test('doctor explains HTTP 401 session auth rejection without exposing credentials',async()=>{const {result,lines}=await doctorCase({fetchOptions:{sessionStatus:401}});assert.equal(result.stage,'session');assert.match(result.error,/отклонил текущую авторизацию.*HTTP 401.*npm run auth/);assert.doesNotMatch(lines.join('\n'),/test-token|test-cookie/);});
test('doctor explains HTTP 403 session auth rejection without exposing credentials',async()=>{const {result,lines}=await doctorCase({fetchOptions:{sessionStatus:403}});assert.equal(result.stage,'session');assert.match(result.error,/отклонил текущую авторизацию.*HTTP 403.*npm run auth/);assert.doesNotMatch(lines.join('\n'),/test-token|test-cookie/);});
test('doctor identifies challenge errors',async()=>{const {result}=await doctorCase({fetchOptions:{challengeStatus:503}});assert.equal(result.stage,'challenge');assert.match(result.error,/HTTP 503/);});
test('doctor keeps HTTP 403 from the internal challenge endpoint as an error',async()=>{const {result}=await doctorCase({fetchOptions:{challengeStatus:403}});assert.equal(result.stage,'challenge');assert.match(result.error,/HTTP 403/);});
test('doctor identifies WASM download errors without leaking secrets',async()=>{const {result,lines}=await doctorCase({solvePow:doctorPow({failureStage:'download'})});assert.equal(result.stage,'wasm_download');assert.doesNotMatch(lines.join('\n'),/secret/);});
test('doctor identifies WASM compilation errors',async()=>{const {result}=await doctorCase({solvePow:doctorPow({failureStage:'compile'})});assert.equal(result.stage,'wasm_compile');});
test('doctor identifies PoW solve errors',async()=>{const {result}=await doctorCase({solvePow:doctorPow({failureStage:'solve'})});assert.equal(result.stage,'pow');});
test('doctor identifies completion HTTP errors',async()=>{const {result}=await doctorCase({fetchOptions:{completionStatus:403}});assert.equal(result.stage,'completion');assert.match(result.error,/HTTP 403/);});
test('doctor rejects an empty parsed streaming response',async()=>{const {result}=await doctorCase({fetchOptions:{completionText:''}});assert.equal(result.stage,'answer');assert.match(result.error,/пустой/);});
test('doctor rejects a response without its expected marker',async()=>{const {result}=await doctorCase({fetchOptions:{completionText:'data: {"p":"response/content","v":"OTHER"}\n'}});assert.equal(result.stage,'answer');assert.match(result.error,/маркер/);});
test('doctor redacts credentials from arbitrary stage errors',async()=>{const {result,lines}=await doctorCase({overrides:{createSessionImpl:async()=>{throw new Error('Bearer bearer-secret token=token-secret cookie=cookie-secret authorization=auth-secret');}}});assert.equal(result.stage,'session');assert.doesNotMatch(lines.join('\n'),/bearer-secret|token-secret|cookie-secret|auth-secret/);});
test('doctor enforces a bounded overall timeout',async()=>{const lines=[];const result=await runDiagnostics({readFile:()=>doctorAuth(),reachabilityImpl:()=>new Promise(()=>{}),timeoutMs:25,output:line=>lines.push(line),errorOutput:line=>lines.push(line)});assert.equal(result.stage,'timeout');assert.ok(lines.some(line=>line.includes('Общее время диагностики')));assert.equal(boundedTimeout(Infinity),150_000);assert.equal(boundedTimeout(999_999),180_000);});
test('setup allows bounded headroom for the full doctor process',()=>{assert.ok(DOCTOR_PROCESS_TIMEOUT_MS>180_000&&DOCTOR_PROCESS_TIMEOUT_MS<=240_000);});

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

async function nonStreamingToolProtocolCase(path,body){
  const config={host:'127.0.0.1',port:0,key:'',maxBytes:1024*1024,timeoutMs:5000,origins:new Set()};
  const server=createProxyServer({config,completeImpl:async()=>({content:'',reasoning:jsonToolCall('read_file',{path:'package.json'}),parentMessageId:null})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal(response.status,200);
    return response.json();
  }finally{
    server.closeAllConnections?.();
    await new Promise(resolve=>server.close(resolve));
  }
}

test('strict reasoning tool calls map to OpenAI tool_calls',async()=>{
  const response=await nonStreamingToolProtocolCase('/v1/chat/completions',{
    model:'deepseek-chat',messages:[{role:'user',content:'read package'}],
    tools:[{type:'function',function:{name:'read_file',parameters:{type:'object'}}}],
  });
  assert.equal(response.choices[0].finish_reason,'tool_calls');
  assert.equal(response.choices[0].message.tool_calls[0].function.name,'read_file');
  assert.deepEqual(JSON.parse(response.choices[0].message.tool_calls[0].function.arguments),{path:'package.json'});
});

test('strict reasoning tool calls map to Anthropic tool_use',async()=>{
  const response=await nonStreamingToolProtocolCase('/v1/messages',{
    model:'deepseek-chat',max_tokens:64,messages:[{role:'user',content:'read package'}],
    tools:[{name:'read_file',input_schema:{type:'object'}}],
  });
  assert.equal(response.stop_reason,'tool_use');
  assert.deepEqual(response.content[0],{type:'tool_use',id:response.content[0].id,name:'read_file',input:{path:'package.json'}});
});

test('strict reasoning tool calls map to Responses function_call',async()=>{
  const response=await nonStreamingToolProtocolCase('/v1/responses',{
    model:'deepseek-chat',input:'read package',
    tools:[{type:'function',name:'read_file',parameters:{type:'object'}}],
  });
  assert.equal(response.output[0].type,'function_call');
  assert.equal(response.output[0].name,'read_file');
  assert.deepEqual(JSON.parse(response.output[0].arguments),{path:'package.json'});
});

test('streaming hides a strict reasoning envelope and emits only protocol tool events',async()=>{
  const config={host:'127.0.0.1',port:0,key:'',maxBytes:1024*1024,timeoutMs:5000,origins:new Set()};
  const reasoning=jsonToolCall('echo',{text:'ok'});
  const server=createProxyServer({config,completeImpl:async({onDelta})=>{
    onDelta({reasoning});
    return {content:'',reasoning,parentMessageId:null};
  }});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'deepseek-chat',stream:true,messages:[{role:'user',content:'use tool'}],tools:[{type:'function',function:{name:'echo',parameters:{type:'object'}}}]})});
    const output=await response.text();
    assert.doesNotMatch(output,/"tool_call":/);
    assert.doesNotMatch(output,/<tool_call>/);
    assert.match(output,/"tool_calls"/);
    assert.match(output,/"finish_reason":"tool_calls"/);
  }finally{
    server.closeAllConnections?.();
    await new Promise(resolve=>server.close(resolve));
  }
});

test('ordinary responses without tools and rejected tool-like text stay normal responses',async()=>{
  const outputs=[
    {content:'ordinary answer',reasoning:'I may use Read later',parentMessageId:null},
    {content:`Example only: ${jsonToolCall('read_file',{})}`,reasoning:'',parentMessageId:null},
  ];
  const config={host:'127.0.0.1',port:0,key:'',maxBytes:1024*1024,timeoutMs:5000,origins:new Set()};
  const server=createProxyServer({config,completeImpl:async()=>outputs.shift()});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const base=`http://127.0.0.1:${server.address().port}/v1/chat/completions`;
    const normal=await (await fetch(base,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'deepseek-chat',messages:[{role:'user',content:'answer'}]})})).json();
    assert.equal(normal.choices[0].message.content,'ordinary answer');
    assert.equal(normal.choices[0].finish_reason,'stop');
    const rejected=await (await fetch(base,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'deepseek-chat',messages:[{role:'user',content:'answer'}],tools:[{type:'function',function:{name:'read_file',parameters:{type:'object'}}}]})})).json();
    assert.match(rejected.choices[0].message.content,/^Example only:/);
    assert.equal(rejected.choices[0].finish_reason,'stop');
    assert.equal(rejected.choices[0].message.tool_calls,undefined);
  }finally{
    server.closeAllConnections?.();
    await new Promise(resolve=>server.close(resolve));
  }
});

async function toolRetryProxyCase({path='/v1/chat/completions',body,completeImpl,logger,sessionStore,headers={}}){
  const config={host:'127.0.0.1',port:0,key:'',maxBytes:1024*1024,timeoutMs:5000,origins:new Set()};
  const server=createProxyServer({config,completeImpl,logger,sessionStore});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
    return {status:response.status,contentType:response.headers.get('content-type'),text:await response.text()};
  }finally{
    server.closeAllConnections?.();
    await new Promise(resolve=>server.close(resolve));
  }
}

test('tool retry is skipped without tools, after a first tool call, and after final content',async()=>{
  const cases=[
    {body:{model:'deepseek-chat',messages:[{role:'user',content:'answer'}]},output:{content:'',reasoning:'planning'}},
    {body:{model:'deepseek-chat',messages:[{role:'user',content:'use tool'}],tools:[{type:'function',function:{name:'read_file'}}]},output:{content:'',reasoning:jsonToolCall()}},
    {body:{model:'deepseek-chat',messages:[{role:'user',content:'answer'}],tools:[{type:'function',function:{name:'read_file'}}]},output:{content:'final answer',reasoning:'brief thought'}},
  ];
  for(const item of cases){
    let calls=0;
    const result=await toolRetryProxyCase({body:item.body,logger:()=>{},completeImpl:async()=>{calls+=1;return {...item.output,parentMessageId:null};}});
    assert.equal(result.status,200);
    assert.equal(calls,1);
  }
});

test('reasoning-only tool response causes one same-session retry in chat mode with allowed tools',async()=>{
  const calls=[];
  const logs=[];
  const firstReasoning='PRIVATE_FIRST_REASONING_NEED_READ';
  const result=await toolRetryProxyCase({
    body:{model:'deepseek-reasoner-search',messages:[{role:'user',content:'read package'}],tools:[{type:'function',function:{name:'read_file',parameters:{type:'object'}}}]},
    logger:line=>logs.push(line),
    completeImpl:async options=>{
      calls.push(options);
      if(calls.length===1){options.session.id='remote-session';options.session.parentMessageId='first-message';return {content:'',reasoning:firstReasoning,parentMessageId:'first-message'};}
      return {content:jsonToolCall('read_file',{path:'package.json'}),reasoning:'',parentMessageId:'second-message'};
    },
  });
  const response=JSON.parse(result.text);
  assert.equal(calls.length,2);
  assert.equal(calls[0].model.reasoning,true);
  assert.equal(calls[0].model.search,true);
  assert.equal(calls[1].model.reasoning,false);
  assert.equal(calls[1].model.search,false);
  assert.equal(calls[1].session,calls[0].session);
  assert.equal(calls[1].session.id,'remote-session');
  assert.match(calls[1].prompt,/\["read_file"\]/);
  assert.doesNotMatch(calls[1].prompt,new RegExp(firstReasoning));
  assert.equal(response.model,'deepseek-reasoner-search');
  assert.equal(response.choices[0].message.tool_calls[0].function.name,'read_file');
  assert.match(logs.join('\n'),/Retrying one reasoning-only tool response/);
  assert.doesNotMatch(logs.join('\n'),new RegExp(firstReasoning));
});

test('final text from the second attempt is returned and only it enters local history',async()=>{
  const sessions=new SessionStore();
  const firstReasoning='PRIVATE_INTERMEDIATE_REASONING';
  let calls=0;
  const result=await toolRetryProxyCase({
    sessionStore:sessions,headers:{'x-agent-session':'retry-history'},logger:()=>{},
    body:{model:'deepseek-reasoner',messages:[{role:'user',content:'finish'}],tools:[{type:'function',function:{name:'read_file'}}]},
    completeImpl:async()=>{calls+=1;return calls===1?{content:'',reasoning:firstReasoning,parentMessageId:'one'}:{content:'final answer after retry',reasoning:'should stay private',parentMessageId:'two'};},
  });
  const response=JSON.parse(result.text);
  assert.equal(calls,2);
  assert.equal(response.choices[0].message.content,'final answer after retry');
  assert.equal(response.choices[0].message.reasoning_content,undefined);
  assert.doesNotMatch(result.text,new RegExp(firstReasoning));
  const history=sessions.get('retry-history').history;
  assert.equal(history.length,1);
  assert.equal(history[0].assistant,'final answer after retry');
  assert.doesNotMatch(JSON.stringify(history),/PRIVATE_INTERMEDIATE_REASONING|should stay private/);
});

test('a second reasoning-only result stops after two calls with a safe final message',async()=>{
  let calls=0;
  const result=await toolRetryProxyCase({
    logger:()=>{},
    body:{model:'deepseek-reasoner',messages:[{role:'user',content:'use tool'}],tools:[{type:'function',function:{name:'read_file'}}]},
    completeImpl:async()=>{calls+=1;return {content:'',reasoning:`PRIVATE_REASONING_${calls}`,parentMessageId:String(calls)};},
  });
  const response=JSON.parse(result.text);
  assert.equal(calls,2);
  assert.equal(response.choices[0].message.content,TOOL_RETRY_FAILURE_MESSAGE);
  assert.equal(response.choices[0].message.reasoning_content,undefined);
  assert.doesNotMatch(result.text,/PRIVATE_REASONING/);
});

test('network, authorization and timeout errors never trigger the tool correction retry',async()=>{
  const errors=[new Error('network failed'),Object.assign(new Error('HTTP 401'),{status:401}),Object.assign(new Error('HTTP 403'),{status:403}),Object.assign(new Error('timed out'),{name:'TimeoutError',status:504})];
  for(const error of errors){
    let calls=0;
    const result=await toolRetryProxyCase({
      logger:()=>{},
      body:{model:'deepseek-reasoner',messages:[{role:'user',content:'use tool'}],tools:[{type:'function',function:{name:'read_file'}}]},
      completeImpl:async()=>{calls+=1;throw error;},
    });
    assert.equal(calls,1);
    assert.ok(result.status>=400);
  }
});

async function streamingToolRetryCase(path,body,expected){
  let calls=0;
  const firstReasoning='PRIVATE_STREAM_REASONING';
  const correctivePromptText='Return the final answer for the current task now.';
  const result=await toolRetryProxyCase({path,body:{...body,stream:true},logger:()=>{},completeImpl:async({onDelta,prompt})=>{
    calls+=1;
    if(calls===1){onDelta({reasoning:firstReasoning});return {content:'',reasoning:firstReasoning,parentMessageId:'one'};}
    assert.match(prompt,/strict JSON tool call/);
    const content=jsonToolCall('read_file',{path:'package.json'});
    onDelta({content});
    return {content,reasoning:'',parentMessageId:'two'};
  }});
  assert.equal(calls,2);
  assert.match(result.contentType,/^text\/event-stream/);
  assert.doesNotMatch(result.text,new RegExp(`${firstReasoning}|${correctivePromptText}`));
  assert.match(result.text,expected);
  return result.text;
}

test('OpenAI streaming emits tool_calls only after a successful retry',()=>streamingToolRetryCase(
  '/v1/chat/completions',
  {model:'deepseek-reasoner',messages:[{role:'user',content:'read'}],tools:[{type:'function',function:{name:'read_file'}}]},
  /"tool_calls"/
));

test('Anthropic streaming emits tool_use only after a successful retry',()=>streamingToolRetryCase(
  '/v1/messages',
  {model:'deepseek-reasoner',max_tokens:64,messages:[{role:'user',content:'read'}],tools:[{name:'read_file',input_schema:{type:'object'}}]},
  /"type":"tool_use"/
));

test('Responses streaming emits function_call only after a successful retry',()=>streamingToolRetryCase(
  '/v1/responses',
  {model:'deepseek-reasoner',input:'read',tools:[{type:'function',name:'read_file',parameters:{type:'object'}}]},
  /"type":"function_call"/
));

test('Bridge logs the safe upstream reason while streaming clients receive no secrets',async()=>{
  const logs=[];
  const config={host:'127.0.0.1',port:0,key:'',maxBytes:1024*1024,timeoutMs:5000,origins:new Set()};
  const server=createProxyServer({config,logger:line=>logs.push(line),completeImpl:async()=>{throw new Error('Gateway unavailable: Bearer bearer-secret token=token-secret cookie=session-secret authorization=auth-secret');}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'deepseek-chat',stream:true,messages:[{role:'user',content:'test'}]})});
    const output=await response.text();
    assert.match(output,/DeepSeek streaming request failed/);
    assert.doesNotMatch(output,/bearer-secret|token-secret|session-secret|auth-secret/);
    assert.match(logs.join('\n'),/Gateway unavailable/);
    assert.doesNotMatch(logs.join('\n'),/bearer-secret|token-secret|session-secret|auth-secret/);
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve=>server.close(resolve));
  }
});

test('Bridge normal API errors do not disclose upstream secrets',async()=>{
  const logs=[];
  const config={host:'127.0.0.1',port:0,key:'',maxBytes:1024*1024,timeoutMs:5000,origins:new Set()};
  const server=createProxyServer({config,logger:line=>logs.push(line),completeImpl:async()=>{const error=new Error('Gateway unavailable: Bearer bearer-secret token=token-secret cookie=session-secret authorization=auth-secret');error.status=502;throw error;}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'deepseek-chat',messages:[{role:'user',content:'test'}]})});
    const output=await response.text();
    assert.match(output,/DeepSeek request failed/);
    assert.doesNotMatch(output,/bearer-secret|token-secret|session-secret|auth-secret/);
    assert.match(logs.join('\n'),/Gateway unavailable/);
    assert.doesNotMatch(logs.join('\n'),/bearer-secret|token-secret|session-secret|auth-secret/);
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
    action:async(name,options)=>({ok:name==='doctor'&&options.model==='deepseek-chat-search'&&options.workingDirectory==='C:\\project',message:'checked'}),
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
    const allowed=await fetch(base+'/api/setup/action',{method:'POST',headers:{'content-type':'application/json','x-setup-token':'setup-test-token'},body:'{"action":"doctor","model":"deepseek-chat-search","workingDirectory":"C:\\\\project"}'});
    assert.equal(allowed.status,200);
    assert.equal((await allowed.json()).ok,true);
    const models=await (await fetch(base+'/v1/models')).json();
    assert.deepEqual(models.data.map(model=>model.id),['deepseek-chat','deepseek-reasoner','deepseek-chat-search','deepseek-reasoner-search']);
    const unavailable=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:'{"model":"deepseek-expert","messages":[{"role":"user","content":"test"}]}'});
    assert.equal(unavailable.status,400);
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

test('setup controller passes only an available selected model to CLI agents',async()=>{
  const calls=[];
  const controller=createSetupController({
    root:process.cwd(),
    hasCommand:()=>true,
    launchTerminal:async(root,command)=>{calls.push({root,command});return 9876;},
  });
  const claude=await controller.action('claude',{model:'deepseek-chat-search',workingDirectory:process.cwd()});
  assert.equal(claude.ok,true);
  assert.equal(claude.model,'deepseek-chat-search');
  assert.equal(calls[0].root,process.cwd());
  assert.match(calls[0].command,/claude\.cmd --model deepseek-chat-search$/);
  const opencode=await controller.action('opencode',{model:'deepseek-reasoner-search',workingDirectory:process.cwd()});
  assert.equal(opencode.ok,true);
  assert.equal(calls[1].root,process.cwd());
  assert.match(calls[1].command,/OPENCODE_CONFIG=/);
  assert.match(calls[1].command,/deepseek-web\/deepseek-reasoner-search$/);
  const unavailable=await controller.action('claude',{model:'deepseek-expert'});
  assert.equal(unavailable.ok,false);
  assert.equal(calls.length,2);
});

test('setup folder selection and working-directory validation are bounded',async()=>{
  const selected=process.cwd();
  const controller=createSetupController({
    root:process.cwd(),
    selectFolder:async initial=>{assert.equal(initial,process.cwd());return selected;},
  });
  const result=await controller.action('choose-folder',{workingDirectory:'Z:\\missing-deepseek-bridge-folder'});
  assert.equal(result.ok,true);
  assert.equal(result.path,selected);
  assert.equal(existingDirectory(process.cwd(),process.cwd()),process.cwd());
  assert.equal(existingDirectory('Z:\\missing-deepseek-bridge-folder',process.cwd()),null);

  const noLaunch=createSetupController({root:process.cwd(),hasCommand:()=>true,launchTerminal:async()=>{throw new Error('must not launch');}});
  const invalid=await noLaunch.action('claude',{model:'deepseek-reasoner',workingDirectory:'Z:\\missing-deepseek-bridge-folder'});
  assert.equal(invalid.ok,false);
  assert.match(invalid.message,/Папка проекта/);
});
