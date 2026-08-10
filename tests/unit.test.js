'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const test=require('node:test'),assert=require('node:assert/strict'); const {isLoopback,isLocalOrigin,assertConfig,safeError,logSafeError}=require('../lib/security'); const {SessionStore}=require('../lib/session'); const {SessionResolver,clientSessionKey,explicitSessionKey,extractToolResultCallIds,normalizeCallId}=require('../lib/session_resolver'); const {IMAGE_BLOCK_TOKENS,MAX_DEPTH:MAX_TOKEN_DEPTH,UNKNOWN_BLOCK_TOKENS,estimateTextTokens,estimateTokenCount,validateCountTokensBody}=require('../lib/token_count'); const {MAX_TOOL_BYTES,MAX_NESTING_DEPTH,inspectToolCall,inspectToolCallFromOutput,parseToolCall,parseToolCallFromOutput,toolPrompt}=require('../lib/tool_parser'); const client=require('../client'); const { checked, complete, loadAuth, parseRetryAfter, parseStream }=client; const {createProxyServer,toAnthropic,toOpenAI,toResponses}=require('../server');
const {TOOL_RETRY_FAILURE_MESSAGE,createFencedToolRetryPrompt,createToolRetryPrompt,hideRetryReasoning,shouldRetryFencedToolResponse,shouldRetryToolResponse}=require('../lib/tool_retry');
const {REPEATED_TOOL_FAILURE_MESSAGE,extractToolResults,isExactCompletedToolCall}=require('../lib/tool_continuation');
const {MAX_TOOL_NAMES,MAX_TOOL_NAME_CHARS,classifyUpstreamError,createToolDiagnostics}=require('../lib/tool_diagnostics');
const {solvePOW}=require('../lib/pow');
const {DOCTOR_PROCESS_TIMEOUT_MS,createSetupController,existingDirectory,readAuthStatus}=require('../lib/setup');
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
test('safe error logging redacts network URLs and local absolute paths',()=>{
  const unsafe=[
    'failed at https://secret.example/path?token=URL_MARKER',
    'failed at file:///C:/Users/Sensitive/FILE_MARKER.txt',
    'failed at C:\\Users\\Sensitive\\WINDOWS_MARKER.txt',
    'failed at \\\\private-server\\share\\UNC_MARKER.txt',
    'failed at /home/sensitive/UNIX_MARKER.txt',
    'failed at /workspace/private/WORKSPACE_MARKER.txt',
  ];
  for(const value of unsafe){
    const message=safeError(new Error(value));
    assert.doesNotMatch(message,/secret\.example|URL_MARKER|FILE_MARKER|WINDOWS_MARKER|UNC_MARKER|UNIX_MARKER|WORKSPACE_MARKER|https?:\/\/|file:\/\/|[A-Z]:\\|\\\\private-server|\/home\/sensitive|\/workspace\/private/);
  }
  assert.equal(safeError(new Error('fetch failed')),'fetch failed');
  assert.equal(safeError(new Error('Upstream request timed out')),'Upstream request timed out');
  assert.equal(safeError(new Error('DeepSeek Web HTTP 429')),'DeepSeek Web HTTP 429');
});
test('setup auth status accepts only non-empty string credentials',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'deepseek-bridge-auth-status-'));
  const authPath=path.join(root,'deepseek-auth.json');
  const previousAuthPath=process.env.DEEPSEEK_AUTH_PATH;
  delete process.env.DEEPSEEK_AUTH_PATH;
  t.after(()=>{
    if(previousAuthPath===undefined) delete process.env.DEEPSEEK_AUTH_PATH;
    else process.env.DEEPSEEK_AUTH_PATH=previousAuthPath;
    fs.rmSync(root,{recursive:true,force:true});
  });

  fs.writeFileSync(authPath,JSON.stringify({token:'valid-token',cookie:'session=valid'}));
  assert.deepEqual(readAuthStatus(root),{present:true,valid:true});
  fs.writeFileSync(authPath,JSON.stringify({token:'   ',cookie:'session=valid'}));
  assert.deepEqual(readAuthStatus(root),{present:true,valid:false});
  fs.writeFileSync(authPath,JSON.stringify({token:123,cookie:{value:'session=invalid'}}));
  assert.deepEqual(readAuthStatus(root),{present:true,valid:false});
});
test('client auth accepts only non-empty strings without changing credential values',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'deepseek-bridge-client-auth-'));
  const authPath=path.join(root,'deepseek-auth.json');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));

  const valid={token:'  valid-token  ',cookie:'  session=valid  '};
  fs.writeFileSync(authPath,JSON.stringify(valid));
  assert.deepEqual(loadAuth(authPath),valid);

  const invalidCredentials=[
    {token:'',cookie:'cookie-secret-empty-token'},
    {token:'token-secret-empty-cookie',cookie:''},
    {token:'   ',cookie:'cookie-secret-whitespace-token'},
    {token:'token-secret-whitespace-cookie',cookie:'   '},
    {token:123,cookie:'cookie-secret-numeric-token'},
    {token:'token-secret-numeric-cookie',cookie:456},
    {token:{value:'token-secret-object'},cookie:'cookie-secret-object-token'},
    {token:'token-secret-object-cookie',cookie:{value:'cookie-secret-object'}},
  ];

  for(const auth of invalidCredentials){
    fs.writeFileSync(authPath,JSON.stringify(auth));
    assert.throws(()=>loadAuth(authPath),error=>{
      assert.match(error.message,/^Run npm run auth first \(token or cookie missing\)\.$/);
      assert.doesNotMatch(error.message,/secret|123|456/);
      return true;
    });
  }
});

test('/readyz stays unavailable when stored credentials are invalid',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'deepseek-bridge-readyz-auth-'));
  const authPath=path.join(root,'deepseek-auth.json');
  const originalLoadAuth=client.loadAuth;
  fs.writeFileSync(authPath,JSON.stringify({token:{secret:'token-must-not-leak'},cookie:'cookie-must-not-leak'}));
  client.loadAuth=()=>loadAuth(authPath);
  t.after(()=>{
    client.loadAuth=originalLoadAuth;
    fs.rmSync(root,{recursive:true,force:true});
  });

  const config={host:'127.0.0.1',port:0,key:'',maxBytes:1024*1024,timeoutMs:5000,origins:new Set()};
  const server=createProxyServer({config,completeImpl:async()=>({content:'unused',reasoning:'',parentMessageId:null})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/readyz`);
    const body=await response.text();
    assert.equal(response.status,503);
    assert.deepEqual(JSON.parse(body),{ready:false,action:'Run npm run auth'});
    assert.doesNotMatch(body,/token-must-not-leak|cookie-must-not-leak/);
  }finally{
    server.closeAllConnections?.();
    await new Promise(resolve=>server.close(resolve));
  }
});
test('session expiry/reset and bounded history',()=>{const s=new SessionStore({ttlMs:1,maxHistory:2});const x=s.get('a');s.add(x,'one','a');s.add(x,'two','b');s.add(x,'three','c');assert.equal(x.history.length,2);s.reset('a');assert.equal(s.list().length,0);});

test('session resolver prioritizes and hashes explicit identifiers',()=>{
  const resolver=new SessionResolver({randomUUID:()=> 'unused'});
  const header=resolver.resolve({headers:{'x-agent-session':'agent-header'},body:{metadata:{user_id:'metadata-user'},user:'body-user'},kind:'openai'});
  const metadata=resolver.resolve({body:{metadata:{user_id:'metadata-user'},user:'body-user'},kind:'openai'});
  const user=resolver.resolve({body:{user:'body-user'},kind:'openai'});
  assert.equal(header.upstreamKey,explicitSessionKey('header','agent-header'));
  assert.equal(metadata.upstreamKey,explicitSessionKey('metadata','metadata-user'));
  assert.equal(user.upstreamKey,explicitSessionKey('user','body-user'));
  assert.notEqual(header.upstreamKey,metadata.upstreamKey);
  assert.doesNotMatch(`${header.upstreamKey}${metadata.upstreamKey}${user.upstreamKey}`,/agent-header|metadata-user|body-user/);
  assert.equal(resolver.resolve({body:{metadata:{user_id:'metadata-user'}},kind:'openai'}).upstreamKey,metadata.upstreamKey);
});

test('Claude session header creates stable client identity without stateful upstream routing',()=>{
  let sequence=0;
  const resolver=new SessionResolver({randomUUID:()=>`claude-turn-${++sequence}`});
  const first=resolver.resolve({headers:{'x-claude-code-session-id':'claude-session-one'},kind:'anthropic'});
  const second=resolver.resolve({headers:{'x-claude-code-session-id':'claude-session-one'},kind:'anthropic'});
  const other=resolver.resolve({headers:{'x-claude-code-session-id':'claude-session-two'},kind:'anthropic'});
  assert.equal(first.clientSource,'claude_header');
  assert.equal(first.clientKey,second.clientKey);
  assert.notEqual(first.clientKey,other.clientKey);
  assert.match(first.clientKey,/^client:claude:[a-f0-9]{64}$/);
  assert.doesNotMatch(first.clientKey,/claude-session-one/);
  assert.equal(first.upstreamSource,'anonymous');
  assert.equal(second.upstreamSource,'anonymous');
  assert.notEqual(first.upstreamKey,second.upstreamKey);
  assert.equal(first.upstreamKey,'anonymous:claude-turn-1');
  assert.equal(second.upstreamKey,'anonymous:claude-turn-2');
});

test('client identity validates Claude headers and follows Node lowercase header names',()=>{
  const invalidValues=['','   ','x'.repeat(129),123,{value:'object'}];
  for(const value of invalidValues){
    const resolution=new SessionResolver().resolve({headers:{'x-claude-code-session-id':value},kind:'anthropic'});
    assert.equal(resolution.clientSource,'unavailable');
    assert.equal(resolution.clientKey,null);
    assert.equal(resolution.upstreamSource,'anonymous');
  }
  const wrongCase=new SessionResolver().resolve({headers:{'X-Claude-Code-Session-Id':'not-a-real-node-header-key'},kind:'anthropic'});
  assert.equal(wrongCase.clientSource,'unavailable');
  assert.equal(wrongCase.clientKey,null);
  assert.equal(clientSessionKey('claude',''),null);
  assert.equal(clientSessionKey('claude',123),null);
  assert.doesNotThrow(()=>new SessionResolver().resolve({headers:null,body:null,kind:'anthropic'}));
});

test('client and upstream identity use independent precedence rules',()=>{
  const resolver=new SessionResolver({randomUUID:()=> 'unused'});
  const both=resolver.resolve({
    headers:{'x-claude-code-session-id':'claude-client','x-agent-session':'explicit-upstream'},
    body:{metadata:{user_id:'metadata-id'},user:'user-id'},
    kind:'anthropic',
  });
  assert.equal(both.clientSource,'claude_header');
  assert.equal(both.clientKey,clientSessionKey('claude','claude-client'));
  assert.equal(both.upstreamSource,'explicit_header');
  assert.equal(both.upstreamKey,explicitSessionKey('header','explicit-upstream'));

  const headerOnly=resolver.resolve({headers:{'x-agent-session':'explicit-upstream'},kind:'anthropic'});
  assert.equal(headerOnly.clientSource,'explicit_header');
  assert.equal(headerOnly.clientKey,clientSessionKey('header','explicit-upstream'));
  assert.equal(headerOnly.upstreamKey,both.upstreamKey);

  const metadata=resolver.resolve({body:{metadata:{user_id:'metadata-id'},user:'user-id'},kind:'anthropic'});
  assert.equal(metadata.clientSource,'explicit_metadata');
  assert.equal(metadata.clientKey,clientSessionKey('metadata','metadata-id'));
  assert.equal(metadata.upstreamSource,'explicit_metadata');
  assert.equal(metadata.upstreamKey,explicitSessionKey('metadata','metadata-id'));

  const user=resolver.resolve({body:{user:'user-id'},kind:'anthropic'});
  assert.equal(user.clientSource,'explicit_user');
  assert.equal(user.upstreamSource,'explicit_user');
  const unavailable=resolver.resolve({kind:'anthropic'});
  assert.equal(unavailable.clientSource,'unavailable');
  assert.equal(unavailable.clientKey,null);
});

test('tool results retain upstream linkage while Claude client identity stays stable',()=>{
  let sequence=0;
  const resolver=new SessionResolver({randomUUID:()=>`tool-turn-${++sequence}`});
  const headers={'x-claude-code-session-id':'claude-tool-session'};
  const first=resolver.resolve({headers,kind:'anthropic'});
  assert.equal(resolver.bind('call-claude-tool',first.upstreamKey),true);
  const continuation=resolver.resolve({
    headers,
    body:{messages:[{role:'user',content:[{type:'tool_result',tool_use_id:'call-claude-tool'}]}]},
    kind:'anthropic',
  });
  const nextTurn=resolver.resolve({headers,kind:'anthropic'});
  assert.equal(continuation.upstreamSource,'tool_result');
  assert.equal(continuation.upstreamKey,first.upstreamKey);
  assert.equal(continuation.clientKey,first.clientKey);
  assert.equal(nextTurn.clientKey,first.clientKey);
  assert.notEqual(nextTurn.upstreamKey,first.upstreamKey);
});

test('anonymous session resolution is unique and never uses default',()=>{
  let sequence=0;
  const resolver=new SessionResolver({randomUUID:()=>`request-${++sequence}`});
  const first=resolver.resolve({kind:'openai'});
  const second=resolver.resolve({kind:'openai'});
  assert.equal(first.upstreamKey,'anonymous:request-1');
  assert.equal(second.upstreamKey,'anonymous:request-2');
  assert.notEqual(first.upstreamKey,second.upstreamKey);
  assert.notEqual(first.upstreamKey,'default');
  assert.notEqual(second.upstreamKey,'default');
});

test('tool result call ids are extracted only from their supported protocols',()=>{
  assert.deepEqual(extractToolResultCallIds({messages:[{role:'tool',tool_call_id:'call_openai'}]},'openai'),['call_openai']);
  assert.deepEqual(extractToolResultCallIds({messages:[{role:'user',content:[{type:'tool_result',tool_use_id:'call_anthropic'}]}]},'anthropic'),['call_anthropic']);
  assert.deepEqual(extractToolResultCallIds({input:[{type:'function_call_output',call_id:'call_responses'}]},'responses'),['call_responses']);
  assert.deepEqual(extractToolResultCallIds({messages:[{role:'user',tool_call_id:'ignored'}]},'openai'),[]);
});

test('explicit upstream identity keeps precedence over a conflicting tool-result link',()=>{
  const resolver=new SessionResolver({randomUUID:()=> 'unused'});
  resolver.bind('call-linked','anonymous:linked-session');
  const resolution=resolver.resolve({
    headers:{'x-agent-session':'explicit-session'},
    body:{messages:[{role:'tool',tool_call_id:'call-linked'}]},
    kind:'openai',
  });
  assert.equal(resolution.upstreamKey,explicitSessionKey('header','explicit-session'));
  assert.equal(resolution.upstreamSource,'explicit_header');
  assert.deepEqual(resolution.callIds,['call-linked']);
});

test('call-id links expire, are bounded and reject unsafe identifiers',()=>{
  let now=100;
  let sequence=0;
  const resolver=new SessionResolver({ttlMs:10,maxLinks:2,now:()=>now,randomUUID:()=>`fresh-${++sequence}`});
  assert.equal(resolver.bind('call-a','anonymous:one'),true);
  assert.equal(resolver.resolve({kind:'openai',body:{messages:[{role:'tool',tool_call_id:'call-a'}]}}).upstreamKey,'anonymous:one');
  resolver.bind('call-b','anonymous:two');
  resolver.bind('call-c','anonymous:three');
  assert.equal(resolver.size,2);
  assert.equal(resolver.resolve({kind:'openai',body:{messages:[{role:'tool',tool_call_id:'call-a'}]}}).upstreamSource,'anonymous');
  now=111;
  assert.equal(resolver.resolve({kind:'openai',body:{messages:[{role:'tool',tool_call_id:'call-b'}]}}).upstreamSource,'anonymous');
  assert.equal(resolver.size,0);
  assert.equal(normalizeCallId('x'.repeat(129)),null);
  assert.equal(normalizeCallId('../unsafe'),null);
  assert.equal(resolver.bind('x'.repeat(129),'anonymous:four'),false);
  const oversizedSession=resolver.resolve({headers:{'x-agent-session':'s'.repeat(129)},body:{metadata:{user_id:'must-not-fallback'}},kind:'openai'});
  assert.equal(oversizedSession.upstreamSource,'anonymous');
  assert.doesNotMatch(oversizedSession.upstreamKey,/must-not-fallback|s{20}/);
});

test('session store has bounded memory and no implicit default key',()=>{
  let now=0;
  const sessions=new SessionStore({maxSessions:2,ttlMs:10,now:()=>now});
  sessions.get('anonymous:one');
  now=1;sessions.get('anonymous:two');
  now=2;sessions.get('anonymous:three');
  assert.equal(sessions.list().length,2);
  assert.equal(sessions.list().some(item=>item.key==='anonymous:one'),false);
  now=20;
  assert.equal(sessions.list().length,0);
  assert.notEqual(sessions.key(),'default');
});

test('token text estimate is deterministic and accounts for multilingual text and emoji',()=>{
  const english=estimateTextTokens('token probe in ordinary English');
  const russian=estimateTextTokens('Проверка количества токенов');
  const chinese=estimateTextTokens('你好世界');
  const emoji=estimateTextTokens('😀');
  assert.ok(Number.isInteger(english)&&english>0);
  assert.ok(russian>=8);
  assert.ok(chinese>=4);
  assert.ok(emoji>=2);
  assert.equal(estimateTextTokens('Проверка количества токенов'),russian);
});

test('token estimate includes system, messages and Anthropic content blocks',()=>{
  const base={model:'deepseek-chat',messages:[{role:'user',content:'hello'}]};
  const simple=estimateTokenCount(base);
  const rich=estimateTokenCount({
    ...base,
    system:[{type:'text',text:'system rules'}],
    messages:[
      {role:'user',content:[{type:'text',text:'hello'},{type:'image',source:{type:'base64',data:'not-counted'}}]},
      {role:'assistant',content:[{type:'thinking',thinking:'consider safely'},{type:'tool_use',id:'toolu_1',name:'read_file',input:{path:'package.json'}}]},
      {role:'user',content:[{type:'tool_result',tool_use_id:'toolu_1',content:[{type:'text',text:'result text'}]},{type:'future_block',payload:'opaque'}]},
    ],
  });
  assert.ok(Number.isInteger(rich)&&rich>=0);
  assert.ok(rich>simple+IMAGE_BLOCK_TOKENS+UNKNOWN_BLOCK_TOKENS);
});

test('token estimate includes tool names, descriptions and nested JSON Schema',()=>{
  const withoutTools=estimateTokenCount({model:'deepseek-chat',messages:[]});
  const withTools=estimateTokenCount({model:'deepseek-chat',messages:[],tools:[{
    name:'read_file',description:'Read a local text file safely',input_schema:{type:'object',properties:{path:{type:'string'},options:{type:'object',properties:{encoding:{type:'string'},ranges:{type:'array',items:{type:'number'}}}}},required:['path']},
  }]});
  assert.ok(withTools>withoutTools);
});

test('token estimator bounds deep, cyclic and unusual structures',()=>{
  const cycle={type:'object'};cycle.self=cycle;
  let deep={value:'end'};for(let index=0;index<MAX_TOKEN_DEPTH+20;index++)deep={nested:deep};
  const body={model:'deepseek-chat',messages:[{role:'user',content:[{type:'image',source:cycle},{type:'unknown',payload:cycle}]}],tools:[{name:'safe_tool',input_schema:{cycle,deep}}]};
  const first=estimateTokenCount(body);
  const second=estimateTokenCount(body);
  assert.ok(Number.isInteger(first)&&first>=IMAGE_BLOCK_TOKENS);
  assert.equal(first,second);
});

test('count_tokens body validation requires the confirmed Anthropic contract',()=>{
  assert.match(validateCountTokensBody({}),/model is required/);
  assert.match(validateCountTokensBody({model:'deepseek-chat'}),/messages is required/);
  assert.match(validateCountTokensBody({model:'deepseek-chat',messages:[],system:{}}),/system must/);
  assert.match(validateCountTokensBody({model:'deepseek-chat',messages:[],tools:{}}),/tools must/);
  assert.equal(validateCountTokensBody({model:'deepseek-chat',messages:[]}),null);
});
const jsonToolCall=(name='read_file',args={path:'package.json'})=>JSON.stringify({tool_call:{name,arguments:args}});
const fencedToolCall=(name='read_file',args={path:'package.json'})=>`\`\`\`json\n${jsonToolCall(name,args)}\n\`\`\``;
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

test('tool inspection accepts the observed Glob JSON and preserves current source priority',()=>{
  const observed='{"tool_call":{"name":"Glob","arguments":{"pattern":"**/InteractiveStars.tsx"}}}';
  const allowed=['Glob','Read','Grep'];
  const content=inspectToolCallFromOutput({content:observed,reasoning:'arbitrary reasoning text'},allowed);
  assert.equal(content.reason,'accepted');
  assert.equal(content.source,'content');
  assert.equal(content.toolCall.function.name,'Glob');
  assert.deepEqual(JSON.parse(content.toolCall.function.arguments),{pattern:'**/InteractiveStars.tsx'});
  assert.equal(parseToolCallFromOutput({content:observed,reasoning:'arbitrary reasoning text'},allowed).function.name,'Glob');
  const padded=inspectToolCallFromOutput({content:` \r\n${observed}\n\t`,reasoning:''},allowed);
  assert.equal(padded.reason,'accepted');
  assert.equal(padded.source,'content');

  const shadowed=inspectToolCallFromOutput({content:'ordinary final prose',reasoning:observed},allowed);
  assert.equal(shadowed.toolCall,null);
  assert.equal(shadowed.source,'content');
  assert.equal(shadowed.reason,'invalid_json');
  assert.equal(shadowed.metadata.reasoning_contains_tool_call_marker,true);
  assert.equal(parseToolCallFromOutput({content:'ordinary final prose',reasoning:observed},allowed),null);

  const reasoning=inspectToolCallFromOutput({content:'  \r\n ',reasoning:observed},allowed);
  assert.equal(reasoning.reason,'accepted');
  assert.equal(reasoning.source,'reasoning');
  assert.equal(reasoning.toolCall.function.name,'Glob');

  const invalidOutput=inspectToolCallFromOutput(null,allowed);
  assert.equal(invalidOutput.source,'none');
  assert.equal(invalidOutput.reason,'invalid_output');
  const invalidContent=inspectToolCallFromOutput({content:{},reasoning:observed},allowed);
  assert.equal(invalidContent.source,'none');
  assert.equal(invalidContent.reason,'input_not_string');
});

test('tool inspection reports exact basic and extra-text rejection reasons',()=>{
  const strict=jsonToolCall('Glob',{pattern:'**/*.tsx'});
  const cases=[
    [null,'input_not_string'],
    ['', 'empty_input'],
    ['   \r\n', 'empty_input'],
    ['{broken', 'invalid_json'],
    [`prefix prose ${strict}`, 'invalid_json'],
    [`${strict} suffix prose`, 'invalid_json'],
    [`[调用 Glob] ${strict}`, 'invalid_json'],
  ];
  for(const [source,reason] of cases)assert.equal(inspectToolCall(source,['Glob']).reason,reason);
});

test('tool inspection reports strict envelope and tool-shape rejection reasons',()=>{
  const cases=[
    [{tool_call:{name:'Glob',arguments:{}},extra:1},'unexpected_envelope_keys'],
    [{name:'Glob',arguments:{}},'unexpected_envelope_keys'],
    [{tool_call:{name:'Glob',arguments:{},extra:1}},'invalid_tool_shape'],
    [{tool_call:[]},'invalid_tool_shape'],
    [[], 'invalid_envelope'],
    [null, 'invalid_envelope'],
    ['json string', 'invalid_envelope'],
  ];
  for(const [value,reason] of cases){
    const source=JSON.stringify(value);
    assert.equal(inspectToolCall(source,['Glob']).reason,reason,source);
  }
});

test('tool inspection distinguishes name, allowlist and argument failures',()=>{
  assert.equal(inspectToolCall(jsonToolCall('UnknownTool',{}),['Glob']).reason,'tool_not_allowed');
  for(const name of ['bad name','bad/name'])assert.equal(inspectToolCall(jsonToolCall(name,{}),[name]).reason,'invalid_tool_name');
  for(const args of [[],null,'x'])assert.equal(inspectToolCall(jsonToolCall('Glob',args),['Glob']).reason,'arguments_not_object');
  for(const rawArgs of [
    '{"__proto__":{"polluted":true}}',
    '{"safe":{"constructor":{"polluted":true}}}',
    '{"items":[{"prototype":{"polluted":true}}]}',
  ])assert.equal(inspectToolCall(`{"tool_call":{"name":"Glob","arguments":${rawArgs}}}`,['Glob']).reason,'unsafe_arguments');
});

test('tool inspection distinguishes excessive nesting and both byte limits',()=>{
  let tooDeep={value:'ok'};
  for(let index=0;index<MAX_NESTING_DEPTH+1;index+=1)tooDeep={next:tooDeep};
  assert.equal(inspectToolCall(jsonToolCall('Glob',tooDeep),['Glob']).reason,'excessive_nesting');
  assert.equal(inspectToolCall('x'.repeat(MAX_TOOL_BYTES+1),['Glob']).reason,'input_too_large');

  const loneSurrogates='\ud800'.repeat(Math.floor(MAX_TOOL_BYTES/3)-100);
  const expandingArguments=`{"tool_call":{"name":"Glob","arguments":{"value":"${loneSurrogates}"}}}`;
  assert.ok(Buffer.byteLength(expandingArguments)<=MAX_TOOL_BYTES);
  assert.equal(inspectToolCall(expandingArguments,['Glob']).reason,'arguments_too_large');
});

test('tool output inspection exposes only structural byte and marker signals',()=>{
  const strict=jsonToolCall('Glob',{pattern:'**/*.tsx'});
  const fenced=`\n\`\`\`json\n${strict}\n\`\`\`\n`;
  const fence=inspectToolCallFromOutput({content:fenced,reasoning:''},['Glob']);
  assert.equal(fence.reason,'invalid_json');
  assert.equal(fence.source,'content');
  assert.equal(fence.metadata.content_starts_with_code_fence,true);
  assert.equal(fence.metadata.content_contains_tool_call_marker,true);
  assert.equal(fence.metadata.content_bytes,Buffer.byteLength(fenced));
  assert.equal(fence.metadata.content_trimmed_bytes,Buffer.byteLength(fenced.trim()));

  const marked=inspectToolCallFromOutput({content:`[调用 Glob] ${strict}`,reasoning:'ordinary'},['Glob']);
  assert.equal(marked.reason,'invalid_json');
  assert.equal(marked.metadata.content_starts_with_brace,false);
  assert.equal(marked.metadata.content_ends_with_brace,true);
  assert.equal(marked.metadata.content_contains_tool_call_marker,true);
});
test('tool retry decision is limited to the first reasoning-only result with tools',()=>{
  const output={content:' ',reasoning:'I need a file'};
  assert.equal(shouldRetryToolResponse({hasTools:true,output,toolCall:null,retryCount:0}),true);
  assert.equal(shouldRetryToolResponse({hasTools:false,output,toolCall:null,retryCount:0}),false);
  assert.equal(shouldRetryToolResponse({hasTools:true,output,toolCall:{},retryCount:0}),false);
  assert.equal(shouldRetryToolResponse({hasTools:true,output:{content:'final',reasoning:'why'},toolCall:null,retryCount:0}),false);
  assert.equal(shouldRetryToolResponse({hasTools:true,output,toolCall:null,retryCount:1}),false);
});
test('fenced tool retry predicate accepts only the proven selected-content shape',()=>{
  const allowed=['Glob'];
  const inspection=inspectToolCallFromOutput({content:fencedToolCall('Glob',{}),reasoning:'ordinary reasoning'},allowed);
  const base={hasTools:true,toolCall:null,retryCount:0,inspection};
  assert.equal(inspection.reason,'invalid_json');
  assert.equal(shouldRetryFencedToolResponse(base),true);

  const negatives=[
    {...base,hasTools:false},
    {...base,toolCall:{}},
    {...base,retryCount:1},
    {...base,inspection:{...inspection,source:'reasoning'}},
    {...base,inspection:{...inspection,reason:'tool_not_allowed'}},
    {...base,inspection:{...inspection,reason:'invalid_envelope'}},
    {...base,inspection:{...inspection,metadata:{...inspection.metadata,content_starts_with_code_fence:false}}},
    {...base,inspection:{...inspection,metadata:{...inspection.metadata,content_contains_tool_call_marker:false}}},
    {...base,inspection:inspectToolCallFromOutput({content:'ordinary prose',reasoning:''},allowed)},
    {...base,inspection:inspectToolCallFromOutput({content:`[调用 Glob] ${jsonToolCall('Glob',{})}`,reasoning:''},allowed)},
    {...base,inspection:inspectToolCallFromOutput({content:'```json\n{"example":true}\n```',reasoning:''},allowed)},
    {...base,inspection:inspectToolCallFromOutput({content:'ordinary content',reasoning:fencedToolCall('Glob',{})},allowed)},
    {...base,inspection:inspectToolCallFromOutput({content:'',reasoning:fencedToolCall('Glob',{})},allowed)},
    {...base,inspection:inspectToolCallFromOutput({content:jsonToolCall('UnknownTool',{}),reasoning:''},allowed)},
    {...base,inspection:inspectToolCallFromOutput({content:'[]',reasoning:''},allowed)},
  ];
  for(const item of negatives)assert.equal(shouldRetryFencedToolResponse(item),false);
});
test('corrective tool prompt is bounded to allowed names and retry reasoning is hidden',()=>{
  const prompt=createToolRetryPrompt(['read_file','glob','bad name','read_file']);
  assert.match(prompt,/strict JSON tool call/);
  assert.match(prompt,/\["read_file","glob"\]/);
  assert.doesNotMatch(prompt,/bad name/);
  assert.deepEqual(hideRetryReasoning({content:'final answer',reasoning:'private'},null),{content:'final answer',reasoning:''});
  assert.equal(hideRetryReasoning({content:'',reasoning:'private'},null).content,TOOL_RETRY_FAILURE_MESSAGE);
});
test('fenced correction prompt is static, strict and contains only safe allowed names',()=>{
  const prompt=createFencedToolRetryPrompt(['Glob','Read','bad name','Glob']);
  assert.match(prompt,/intended tool call/);
  assert.match(prompt,/exactly one strict JSON object/);
  assert.match(prompt,/Do not use Markdown or code fences/);
  assert.match(prompt,/\["Glob","Read"\]/);
  assert.doesNotMatch(prompt,/bad name|TOP_SECRET_ARGUMENT|private\\secret/);
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

function fetchFailure(name,code,message='fetch failed https://secret.example/private?token=TOKEN_SECRET'){
  const error=new Error(message);
  error.name=name;
  if(code)error.cause={code,message:'cause details must not be logged'};
  return error;
}

test('checked preserves only safe network metadata without changing retry policy',async()=>{
  const cases=[
    ['TypeError','ENOTFOUND',undefined],
    ['TypeError','EAI_AGAIN',undefined],
    ['TypeError','ECONNREFUSED',undefined],
    ['TypeError','ECONNRESET',undefined],
    ['TypeError','ERR_TLS_CERT_ALTNAME_INVALID',undefined],
    ['TypeError','ETIMEDOUT',undefined],
    ['TimeoutError',null,true],
    ['AbortError',null,true],
  ];
  for(const [name,code,retryable] of cases){
    let caught;
    try{await checked('https://must-not-be-logged.example/private',{method:'GET'},100,async()=>{throw fetchFailure(name,code);});}
    catch(error){caught=error;}
    assert.ok(caught);
    assert.equal(caught.causeCode,code||undefined);
    assert.equal(caught.retryable,retryable);
    assert.equal(caught.status,name==='TimeoutError'||name==='AbortError'?504:undefined);
    assert.doesNotMatch(caught.message,/https?:|TOKEN_SECRET|private/);
  }
});

test('upstream error diagnostics classify only safe provable metadata',async()=>{
  const cases=[
    {name:'TypeError',code:'ENOTFOUND',stage:'remote_session_start',category:'dns',status:null,retryable:false,timeout:false},
    {name:'TypeError',code:'EAI_AGAIN',stage:'challenge_start',category:'dns',status:null,retryable:false,timeout:false},
    {name:'TypeError',code:'ECONNREFUSED',stage:'completion_start',category:'connect',status:null,retryable:false,timeout:false},
    {name:'TypeError',code:'ECONNRESET',stage:'completion_start',category:'connect',status:null,retryable:false,timeout:false},
    {name:'TypeError',code:'ERR_TLS_CERT_ALTNAME_INVALID',stage:'remote_session_start',category:'tls',status:null,retryable:false,timeout:false},
    {name:'TypeError',code:'ETIMEDOUT',stage:'wasm_download_start',category:'timeout',status:null,retryable:false,timeout:true},
    {name:'TimeoutError',stage:'completion_start',category:'timeout',status:504,retryable:true,timeout:true},
    {name:'AbortError',stage:'challenge_start',category:'timeout',status:504,retryable:true,timeout:true},
  ];
  for(const item of cases){
    let error;
    try{await checked('https://must-not-be-logged.example/private',{method:'GET'},100,async()=>{throw fetchFailure(item.name,item.code);});}
    catch(caught){error=caught;}
    const lines=[];
    const callbacks=requestDiagnostics(lines);
    callbacks.onError(error,{stage:item.stage,attempt:2,maxAttempts:3});
    const record=diagnosticRecords(lines).find(value=>value.event==='upstream_error');
    assert.deepEqual(record,{
      event:'upstream_error',request_ref:'0011223344556677',stage:item.stage,error_name:item.name,error_category:item.category,status:item.status,
      cause_code:item.code||null,retryable:item.retryable,timeout:item.timeout,attempt:2,max_attempts:3,
    });
  }

  for(const status of [403,429,500]){
    let error;
    try{await checked('https://must-not-be-logged.example/private',{method:'POST'},100,async()=>new Response('UPSTREAM_BODY_SECRET',{status,headers:status===429?{'retry-after':'1'}:{}}));}
    catch(caught){error=caught;}
    const lines=[];
    const callbacks=requestDiagnostics(lines);
    callbacks.onError(error,{stage:'completion_start',attempt:1,maxAttempts:3});
    const record=diagnosticRecords(lines).find(value=>value.event==='upstream_error');
    assert.equal(record.error_category,'http');
    assert.equal(record.status,status);
    assert.equal(record.retryable,status===429||status>=500);
    assert.equal(record.timeout,false);
    assert.equal(record.cause_code,null);
    assert.equal(record.attempt,1);
    assert.equal(record.max_attempts,3);
  }
  assert.equal(classifyUpstreamError(new Error('compile failed'),'wasm_compile_start').error_category,'pow');
  const wasmHttp=new Error('PoW WASM HTTP 403');wasmHttp.upstreamStatus=403;
  assert.deepEqual(classifyUpstreamError(wasmHttp,'wasm_download_start'),{
    stage:'wasm_download_start',error_name:'Error',error_category:'http',status:403,cause_code:null,retryable:false,timeout:false,
  });
  assert.equal(classifyUpstreamError(fetchFailure('TypeError','ENOTFOUND'),'wasm_download_start').error_category,'dns');
});

test('HTTP errors discard arbitrary upstream response bodies',async()=>{
  const secret='UPSTREAM_BODY_SECRET https://secret.example/private C:\\private\\file.txt token=TOKEN_SECRET';
  let caught;
  try{await checked('https://must-not-be-logged.example/private',{method:'POST'},100,async()=>new Response(secret,{status:500}));}
  catch(error){caught=error;}
  assert.ok(caught);
  assert.equal(caught.status,500);
  assert.equal(caught.retryable,true);
  assert.equal(caught.message,'DeepSeek Web HTTP 500');
  assert.doesNotMatch(caught.message,/UPSTREAM_BODY_SECRET|https?:|private|TOKEN_SECRET/);
});

test('PoW WASM loader forwards safe network code and HTTP status metadata',async t=>{
  const originalFetch=global.fetch;
  t.after(()=>{global.fetch=originalFetch;});
  global.fetch=async()=>{throw fetchFailure('TypeError','ENOTFOUND');};
  let networkError;
  try{await solvePOW({challenge:'c',salt:'s',expire_at:1,difficulty:1},'https://wasm-network-secret.example/private.wasm',100);}
  catch(error){networkError=error;}
  assert.equal(networkError.message,'fetch failed');
  assert.equal(networkError.causeCode,'ENOTFOUND');
  assert.doesNotMatch(networkError.message,/https?:|private/);

  global.fetch=async()=>new Response('UPSTREAM_WASM_BODY_SECRET',{status:403});
  let httpError;
  try{await solvePOW({challenge:'c',salt:'s',expire_at:1,difficulty:1},'https://wasm-http-secret.example/private.wasm',100);}
  catch(error){httpError=error;}
  assert.equal(httpError.upstreamStatus,403);
  assert.equal(httpError.message,'PoW WASM HTTP 403');
  assert.doesNotMatch(httpError.message,/UPSTREAM_WASM_BODY_SECRET|https?:|private/);
});

function syntheticPowInstance(answer=42){
  const memory=new WebAssembly.Memory({initial:1});
  let allocation=64;
  return {exports:{
    memory,
    __wbindgen_export_0(length){const pointer=allocation;allocation+=length;return pointer;},
    __wbindgen_add_to_stack_pointer(){return 0;},
    wasm_solve(){const view=new DataView(memory.buffer);view.setInt32(0,1,true);view.setFloat64(8,answer,true);},
  }};
}

test('production PoW cache keeps cold owner, concurrent waiter and warm hit stages request-local',async t=>{
  const originalFetch=global.fetch;
  const originalCompile=WebAssembly.compile;
  const originalInstantiate=WebAssembly.instantiate;
  t.after(()=>{global.fetch=originalFetch;WebAssembly.compile=originalCompile;WebAssembly.instantiate=originalInstantiate;});
  let fetches=0,compiles=0,releaseCompile,compileStarted;
  const compileGate=new Promise(resolve=>{releaseCompile=resolve;});
  const compileReady=new Promise(resolve=>{compileStarted=resolve;});
  global.fetch=async()=>{fetches+=1;return new Response(new Uint8Array([0,97,115,109]),{status:200});};
  WebAssembly.compile=async()=>{compiles+=1;compileStarted();await compileGate;return {synthetic:true};};
  WebAssembly.instantiate=async()=>syntheticPowInstance();
  const challenge={challenge:'c',salt:'s',expire_at:1,difficulty:1};
  const ownerStages=[],waiterStages=[],warmStages=[];
  const owner=solvePOW(challenge,'https://pow-cache-success.test/module.wasm',1000,stage=>ownerStages.push(stage));
  await compileReady;
  const waiter=solvePOW(challenge,'https://pow-cache-success.test/module.wasm',1000,stage=>waiterStages.push(stage));
  releaseCompile();
  assert.deepEqual(await Promise.all([owner,waiter]),[42,42]);
  assert.equal(await solvePOW(challenge,'https://pow-cache-success.test/module.wasm',1000,stage=>warmStages.push(stage)),42);
  assert.equal(fetches,1);
  assert.equal(compiles,1);
  assert.deepEqual(ownerStages,[
    'wasm_download_start','wasm_downloaded','wasm_compile_start','wasm_compiled','pow_solve_start','pow_solved',
  ]);
  assert.deepEqual(waiterStages,['wasm_wait_shared','wasm_compiled','pow_solve_start','pow_solved']);
  assert.deepEqual(warmStages,['wasm_cache_hit','pow_solve_start','pow_solved']);
});

test('production PoW shared download failure keeps request callbacks and failure stage separate',async t=>{
  const originalFetch=global.fetch;
  t.after(()=>{global.fetch=originalFetch;});
  let fetches=0,rejectFetch,fetchStarted;
  const started=new Promise(resolve=>{fetchStarted=resolve;});
  global.fetch=()=>{fetches+=1;fetchStarted();return new Promise((resolve,reject)=>{rejectFetch=reject;});};
  const challenge={challenge:'c',salt:'s',expire_at:1,difficulty:1};
  const ownerStages=[],waiterStages=[];
  const owner=solvePOW(challenge,'https://pow-cache-download-failure.test/module.wasm',1000,stage=>ownerStages.push(stage));
  await started;
  const waiter=solvePOW(challenge,'https://pow-cache-download-failure.test/module.wasm',1000,stage=>waiterStages.push(stage));
  rejectFetch(fetchFailure('TypeError','ENOTFOUND'));
  const results=await Promise.allSettled([owner,waiter]);
  assert.equal(fetches,1);
  assert.deepEqual(ownerStages,['wasm_download_start']);
  assert.deepEqual(waiterStages,['wasm_wait_shared']);
  assert.ok(results.every(result=>result.status==='rejected'));
  assert.ok(results.every(result=>result.reason.causeCode==='ENOTFOUND'));
  assert.ok(results.every(result=>result.reason.upstreamStage==='wasm_download_start'));
});

test('production PoW shared compile failure reports the compile phase to every waiter',async t=>{
  const originalFetch=global.fetch;
  const originalCompile=WebAssembly.compile;
  t.after(()=>{global.fetch=originalFetch;WebAssembly.compile=originalCompile;});
  let fetches=0,compiles=0,rejectCompile,compileStarted;
  const started=new Promise(resolve=>{compileStarted=resolve;});
  global.fetch=async()=>{fetches+=1;return new Response(new Uint8Array([0,97,115,109]),{status:200});};
  WebAssembly.compile=()=>{compiles+=1;compileStarted();return new Promise((resolve,reject)=>{rejectCompile=reject;});};
  const challenge={challenge:'c',salt:'s',expire_at:1,difficulty:1};
  const ownerStages=[],waiterStages=[];
  const owner=solvePOW(challenge,'https://pow-cache-compile-failure.test/module.wasm',1000,stage=>ownerStages.push(stage));
  await started;
  const waiter=solvePOW(challenge,'https://pow-cache-compile-failure.test/module.wasm',1000,stage=>waiterStages.push(stage));
  rejectCompile(new WebAssembly.CompileError('synthetic compile failure'));
  const results=await Promise.allSettled([owner,waiter]);
  assert.equal(fetches,1);
  assert.equal(compiles,1);
  assert.deepEqual(ownerStages,['wasm_download_start','wasm_downloaded','wasm_compile_start']);
  assert.deepEqual(waiterStages,['wasm_wait_shared']);
  assert.ok(results.every(result=>result.status==='rejected'));
  assert.ok(results.every(result=>result.reason.upstreamStage==='wasm_compile_start'));
});

test('production PoW stage callback failures remain observational',async t=>{
  const originalFetch=global.fetch;
  const originalCompile=WebAssembly.compile;
  const originalInstantiate=WebAssembly.instantiate;
  t.after(()=>{global.fetch=originalFetch;WebAssembly.compile=originalCompile;WebAssembly.instantiate=originalInstantiate;});
  global.fetch=async()=>new Response(new Uint8Array([0,97,115,109]),{status:200});
  WebAssembly.compile=async()=>({synthetic:true});
  WebAssembly.instantiate=async()=>syntheticPowInstance(7);
  const challenge={challenge:'c',salt:'s',expire_at:1,difficulty:1};
  assert.equal(await solvePOW(challenge,'https://pow-callback-safety.test/module.wasm',1000,()=>{throw new Error('diagnostic callback failed');}),7);
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
    onStage('wasm_download_start');
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

async function toolRetryProxyCase({path='/v1/chat/completions',body,completeImpl,logger,sessionStore,sessionResolver,headers={}}){
  const config={host:'127.0.0.1',port:0,key:'',maxBytes:1024*1024,timeoutMs:5000,origins:new Set()};
  const server=createProxyServer({config,completeImpl,logger,sessionStore,sessionResolver});
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
  const sessions=new SessionStore();
  const firstReasoning='PRIVATE_FIRST_REASONING_NEED_READ';
  const result=await toolRetryProxyCase({
    sessionStore:sessions,
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
  assert.equal(sessions.list().length,1);
  assert.match(sessions.list()[0].key,/^anonymous:/);
  assert.notEqual(sessions.list()[0].key,'default');
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
  let resolvedSession;
  const result=await toolRetryProxyCase({
    sessionStore:sessions,headers:{'x-agent-session':'retry-history'},logger:()=>{},
    body:{model:'deepseek-reasoner',messages:[{role:'user',content:'finish'}],tools:[{type:'function',function:{name:'read_file'}}]},
    completeImpl:async options=>{calls+=1;resolvedSession=options.session;return calls===1?{content:'',reasoning:firstReasoning,parentMessageId:'one'}:{content:'final answer after retry',reasoning:'should stay private',parentMessageId:'two'};},
  });
  const response=JSON.parse(result.text);
  assert.equal(calls,2);
  assert.equal(response.choices[0].message.content,'final answer after retry');
  assert.equal(response.choices[0].message.reasoning_content,undefined);
  assert.doesNotMatch(result.text,new RegExp(firstReasoning));
  const history=resolvedSession.history;
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

test('a second fenced response stops after one correction and hides malformed output',async()=>{
  let calls=0;
  const malformed=fencedToolCall('Glob',{pattern:'**/InteractiveStars.tsx'});
  const result=await toolRetryProxyCase({
    logger:()=>{},
    body:{model:'deepseek-reasoner',messages:[{role:'user',content:'find component'}],tools:[{type:'function',function:{name:'Glob'}}]},
    completeImpl:async()=>{calls+=1;return {content:malformed,reasoning:`PRIVATE_FENCED_REASONING_${calls}`,parentMessageId:String(calls)};},
  });
  const response=JSON.parse(result.text);
  assert.equal(calls,2);
  assert.equal(response.choices[0].message.content,TOOL_RETRY_FAILURE_MESSAGE);
  assert.equal(response.choices[0].message.reasoning_content,undefined);
  assert.doesNotMatch(result.text,/tool_call|InteractiveStars|PRIVATE_FENCED_REASONING/);
});

test('fenced correction consumes the shared budget before a reasoning-only response',async()=>{
  let calls=0;
  const result=await toolRetryProxyCase({
    logger:()=>{},
    body:{model:'deepseek-reasoner',messages:[{role:'user',content:'find component'}],tools:[{type:'function',function:{name:'Glob'}}]},
    completeImpl:async()=>{
      calls+=1;
      return calls===1
        ? {content:fencedToolCall('Glob',{}),reasoning:'initial reasoning',parentMessageId:'one'}
        : {content:'',reasoning:'PRIVATE_SECOND_REASONING',parentMessageId:'two'};
    },
  });
  const response=JSON.parse(result.text);
  assert.equal(calls,2);
  assert.equal(response.choices[0].message.content,TOOL_RETRY_FAILURE_MESSAGE);
  assert.doesNotMatch(result.text,/PRIVATE_SECOND_REASONING|tool_call/);
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

async function withAgenticCycleServer(completeImpl,run,{sessions=new SessionStore(),sessionResolver}={}){
  const config={host:'127.0.0.1',port:0,key:'',maxBytes:1024*1024,timeoutMs:5000,origins:new Set()};
  const server=createProxyServer({config,sessionStore:sessions,sessionResolver,logger:()=>{},completeImpl});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const post=async(path,body,agentSession)=>{
    const headers={'content-type':'application/json'};
    if(agentSession!==undefined)headers['x-agent-session']=agentSession;
    const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:'POST',headers,body:JSON.stringify(body)});
    const responseText=await response.text();
    assert.equal(response.status,200,responseText);
    return {contentType:response.headers.get('content-type'),text:responseText,json:()=>JSON.parse(responseText)};
  };
  try{return await run({post,sessions});}
  finally{server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
}

test('tool continuation sends only the current real result instead of duplicated client history',async()=>{
  const calls=[];
  const originalTask='ORIGINAL_ECHO_TASK_BEFORE_CONTINUATION';
  const resultText='REAL_ECHO_RESULT_FOR_CONTINUATION';
  await withAgenticCycleServer(async options=>{
    calls.push(options);
    if(calls.length===1){
      options.session.id='remote-regression';
      options.session.parentMessageId='parent-tool';
      return {content:jsonToolCall('echo',{text:'probe'}),reasoning:'',parentMessageId:'parent-tool'};
    }
    return {content:'continuation complete',reasoning:'PRIVATE_CONTINUATION_REASONING',parentMessageId:'parent-final'};
  },async({post})=>{
    const tools=[{type:'function',function:{name:'echo',parameters:{type:'object'}}}];
    const first=(await post('/v1/chat/completions',{model:'deepseek-chat',messages:[{role:'user',content:originalTask}],tools},'continuation-regression')).json();
    const call=first.choices[0].message.tool_calls[0];
    const continued=await post('/v1/chat/completions',{model:'deepseek-chat',messages:[
      {role:'user',content:originalTask},
      {role:'assistant',content:null,tool_calls:[call]},
      {role:'tool',name:'echo',tool_call_id:call.id,content:resultText},
    ],tools},'continuation-regression');
    assert.doesNotMatch(continued.text,/PRIVATE_CONTINUATION_REASONING/);
  });
  assert.equal(calls.length,2);
  assert.equal(calls[0].session,calls[1].session);
  assert.equal(calls[1].session.parentMessageId,'parent-tool');
  assert.doesNotMatch(calls[1].prompt,new RegExp(originalTask));
  assert.doesNotMatch(calls[1].prompt,/assistant: \[Tool Call\]/);
  assert.match(calls[1].prompt,/TOOL RESULT CONTINUATION/);
  assert.match(calls[1].prompt,/\[Completed Tool Result\]/);
  assert.match(calls[1].prompt,new RegExp(resultText));
  assert.equal(calls[1].prompt.split(resultText).length-1,1);
  assert.doesNotMatch(calls[1].prompt,/TOOL REQUEST SYSTEM/);
});

test('OpenAI tool result continuation preserves name, call id, result, session and streaming',async()=>{
  const calls=[];
  const marker='OPENAI_TOOL_RESULT_MARKER';
  await withAgenticCycleServer(async options=>{
    calls.push(options);
    if(calls.length===1){options.session.id='remote-openai';options.session.parentMessageId='parent-tool';return {content:jsonToolCall('echo',{text:'request'}),reasoning:'PRIVATE_FIRST_REASONING',parentMessageId:'parent-tool'};}
    assert.equal(options.session.parentMessageId,'parent-tool');
    options.onDelta({content:marker});
    options.session.parentMessageId='parent-final';
    return {content:marker,reasoning:'',parentMessageId:'parent-final'};
  },async({post,sessions})=>{
    const tools=[{type:'function',function:{name:'echo',parameters:{type:'object'}}}];
    const first=(await post('/v1/chat/completions',{model:'deepseek-chat',messages:[{role:'user',content:'use echo'}],tools},'openai-cycle')).json();
    const call=first.choices[0].message.tool_calls[0];
    assert.equal(calls[0].session.history.length,0);
    const second=await post('/v1/chat/completions',{model:'deepseek-chat',stream:true,messages:[
      {role:'user',content:'use echo'},
      {role:'assistant',content:null,tool_calls:[call]},
      {role:'tool',name:'echo',tool_call_id:call.id,content:'client executed echo safely'},
    ],tools},'openai-cycle');
    assert.equal(calls.length,2);
    assert.equal(calls[0].session,calls[1].session);
    assert.doesNotMatch(calls[1].prompt,/user: use echo|\[Tool Call\]/);
    assert.match(calls[1].prompt,/Completed Tool Result[\s\S]*name: echo/);
    assert.match(calls[1].prompt,new RegExp(`call_id: ${call.id}`));
    assert.match(calls[1].prompt,/Tool Result[\s\S]*client executed echo safely/);
    assert.match(second.contentType,/^text\/event-stream/);
    assert.match(second.text,new RegExp(marker));
    assert.doesNotMatch(second.text,/PRIVATE_FIRST_REASONING/);
    assert.equal(calls[0].session.history.length,1);
    assert.equal(calls[0].session.history[0].assistant,marker);
  });
});

test('Anthropic tool_result continuation preserves tool_use id, name and result',async()=>{
  const calls=[];
  const marker='ANTHROPIC_TOOL_RESULT_MARKER';
  await withAgenticCycleServer(async options=>{
    calls.push(options);
    if(calls.length===1){options.session.id='remote-anthropic';options.session.parentMessageId='parent-tool';return {content:jsonToolCall('echo',{text:'request'}),reasoning:'PRIVATE_FIRST_REASONING',parentMessageId:'parent-tool'};}
    return {content:marker,reasoning:'',parentMessageId:'parent-final'};
  },async({post,sessions})=>{
    const tools=[{name:'echo',input_schema:{type:'object'}}];
    const first=(await post('/v1/messages',{model:'deepseek-chat',max_tokens:64,messages:[{role:'user',content:'use echo'}],tools},'anthropic-cycle')).json();
    const call=first.content[0];
    assert.equal(call.type,'tool_use');
    assert.equal(calls[0].session.history.length,0);
    const second=(await post('/v1/messages',{model:'deepseek-chat',max_tokens:64,messages:[
      {role:'user',content:'use echo'},
      {role:'assistant',content:[call]},
      {role:'user',content:[{type:'tool_result',tool_use_id:call.id,content:'client executed echo safely'}]},
    ],tools},'anthropic-cycle')).json();
    assert.equal(calls.length,2);
    assert.equal(calls[0].session,calls[1].session);
    assert.doesNotMatch(calls[1].prompt,/use echo|\[Tool Call\]/);
    assert.match(calls[1].prompt,/Completed Tool Result[\s\S]*name: echo/);
    assert.match(calls[1].prompt,new RegExp(`call_id: ${call.id}`));
    assert.match(calls[1].prompt,/Tool Result[\s\S]*client executed echo safely/);
    assert.equal(second.content[0].text,marker);
    assert.doesNotMatch(JSON.stringify(second),/PRIVATE_FIRST_REASONING/);
  });
});

test('Responses function_call_output continuation preserves call id, name and result',async()=>{
  const calls=[];
  const marker='RESPONSES_TOOL_RESULT_MARKER';
  await withAgenticCycleServer(async options=>{
    calls.push(options);
    if(calls.length===1){options.session.id='remote-responses';options.session.parentMessageId='parent-tool';return {content:jsonToolCall('echo',{text:'request'}),reasoning:'PRIVATE_FIRST_REASONING',parentMessageId:'parent-tool'};}
    return {content:marker,reasoning:'',parentMessageId:'parent-final'};
  },async({post,sessions})=>{
    const tools=[{type:'function',name:'echo',parameters:{type:'object'}}];
    const first=(await post('/v1/responses',{model:'deepseek-chat',input:'use echo',tools},'responses-cycle')).json();
    const call=first.output[0];
    assert.equal(call.type,'function_call');
    assert.equal(calls[0].session.history.length,0);
    const second=(await post('/v1/responses',{model:'deepseek-chat',previous_response_id:first.id,input:[
      {type:'function_call_output',call_id:call.call_id,output:'client executed echo safely'},
    ],tools},'responses-cycle')).json();
    assert.equal(calls.length,2);
    assert.equal(calls[0].session,calls[1].session);
    assert.match(calls[1].prompt,/Tool Result[\s\S]*name: echo/);
    assert.match(calls[1].prompt,new RegExp(`call_id: ${call.call_id}`));
    assert.match(calls[1].prompt,/Tool Result[\s\S]*client executed echo safely/);
    assert.equal(second.output[0].content[0].text,marker);
    assert.doesNotMatch(JSON.stringify(second),/PRIVATE_FIRST_REASONING/);
  });
});

test('two sequential OpenAI tools preserve distinct ids and arguments without a retry',async()=>{
  const calls=[];
  await withAgenticCycleServer(async options=>{
    calls.push(options);
    if(calls.length===1)return {content:jsonToolCall('first_tool',{value:'one'}),reasoning:'',parentMessageId:'one'};
    if(calls.length===2)return {content:jsonToolCall('second_tool',{value:'two'}),reasoning:'',parentMessageId:'two'};
    return {content:'two tools completed',reasoning:'',parentMessageId:'three'};
  },async({post})=>{
    const tools=['first_tool','second_tool'].map(name=>({type:'function',function:{name,parameters:{type:'object'}}}));
    const base=[{role:'user',content:'use two tools'}];
    const first=(await post('/v1/chat/completions',{model:'deepseek-chat',messages:base,tools},'two-tools')).json();
    const callOne=first.choices[0].message.tool_calls[0];
    const messagesTwo=[...base,{role:'assistant',content:null,tool_calls:[callOne]},{role:'tool',name:'first_tool',tool_call_id:callOne.id,content:'result-one'}];
    const second=(await post('/v1/chat/completions',{model:'deepseek-chat',messages:messagesTwo,tools},'two-tools')).json();
    const callTwo=second.choices[0].message.tool_calls[0];
    assert.notEqual(callOne.id,callTwo.id);
    assert.deepEqual(JSON.parse(callOne.function.arguments),{value:'one'});
    assert.deepEqual(JSON.parse(callTwo.function.arguments),{value:'two'});
    const third=(await post('/v1/chat/completions',{model:'deepseek-chat',messages:[...messagesTwo,{role:'assistant',content:null,tool_calls:[callTwo]},{role:'tool',name:'second_tool',tool_call_id:callTwo.id,content:'result-two'}],tools},'two-tools')).json();
    assert.equal(calls.length,3);
    assert.match(calls[2].prompt,new RegExp(`name: second_tool[\\s\\S]*call_id: ${callTwo.id}[\\s\\S]*result-two`));
    assert.doesNotMatch(calls[2].prompt,new RegExp(`call_id: ${callOne.id}|result-one`));
    assert.equal(third.choices[0].message.content,'two tools completed');
  });
});

test('exact completed tool matching is protocol-neutral and canonicalizes argument order',()=>{
  const session={toolCalls:new Map([['call_shared',{name:'echo',arguments:'{"b":2,"a":1}'}]])};
  const bodies={
    openai:{messages:[{role:'tool',name:'echo',tool_call_id:'call_shared',content:'openai result'}]},
    anthropic:{messages:[{role:'user',content:[{type:'tool_result',tool_use_id:'call_shared',content:'anthropic result'}]}]},
    responses:{input:[{type:'function_call_output',call_id:'call_shared',output:'responses result'}]},
  };
  for(const [kind,body] of Object.entries(bodies)){
    const results=extractToolResults(body,kind,session);
    assert.equal(results[0].callId,'call_shared');
    assert.equal(results[0].name,'echo');
    assert.equal(isExactCompletedToolCall({function:{name:'echo',arguments:'{"a":1,"b":2}'}},results),true);
    assert.equal(isExactCompletedToolCall({function:{name:'echo',arguments:'{"a":1,"b":3}'}},results),false);
  }
});

test('an exact repeated completed tool call gets one hidden corrective retry',async()=>{
  const calls=[];
  const finalMarker='EXACT_REPEAT_CORRECTED_FINAL';
  await withAgenticCycleServer(async options=>{
    calls.push(options);
    if(calls.length===1){
      options.session.id='remote-exact-repeat';
      options.session.parentMessageId='parent-tool';
      return {content:jsonToolCall('echo',{text:'same'}),reasoning:'',parentMessageId:'parent-tool'};
    }
    if(calls.length===2)return {content:jsonToolCall('echo',{text:'same'}),reasoning:'',parentMessageId:'parent-repeat'};
    options.onDelta({content:finalMarker});
    return {content:finalMarker,reasoning:'PRIVATE_CORRECTIVE_REASONING',parentMessageId:'parent-final'};
  },async({post})=>{
    const tools=[{type:'function',function:{name:'echo',parameters:{type:'object'}}}];
    const first=(await post('/v1/chat/completions',{model:'deepseek-reasoner',messages:[{role:'user',content:'echo once'}],tools},'exact-repeat')).json();
    const call=first.choices[0].message.tool_calls[0];
    const second=await post('/v1/chat/completions',{model:'deepseek-reasoner',stream:true,messages:[
      {role:'user',content:'echo once'},
      {role:'assistant',content:null,tool_calls:[call]},
      {role:'tool',name:'echo',tool_call_id:call.id,content:'same'},
    ],tools},'exact-repeat');
    assert.equal(calls.length,3);
    assert.equal(calls[0].session,calls[1].session);
    assert.equal(calls[1].session,calls[2].session);
    assert.equal(calls[1].session.parentMessageId,'parent-tool');
    assert.equal(calls[2].model.reasoning,false);
    assert.equal(calls[2].model.search,false);
    assert.match(calls[2].prompt,/already executed the tool call you just repeated/);
    assert.match(second.text,new RegExp(finalMarker));
    assert.doesNotMatch(second.text,/PRIVATE_CORRECTIVE_REASONING|already executed the tool call|tool_call/);
  });
});

test('a second exact repetition stops safely without a third corrective attempt',async()=>{
  const calls=[];
  await withAgenticCycleServer(async options=>{
    calls.push(options);
    if(calls.length===1){
      options.session.id='remote-repeat-limit';
      options.session.parentMessageId='parent-tool';
    }
    return {content:jsonToolCall('echo',{text:'same'}),reasoning:'PRIVATE_REPEAT_REASONING',parentMessageId:`parent-${calls.length}`};
  },async({post})=>{
    const tools=[{type:'function',function:{name:'echo',parameters:{type:'object'}}}];
    const first=(await post('/v1/chat/completions',{model:'deepseek-chat',messages:[{role:'user',content:'echo once'}],tools},'repeat-limit')).json();
    const call=first.choices[0].message.tool_calls[0];
    const second=(await post('/v1/chat/completions',{model:'deepseek-chat',messages:[
      {role:'tool',name:'echo',tool_call_id:call.id,content:'same'},
    ],tools},'repeat-limit')).json();
    assert.equal(calls.length,3);
    assert.equal(second.choices[0].message.content,REPEATED_TOOL_FAILURE_MESSAGE);
    assert.equal(second.choices[0].message.tool_calls,undefined);
    assert.doesNotMatch(JSON.stringify(second),/PRIVATE_REPEAT_REASONING/);
  });
});

test('the same tool with different arguments remains a valid next tool call',async()=>{
  const calls=[];
  await withAgenticCycleServer(async options=>{
    calls.push(options);
    return calls.length===1
      ? {content:jsonToolCall('echo',{text:'first'}),reasoning:'',parentMessageId:'parent-first'}
      : {content:jsonToolCall('echo',{text:'second'}),reasoning:'',parentMessageId:'parent-second'};
  },async({post})=>{
    const tools=[{type:'function',function:{name:'echo',parameters:{type:'object'}}}];
    const first=(await post('/v1/chat/completions',{model:'deepseek-chat',messages:[{role:'user',content:'echo twice'}],tools},'different-args')).json();
    const call=first.choices[0].message.tool_calls[0];
    const second=(await post('/v1/chat/completions',{model:'deepseek-chat',messages:[
      {role:'tool',name:'echo',tool_call_id:call.id,content:'first'},
    ],tools},'different-args')).json();
    assert.equal(calls.length,2);
    assert.equal(second.choices[0].finish_reason,'tool_calls');
    assert.deepEqual(JSON.parse(second.choices[0].message.tool_calls[0].function.arguments),{text:'second'});
  });
});

test('different x-agent-session values never share the same session object',async()=>{
  const seen=new Map();
  await withAgenticCycleServer(async options=>{
    const key=options.prompt.includes('agent A')?'A':'B';
    if(!seen.has(key))seen.set(key,options.session);
    else assert.equal(seen.get(key),options.session);
    return {content:`final ${key}`,reasoning:'',parentMessageId:key};
  },async({post})=>{
    await post('/v1/chat/completions',{model:'deepseek-chat',messages:[{role:'user',content:'agent A'}]},'agent-A');
    await post('/v1/chat/completions',{model:'deepseek-chat',messages:[{role:'user',content:'agent B'}]},'agent-B');
    await post('/v1/chat/completions',{model:'deepseek-chat',messages:[{role:'user',content:'agent A'}]},'agent-A');
    assert.notEqual(seen.get('A'),seen.get('B'));
  });
});

test('metadata.user_id, user and x-agent-session select stable sessions with header priority',async()=>{
  const calls=[];
  await withAgenticCycleServer(async options=>{calls.push(options);return {content:'ok',reasoning:'',parentMessageId:String(calls.length)};},async({post})=>{
    const request=(label,extra={},header)=>post('/v1/chat/completions',{model:'deepseek-chat',messages:[{role:'user',content:label}],...extra},header);
    await request('metadata one',{metadata:{user_id:'metadata-id'}});
    await request('metadata two',{metadata:{user_id:'metadata-id'}});
    await request('user one',{user:'user-id'});
    await request('user two',{user:'user-id'});
    await request('header one',{metadata:{user_id:'metadata-a'},user:'user-a'},'header-id');
    await request('header two',{metadata:{user_id:'metadata-b'},user:'user-b'},'header-id');
  });
  assert.equal(calls[0].session,calls[1].session);
  assert.equal(calls[2].session,calls[3].session);
  assert.equal(calls[4].session,calls[5].session);
  assert.notEqual(calls[0].session,calls[2].session);
  assert.notEqual(calls[0].session,calls[4].session);
});

test('sequential and parallel anonymous HTTP requests always use isolated sessions',async()=>{
  const calls=[];
  await withAgenticCycleServer(async options=>{calls.push(options);return {content:'anonymous final',reasoning:'',parentMessageId:null};},async({post})=>{
    const body=label=>({model:'deepseek-chat',messages:[{role:'user',content:label}]});
    await post('/v1/chat/completions',body('anonymous one'));
    await post('/v1/chat/completions',body('anonymous two'));
    await Promise.all([
      post('/v1/chat/completions',body('anonymous parallel A')),
      post('/v1/chat/completions',body('anonymous parallel B')),
    ]);
  });
  assert.equal(calls.length,4);
  assert.equal(new Set(calls.map(call=>call.session)).size,4);
});

async function anonymousToolContinuationCase(kind){
  const calls=[];
  const resolver=new SessionResolver();
  await withAgenticCycleServer(async options=>{
    calls.push(options);
    if(calls.length===1){options.session.id=`remote-${kind}`;options.session.parentMessageId='parent-tool';return {content:jsonToolCall('echo',{value:kind}),reasoning:'',parentMessageId:'parent-tool'};}
    return {content:`${kind} final`,reasoning:'',parentMessageId:'parent-final'};
  },async({post})=>{
    if(kind==='openai'){
      const tools=[{type:'function',function:{name:'echo',parameters:{type:'object'}}}];
      const first=(await post('/v1/chat/completions',{model:'deepseek-chat',messages:[{role:'user',content:'use echo'}],tools})).json();
      const call=first.choices[0].message.tool_calls[0];
      assert.equal(resolver.size,1);
      const second=(await post('/v1/chat/completions',{model:'deepseek-chat',messages:[{role:'tool',name:'echo',tool_call_id:call.id,content:'openai result'}],tools})).json();
      assert.equal(second.choices[0].message.content,'openai final');
    }else if(kind==='anthropic'){
      const tools=[{name:'echo',input_schema:{type:'object'}}];
      const first=(await post('/v1/messages',{model:'deepseek-chat',max_tokens:64,messages:[{role:'user',content:'use echo'}],tools})).json();
      const call=first.content[0];
      assert.equal(resolver.size,1);
      const second=(await post('/v1/messages',{model:'deepseek-chat',max_tokens:64,messages:[{role:'user',content:[{type:'tool_result',tool_use_id:call.id,content:'anthropic result'}]}],tools})).json();
      assert.equal(second.content[0].text,'anthropic final');
    }else{
      const tools=[{type:'function',name:'echo',parameters:{type:'object'}}];
      const first=(await post('/v1/responses',{model:'deepseek-chat',input:'use echo',tools})).json();
      const call=first.output[0];
      assert.equal(resolver.size,1);
      const second=(await post('/v1/responses',{model:'deepseek-chat',input:[{type:'function_call_output',call_id:call.call_id,output:'responses result'}],tools})).json();
      assert.equal(second.output[0].content[0].text,'responses final');
    }
  },{sessionResolver:resolver});
  assert.equal(calls.length,2);
  assert.equal(calls[0].session,calls[1].session);
  assert.equal(calls[1].session.parentMessageId,'parent-tool');
  assert.equal(resolver.size,0);
}

test('anonymous tool results resume their bound OpenAI, Anthropic and Responses sessions',async t=>{
  await t.test('OpenAI tool_call_id',()=>anonymousToolContinuationCase('openai'));
  await t.test('Anthropic tool_use_id',()=>anonymousToolContinuationCase('anthropic'));
  await t.test('Responses call_id',()=>anonymousToolContinuationCase('responses'));
});

test('unknown and expired call ids start new isolated sessions',async t=>{
  await t.test('unknown call id',async()=>{
    const calls=[];
    const resolver=new SessionResolver();
    await withAgenticCycleServer(async options=>{calls.push(options);return calls.length===1?{content:jsonToolCall('echo',{}),reasoning:'',parentMessageId:'tool'}:{content:'safe final',reasoning:'',parentMessageId:'final'};},async({post})=>{
      const tools=[{type:'function',function:{name:'echo'}}];
      await post('/v1/chat/completions',{model:'deepseek-chat',messages:[{role:'user',content:'use echo'}],tools});
      await post('/v1/chat/completions',{model:'deepseek-chat',messages:[{role:'tool',name:'echo',tool_call_id:'call_unknown',content:'unknown result'}],tools});
    },{sessionResolver:resolver});
    assert.notEqual(calls[0].session,calls[1].session);
  });
  await t.test('expired call id',async()=>{
    let now=0;
    const calls=[];
    const resolver=new SessionResolver({ttlMs:5,now:()=>now});
    let callId;
    await withAgenticCycleServer(async options=>{calls.push(options);return calls.length===1?{content:jsonToolCall('echo',{}),reasoning:'',parentMessageId:'tool'}:{content:'safe final',reasoning:'',parentMessageId:'final'};},async({post})=>{
      const tools=[{type:'function',function:{name:'echo'}}];
      const first=(await post('/v1/chat/completions',{model:'deepseek-chat',messages:[{role:'user',content:'use echo'}],tools})).json();
      callId=first.choices[0].message.tool_calls[0].id;
      now=6;
      await post('/v1/chat/completions',{model:'deepseek-chat',messages:[{role:'tool',name:'echo',tool_call_id:callId,content:'late result'}],tools});
    },{sessionResolver:resolver});
    assert.notEqual(calls[0].session,calls[1].session);
    assert.equal(resolver.size,0);
  });
});

test('/v1/sessions exposes only bounded opaque keys and session metadata',async()=>{
  const sessions=new SessionStore();
  const config={host:'127.0.0.1',port:0,key:'',maxBytes:1024*1024,timeoutMs:5000,origins:new Set()};
  const server=createProxyServer({config,sessionStore:sessions,logger:()=>{},completeImpl:async()=>({content:'safe final',reasoning:'',parentMessageId:null})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const secretSession='Bearer-session-secret';
  const secretPrompt='PRIVATE_FILE_CONTENT_MARKER';
  try{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json','x-agent-session':secretSession,authorization:'Bearer authorization-secret',cookie:'session=cookie-secret'},body:JSON.stringify({model:'deepseek-chat',messages:[{role:'user',content:secretPrompt}]})});
    assert.equal(response.status,200);
    const listing=await (await fetch(`http://127.0.0.1:${server.address().port}/v1/sessions`)).text();
    assert.doesNotMatch(listing,/Bearer-session-secret|authorization-secret|cookie-secret|PRIVATE_FILE_CONTENT_MARKER|token|cookie|authorization|default/i);
    const parsed=JSON.parse(listing);
    assert.match(parsed.data[0].key,/^explicit:header:[a-f0-9]{32}$/);
    assert.deepEqual(Object.keys(parsed.data[0]).sort(),['key','remote_session','turns','updated_at'].sort());
  }finally{
    server.closeAllConnections?.();
    await new Promise(resolve=>server.close(resolve));
  }
});

async function withCountTokensServer(run,{maxBytes=1024*1024,host='127.0.0.1',key=''}={}){
  const sessions=new SessionStore();
  let completionCalls=0;
  const config={host,port:0,key,maxBytes,timeoutMs:5000,origins:new Set()};
  const server=createProxyServer({config,sessionStore:sessions,logger:()=>{},completeImpl:async()=>{completionCalls+=1;return {content:'unexpected',reasoning:'',parentMessageId:null};}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const request=async({method='POST',body,raw,headers={}}={})=>{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/messages/count_tokens`,{method,headers:{...(method==='POST'?{'content-type':'application/json'}:{}),...headers},...(method==='POST'?{body:raw===undefined?JSON.stringify(body):raw}:{})});
    const text=await response.text();
    return {status:response.status,headers:response.headers,text,json:()=>JSON.parse(text)};
  };
  try{return await run({request,sessions,getCompletionCalls:()=>completionCalls,port:server.address().port});}
  finally{server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
}

test('POST /v1/messages/count_tokens returns a local Anthropic-compatible estimate',async()=>{
  await withCountTokensServer(async({request,sessions,getCompletionCalls})=>{
    const body={
      model:'deepseek-chat',
      system:[{type:'text',text:'system prompt'}],
      messages:[
        {role:'user',content:[{type:'text',text:'English русский 中文 😀'}]},
        {role:'assistant',content:[{type:'thinking',thinking:'private thought'},{type:'tool_use',id:'toolu_local',name:'echo',input:{value:'probe'}}]},
        {role:'user',content:[{type:'tool_result',tool_use_id:'toolu_local',content:'probe result'}]},
      ],
      tools:[{name:'echo',description:'Return a value',input_schema:{type:'object',properties:{value:{type:'string'}}}}],
    };
    const result=await request({body});
    assert.equal(result.status,200,result.text);
    assert.equal(result.headers.get('x-deepseek-bridge-token-count'),'estimate');
    assert.deepEqual(Object.keys(result.json()),['input_tokens']);
    assert.ok(Number.isInteger(result.json().input_tokens));
    assert.ok(result.json().input_tokens>=0);
    assert.equal(getCompletionCalls(),0);
    assert.equal(sessions.list().length,0);
  });
});

test('count_tokens handles empty, malformed, wrong-method and secret-bearing requests safely',async()=>{
  await withCountTokensServer(async({request,sessions,getCompletionCalls})=>{
    const empty=await request({body:{}});
    assert.equal(empty.status,400);
    assert.deepEqual(empty.json(),{type:'error',error:{type:'invalid_request_error',message:'model is required and must be a non-empty string.'}});
    const malformed=await request({raw:'{"model":"deepseek-chat","messages":['});
    assert.equal(malformed.status,400);
    assert.equal(malformed.json().type,'error');
    assert.equal(malformed.json().error.type,'invalid_request_error');
    const method=await request({method:'GET'});
    assert.equal(method.status,405);
    const secret='Bearer bearer-secret token=token-secret cookie=cookie-secret authorization=auth-secret';
    const invalid=await request({body:{model:{secret},messages:[]},headers:{authorization:secret}});
    assert.equal(invalid.status,400);
    assert.doesNotMatch(invalid.text,/bearer-secret|token-secret|cookie-secret|auth-secret/);
    assert.equal(getCompletionCalls(),0);
    assert.equal(sessions.list().length,0);
  });
});

test('count_tokens keeps the existing request-size limit',async()=>{
  await withCountTokensServer(async({request,sessions,getCompletionCalls})=>{
    const result=await request({body:{model:'deepseek-chat',messages:[{role:'user',content:'x'.repeat(512)}]}});
    assert.equal(result.status,413);
    assert.equal(result.json().type,'error');
    assert.equal(result.json().error.type,'request_too_large');
    assert.equal(getCompletionCalls(),0);
    assert.equal(sessions.list().length,0);
  },{maxBytes:128});
});

test('count_tokens reuses local authorization and CORS enforcement',async()=>{
  const key='local-count-key-that-is-long-enough';
  await withCountTokensServer(async({request,getCompletionCalls})=>{
    const body={model:'deepseek-chat',messages:[]};
    const unauthorized=await request({body});
    assert.equal(unauthorized.status,401);
    assert.equal(unauthorized.json().type,'error');
    assert.equal(unauthorized.json().error.type,'authentication_error');
    const forbidden=await request({body,headers:{authorization:`Bearer ${key}`,origin:'https://localhost.evil.example'}});
    assert.equal(forbidden.status,403);
    assert.equal(forbidden.json().error.type,'permission_error');
    const allowed=await request({body,headers:{authorization:`Bearer ${key}`,origin:'http://localhost:3000'}});
    assert.equal(allowed.status,200);
    assert.equal(allowed.headers.get('access-control-allow-origin'),'http://localhost:3000');
    assert.equal(getCompletionCalls(),0);
  },{host:'0.0.0.0',key});
});

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

const diagnosticConfig={host:'127.0.0.1',port:0,key:'',maxBytes:1024*1024,timeoutMs:5000,origins:new Set()};
function diagnosticRecords(lines){return lines.flatMap(line=>{try{const record=JSON.parse(line);return record?.event?[record]:[];}catch{return [];}});}
function createDiagnosticsEnabledServer(options){
  const previous=process.env.BRIDGE_TOOL_DIAGNOSTICS;
  process.env.BRIDGE_TOOL_DIAGNOSTICS='1';
  try{return createProxyServer({config:diagnosticConfig,...options});}
  finally{if(previous===undefined)delete process.env.BRIDGE_TOOL_DIAGNOSTICS;else process.env.BRIDGE_TOOL_DIAGNOSTICS=previous;}
}
async function withDiagnosticsServer(options,run){
  const server=createDiagnosticsEnabledServer(options);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const post=async(route,body,headers={})=>{
    const response=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
    const responseText=await response.text();
    assert.equal(response.status,200,responseText);
    return {contentType:response.headers.get('content-type'),text:responseText,json:()=>JSON.parse(responseText)};
  };
  try{return await run(post);}
  finally{server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
}

test('tool diagnostics are disabled by default',async()=>{
  const previous=process.env.BRIDGE_TOOL_DIAGNOSTICS;
  delete process.env.BRIDGE_TOOL_DIAGNOSTICS;
  const lines=[];
  let server;
  try{server=createProxyServer({config:diagnosticConfig,logger:line=>lines.push(line),completeImpl:async()=>({content:'ordinary final',reasoning:'',parentMessageId:null})});}
  finally{if(previous===undefined)delete process.env.BRIDGE_TOOL_DIAGNOSTICS;else process.env.BRIDGE_TOOL_DIAGNOSTICS=previous;}
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'deepseek-chat',messages:[{role:'user',content:'offline'}]})});
    assert.equal(response.status,200);
    assert.equal(diagnosticRecords(lines).length,0);
  }finally{server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
});

test('one HTTP request shares a private request_ref across all diagnostic events only',async()=>{
  const lines=[];
  let completionOptions;
  let payload;
  await withDiagnosticsServer({logger:line=>lines.push(line),completeImpl:async options=>{
    completionOptions=options;
    options.onStage?.('completion_start',{attempt:1,maxAttempts:1});
    return {content:'request ref final',reasoning:'',parentMessageId:null};
  }},async post=>{
    payload=(await post('/v1/chat/completions',{model:'deepseek-chat',messages:[{role:'user',content:'offline request ref'}]})).json();
  });
  const records=diagnosticRecords(lines);
  const request=records.find(record=>record.event==='tool_request');
  const response=records.find(record=>record.event==='tool_response');
  const stage=records.find(record=>record.event==='upstream_stage');
  assert.match(request.request_ref,/^[a-f0-9]{16}$/);
  assert.equal(response.request_ref,request.request_ref);
  assert.equal(stage.request_ref,request.request_ref);
  assert.equal(stage.stage,'completion_start');
  assert.equal(Object.prototype.hasOwnProperty.call(completionOptions,'requestRef'),false);
  assert.equal(JSON.stringify(payload).includes(request.request_ref),false);
});

test('parallel HTTP requests always receive distinct request_ref values',async()=>{
  const lines=[];
  let arrivals=0;
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  await withDiagnosticsServer({logger:line=>lines.push(line),completeImpl:async()=>{
    arrivals+=1;
    if(arrivals===2)release();
    await gate;
    return {content:'parallel final',reasoning:'',parentMessageId:null};
  }},async post=>{
    await Promise.all([
      post('/v1/chat/completions',{model:'deepseek-chat',messages:[{role:'user',content:'parallel one'}]}),
      post('/v1/chat/completions',{model:'deepseek-chat',messages:[{role:'user',content:'parallel two'}]}),
    ]);
  });
  const records=diagnosticRecords(lines);
  const requests=records.filter(record=>record.event==='tool_request');
  assert.equal(requests.length,2);
  assert.equal(new Set(requests.map(record=>record.request_ref)).size,2);
  for(const request of requests){
    assert.equal(records.filter(record=>record.request_ref===request.request_ref&&record.event==='tool_response').length,1);
  }
});

test('fetch failed diagnostics and ordinary logger expose no request or network secrets',async()=>{
  const lines=[];
  const secretValues=[
    'PROMPT_SECRET','REASONING_SECRET','ARGUMENT_SECRET','TOOL_RESULT_SECRET','SESSION_ID_SECRET','CALL_ID_SECRET',
    'TOKEN_SECRET','COOKIE_SECRET','AUTHORIZATION_SECRET','UPSTREAM_BODY_SECRET','synthetic-token','synthetic-cookie','C:\\private\\marker.txt',
    'https://secret.example/private?token=TOKEN_SECRET',
  ];
  const completeImpl=options=>complete({
    ...options,auth:{token:'synthetic-token',cookie:'synthetic-cookie'},solvePow:async()=>7,
    fetchImpl:async()=>{throw fetchFailure('TypeError','ENOTFOUND',`${secretValues[13]} ${secretValues[9]}`);},
    sleep:async()=>{},
  });
  const server=createDiagnosticsEnabledServer({logger:line=>lines.push(line),completeImpl});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let responseText;
  try{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`,{
      method:'POST',
      headers:{'content-type':'application/json','x-claude-code-session-id':secretValues[4],authorization:`Bearer ${secretValues[8]}`,cookie:secretValues[7]},
      body:JSON.stringify({
        model:'deepseek-chat',messages:[{role:'user',content:`${secretValues[0]} ${secretValues[12]} ${secretValues[3]}`}],
        tools:[{name:'Read',description:secretValues[1],input_schema:{type:'object',description:secretValues[2]}}],
      }),
    });
    responseText=await response.text();
    assert.equal(response.status,502);
    assert.match(responseText,/DeepSeek request failed/);
  }finally{
    server.closeAllConnections?.();
    await new Promise(resolve=>server.close(resolve));
  }
  const records=diagnosticRecords(lines);
  const request=records.find(record=>record.event==='tool_request');
  const error=records.find(record=>record.event==='upstream_error');
  const toolResponse=records.find(record=>record.event==='tool_response');
  assert.equal(error.request_ref,request.request_ref);
  assert.equal(toolResponse.request_ref,request.request_ref);
  assert.deepEqual({...error,request_ref:'ref'}, {
    event:'upstream_error',request_ref:'ref',stage:'remote_session_start',error_name:'TypeError',error_category:'dns',
    status:null,cause_code:'ENOTFOUND',retryable:false,timeout:false,attempt:1,max_attempts:3,
  });
  assert.equal(responseText.includes(request.request_ref),false);
  const journal=lines.join('\n');
  assert.match(journal,/\[deepseek-bridge\] request error: fetch failed/);
  for(const secret of secretValues)assert.equal(journal.includes(secret),false,secret);
  assert.doesNotMatch(journal,/https?:\/\/|[A-Z]:\\/);
});

test('production server sanitizes stream reader errors before diagnostics, logger and API response',async()=>{
  const lines=[];
  const urlMarker='STREAM_URL_SECRET_MARKER';
  const pathMarker='STREAM_PATH_SECRET_MARKER';
  const rawMessage=`reader failed https://secret.example/path?token=${urlMarker} C:\\Users\\Sensitive\\${pathMarker}.txt`;
  const streamError=fetchFailure('TypeError','ECONNRESET',rawMessage);
  const stream=new ReadableStream({start(controller){controller.error(streamError);}});
  const responses=[upstreamSessionResponse('stream-logger-session'),upstreamChallengeResponse(),new Response(stream,{status:200})];
  const completeImpl=options=>complete({
    ...options,auth:{token:'synthetic-token',cookie:'synthetic-cookie'},
    fetchImpl:async()=>responses.shift(),solvePow:async()=>7,maxRetries:0,
  });
  const server=createDiagnosticsEnabledServer({logger:line=>lines.push(line),completeImpl});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let responseText;
  try{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({model:'deepseek-chat',messages:[{role:'user',content:'offline stream logger test'}]}),
    });
    responseText=await response.text();
    assert.equal(response.status,502);
    assert.match(responseText,/DeepSeek request failed/);
  }finally{
    server.closeAllConnections?.();
    await new Promise(resolve=>server.close(resolve));
  }
  const journal=lines.join('\n');
  for(const secret of [urlMarker,pathMarker,'secret.example','C:\\Users\\Sensitive']){
    assert.equal(journal.includes(secret),false,secret);
    assert.equal(responseText.includes(secret),false,secret);
  }
  assert.match(journal,/\[deepseek-bridge\] request error: Upstream stream read failed/);
  const error=diagnosticRecords(lines).find(record=>record.event==='upstream_error');
  assert.deepEqual({...error,request_ref:'ref'}, {
    event:'upstream_error',request_ref:'ref',stage:'stream_read',error_name:'TypeError',error_category:'stream',
    status:null,cause_code:'ECONNRESET',retryable:false,timeout:false,attempt:1,max_attempts:1,
  });
});

test('parallel HTTP requests retain distinct request_ref on one shared WASM failure',async t=>{
  const localFetch=global.fetch;
  let rejectWasm,sessionSequence=0,wasmFetches=0;
  const wasmFailure=()=>fetchFailure('TypeError','ENOTFOUND');
  global.fetch=()=>{wasmFetches+=1;return new Promise((resolve,reject)=>{rejectWasm=reject;});};
  t.after(()=>{global.fetch=localFetch;});
  const lines=[];
  const upstreamFetch=async url=>{
    if(String(url).includes('chat_session/create'))return upstreamSessionResponse(`parallel-wasm-${++sessionSequence}`);
    if(String(url).includes('create_pow_challenge')){
      return upstreamChallengeResponse();
    }
    throw new Error('unexpected completion request');
  };
  const completeImpl=options=>complete({
    ...options,auth:{token:'synthetic-token',cookie:'synthetic-cookie',wasmUrl:'https://parallel-wasm-failure.test/module.wasm'},
    fetchImpl:upstreamFetch,maxRetries:0,
  });
  const server=createDiagnosticsEnabledServer({logger:line=>{
    lines.push(line);
    try{
      const record=JSON.parse(line);
      if(record.event==='upstream_stage'&&record.stage==='wasm_wait_shared')queueMicrotask(()=>rejectWasm(wasmFailure()));
    }catch{}
  },completeImpl});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const post=content=>localFetch(`http://127.0.0.1:${server.address().port}/v1/messages`,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({model:'deepseek-chat',messages:[{role:'user',content}]}),
    });
    const responses=await Promise.all([post('parallel wasm one'),post('parallel wasm two')]);
    assert.deepEqual(responses.map(response=>response.status),[502,502]);
    await Promise.all(responses.map(response=>response.text()));
  }finally{
    server.closeAllConnections?.();
    await new Promise(resolve=>server.close(resolve));
  }
  assert.equal(wasmFetches,1);
  const records=diagnosticRecords(lines);
  const requests=records.filter(record=>record.event==='tool_request');
  const errors=records.filter(record=>record.event==='upstream_error');
  assert.equal(requests.length,2);
  assert.equal(errors.length,2);
  assert.equal(new Set(requests.map(record=>record.request_ref)).size,2);
  assert.deepEqual(new Set(errors.map(record=>record.request_ref)),new Set(requests.map(record=>record.request_ref)));
  assert.ok(errors.every(record=>record.stage==='wasm_download_start'));
  assert.ok(errors.every(record=>record.error_category==='dns'&&record.cause_code==='ENOTFOUND'));
  const requestStages=requests.map(request=>records.filter(record=>record.request_ref===request.request_ref&&record.event==='upstream_stage').map(record=>record.stage));
  assert.equal(requestStages.filter(stages=>stages.includes('wasm_download_start')).length,1);
  assert.equal(requestStages.filter(stages=>stages.includes('wasm_wait_shared')).length,1);
});

test('tool diagnostics are bounded and never break requests when logging fails',()=>{
  const lines=[];
  const diagnostics=createToolDiagnostics({enabled:true,logger:line=>lines.push(line)});
  const manyTools=Array.from({length:MAX_TOOL_NAMES+10},(_,index)=>({function:{name:index===0?`Read\n${'x'.repeat(MAX_TOOL_NAME_CHARS+20)}`:index===1?{invalid:true}:`tool_${index}`}}));
  const response=diagnostics.request({protocol:'openai',route:'/v1/chat/completions',body:{model:'deepseek-chat',tools:manyTools},upstreamSource:'anonymous',upstreamKey:'anonymous:private',clientSessionSource:'unavailable',clientSessionKey:null,toolResultCount:0});
  response.response({outcome:'final_text',contentNonempty:true});
  const records=diagnosticRecords(lines);
  assert.equal(records[0].tool_names.length,MAX_TOOL_NAMES);
  assert.equal(records[0].tool_names[0],'invalid');
  assert.equal(records[0].tool_names[1],'invalid');
  assert.equal(records[0].client_session_source,'unavailable');
  assert.equal(records[0].client_session_ref,null);
  const wrongLines=[];
  const wrong=createToolDiagnostics({enabled:true,logger:line=>wrongLines.push(line)});
  assert.doesNotThrow(()=>wrong.request({protocol:'anthropic',route:'/v1/messages',body:{model:'deepseek-chat',tools:{unexpected:true}},upstreamSource:'anonymous',upstreamKey:'private',clientSessionSource:'unavailable',clientSessionKey:null}));
  assert.equal(diagnosticRecords(wrongLines)[0].tools_field_shape,'object');
  assert.equal(diagnosticRecords(wrongLines)[0].raw_tool_count,0);
  const failing=createToolDiagnostics({enabled:true,logger:()=>{throw new Error('logger failed');}});
  assert.doesNotThrow(()=>failing.request({protocol:'anthropic',route:'/v1/messages',body:{model:'deepseek-chat',tools:[]},upstreamSource:'anonymous',upstreamKey:'private',clientSessionSource:'unavailable',clientSessionKey:null}));
});

test('tool diagnostics accept only safe identifier-shaped tool names',()=>{
  const marker='PRINTABLE_TOOL_SECRET_MARKER';
  const lines=[];
  const diagnostics=createToolDiagnostics({enabled:true,logger:line=>lines.push(line),randomBytes:()=>Buffer.alloc(8,4)});
  diagnostics.request({
    protocol:'anthropic',route:'/v1/messages',body:{model:'deepseek-chat',tools:[
      {name:'Read'},{name:'Glob'},{name:'ListMcpResourcesTool'},
      {name:'mcp__context7__resolve-library-id'},
      {name:`https://secret.example/${marker}`},
      {name:`C:\\Users\\X\\${marker}`},
      {name:`Bearer ${marker}`},
      {name:`tool ${marker}`},
      {name:`tool\n${marker}`},
    ]},
    upstreamSource:'anonymous',upstreamKey:'private',clientSessionSource:'unavailable',clientSessionKey:null,
  });
  const record=diagnosticRecords(lines)[0];
  assert.deepEqual(record.tool_names,[
    'Read','Glob','ListMcpResourcesTool','mcp__context7__resolve-library-id',
    'invalid','invalid','invalid','invalid','invalid',
  ]);
  assert.equal(JSON.stringify(record).includes(marker),false);
  assert.equal(JSON.stringify(record).includes('secret.example'),false);
});

function upstreamSessionResponse(id){return new Response(JSON.stringify({data:{biz_data:{id}}}),{status:200});}
function upstreamChallengeResponse(){return new Response(JSON.stringify(doctorChallenge()),{status:200});}
function upstreamStreamResponse(content='ok'){
  return new Response(`data: ${JSON.stringify({p:'response/content',v:content})}\n`,{status:200,headers:{'content-type':'text/event-stream'}});
}
function requestDiagnostics(lines,requestRef='0011223344556677'){
  const diagnostics=createToolDiagnostics({enabled:true,logger:line=>lines.push(line)});
  const request=diagnostics.request({
    protocol:'anthropic',route:'/v1/messages',requestRef,
    body:{model:'deepseek-chat',messages:[{role:'user',content:'PROMPT_MUST_NOT_LEAK'}]},
    upstreamSource:'anonymous',upstreamKey:'anonymous:SESSION_MUST_NOT_LEAK',
    clientSessionSource:'claude_header',clientSessionKey:'client:SESSION_MUST_NOT_LEAK',
    isToolContinuation:false,toolResultCount:0,
  });
  return {
    request,
    onStage:(stage,metadata)=>request.stage(stage,metadata),
    onError:(error,metadata)=>request.upstreamError(error,metadata),
  };
}
function powStages(challenge,url,timeout,onStage){
  onStage('wasm_download_start');
  onStage('wasm_downloaded');
  onStage('wasm_compile_start');
  onStage('wasm_compiled');
  onStage('pow_solve_start');
  onStage('pow_solved');
  return 7;
}

test('upstream_stage follows the real session, PoW, completion and stream path',async()=>{
  const lines=[];
  const callbacks=requestDiagnostics(lines);
  const responses=[upstreamSessionResponse('stage-session'),upstreamChallengeResponse(),upstreamStreamResponse('stage final')];
  const result=await complete({
    prompt:'offline',session:{id:null,parentMessageId:null,history:[]},
    model:{model_type:'default',reasoning:false,search:false},auth:{token:'synthetic',cookie:'synthetic'},
    fetchImpl:async()=>responses.shift(),solvePow:powStages,maxRetries:0,
    onStage:callbacks.onStage,onError:callbacks.onError,
  });
  callbacks.request.response({outcome:'final_text',contentNonempty:true});
  assert.equal(result.content,'stage final');
  const records=diagnosticRecords(lines);
  const stages=records.filter(record=>record.event==='upstream_stage');
  assert.deepEqual(stages.map(record=>record.stage),[
    'remote_session_start','remote_session_created','challenge_start','challenge_received',
    'wasm_download_start','wasm_downloaded','wasm_compile_start','wasm_compiled',
    'pow_solve_start','pow_solved','completion_start','completion_completed',
    'stream_received','stream_read','stream_parsed',
  ]);
  assert.ok(stages.every(record=>record.request_ref==='0011223344556677'));
  assert.ok(stages.every(record=>Object.keys(record).sort().join(',')==='event,request_ref,stage'));
});

test('throwing upstream stage callbacks cannot change a successful completion',async()=>{
  const responses=[upstreamSessionResponse('callback-session'),upstreamChallengeResponse(),upstreamStreamResponse('callback safe')];
  const result=await complete({
    prompt:'offline',session:{id:null,parentMessageId:null,history:[]},
    model:{model_type:'default',reasoning:false,search:false},auth:{token:'synthetic',cookie:'synthetic'},
    fetchImpl:async()=>responses.shift(),solvePow:powStages,maxRetries:0,
    onStage:()=>{throw new Error('diagnostic stage callback failed');},
  });
  assert.equal(result.content,'callback safe');
});

test('stream reader failures remain stream errors even with a network cause code',async()=>{
  const lines=[];
  const callbacks=requestDiagnostics(lines,'1122334455667788');
  const stream=new ReadableStream({start(controller){controller.error(fetchFailure('TypeError','ECONNRESET'));}});
  const responses=[upstreamSessionResponse('stream-session'),upstreamChallengeResponse(),new Response(stream,{status:200})];
  await assert.rejects(()=>complete({
    prompt:'offline',session:{id:null,parentMessageId:null,history:[]},
    model:{model_type:'default',reasoning:false,search:false},auth:{token:'synthetic',cookie:'synthetic'},
    fetchImpl:async()=>responses.shift(),solvePow:async()=>7,
    onStage:callbacks.onStage,onError:callbacks.onError,sleep:async()=>{},
  }));
  callbacks.request.response({outcome:'upstream_error'});
  const error=diagnosticRecords(lines).find(record=>record.event==='upstream_error');
  assert.deepEqual(error,{
    event:'upstream_error',request_ref:'1122334455667788',stage:'stream_read',error_name:'TypeError',
    error_category:'stream',status:null,cause_code:'ECONNRESET',retryable:false,timeout:false,attempt:1,max_attempts:3,
  });
});

test('stream timeout evidence is independent from the primary stream category',()=>{
  const cases=[
    {error:fetchFailure('AbortError'),timeout:true,cause:null},
    {error:fetchFailure('TimeoutError'),timeout:true,cause:null},
    {error:fetchFailure('TypeError','ETIMEDOUT'),timeout:true,cause:'ETIMEDOUT'},
    {error:fetchFailure('TypeError','ECONNRESET'),timeout:false,cause:'ECONNRESET'},
  ];
  for(const item of cases){
    const result=classifyUpstreamError(item.error,'stream_read');
    assert.equal(result.error_category,'stream');
    assert.equal(result.timeout,item.timeout);
    assert.equal(result.cause_code,item.cause);
  }
});

test('existing retry can recover under one request_ref without policy changes',async()=>{
  const lines=[];
  const callbacks=requestDiagnostics(lines,'2233445566778899');
  const responses=[
    upstreamSessionResponse('retry-session-1'),upstreamChallengeResponse(),new Response('RETRY_BODY_SECRET',{status:500}),
    upstreamSessionResponse('retry-session-2'),upstreamChallengeResponse(),upstreamStreamResponse('retry recovered'),
  ];
  const waits=[];
  const result=await complete({
    prompt:'offline',session:{id:null,parentMessageId:null,history:[]},
    model:{model_type:'default',reasoning:false,search:false},auth:{token:'synthetic',cookie:'synthetic'},
    fetchImpl:async()=>responses.shift(),solvePow:async()=>7,sleep:async ms=>waits.push(ms),
    onStage:callbacks.onStage,onError:callbacks.onError,
  });
  callbacks.request.response({outcome:'final_text',contentNonempty:true});
  assert.equal(result.content,'retry recovered');
  assert.deepEqual(waits,[500]);
  const records=diagnosticRecords(lines);
  const errors=records.filter(record=>record.event==='upstream_error');
  assert.equal(errors.length,1);
  assert.deepEqual(errors[0],{
    event:'upstream_error',request_ref:'2233445566778899',stage:'completion_start',error_name:'DeepSeekUpstreamError',
    error_category:'http',status:500,cause_code:null,retryable:true,timeout:false,attempt:1,max_attempts:3,
  });
  assert.ok(records.some(record=>record.event==='upstream_stage'&&record.stage==='remote_session_start'));
  assert.equal(records.at(-1).event,'tool_response');
  assert.equal(records.at(-1).request_ref,'2233445566778899');
  assert.doesNotMatch(lines.join('\n'),/RETRY_BODY_SECRET/);
});

test('retry exhaustion reports every existing attempt and preserves the safe final error',async()=>{
  const lines=[];
  const callbacks=requestDiagnostics(lines,'33445566778899aa');
  const responses=[];
  for(let attempt=1;attempt<=3;attempt+=1){
    responses.push(upstreamSessionResponse(`exhausted-${attempt}`),upstreamChallengeResponse(),new Response(`UPSTREAM_BODY_SECRET_${attempt}`,{status:500}));
  }
  let finalError;
  try{
    await complete({
      prompt:'offline',session:{id:null,parentMessageId:null,history:[]},
      model:{model_type:'default',reasoning:false,search:false},auth:{token:'synthetic',cookie:'synthetic'},
      fetchImpl:async()=>responses.shift(),solvePow:async()=>7,sleep:async()=>{},
      onStage:callbacks.onStage,onError:callbacks.onError,
    });
  }catch(error){finalError=error;}
  callbacks.request.response({outcome:'upstream_error'});
  assert.equal(finalError.message,'DeepSeek Web HTTP 500');
  const errors=diagnosticRecords(lines).filter(record=>record.event==='upstream_error');
  assert.deepEqual(errors.map(record=>record.attempt),[1,2,3]);
  assert.deepEqual(errors.map(record=>record.max_attempts),[3,3,3]);
  assert.ok(errors.every(record=>record.request_ref==='33445566778899aa'));
  assert.ok(errors.every(record=>record.stage==='completion_start'&&record.status===500&&record.retryable===true));
  assert.doesNotMatch(lines.join('\n'),/UPSTREAM_BODY_SECRET|synthetic|PROMPT_MUST_NOT_LEAK|SESSION_MUST_NOT_LEAK|https?:|[A-Z]:\\/);
});

test('Claude client correlation stays stable while ordinary upstream turns remain stateless',async()=>{
  const lines=[];
  const calls=[];
  let remoteSequence=0;
  const outputs=[
    {content:jsonToolCall('Read',{file_path:'synthetic-one.txt'}),reasoning:'',parentMessageId:'parent-1'},
    {content:'first final',reasoning:'',parentMessageId:'parent-2'},
    {content:jsonToolCall('Read',{file_path:'synthetic-two.txt'}),reasoning:'',parentMessageId:'parent-3'},
    {content:'second final',reasoning:'',parentMessageId:'parent-4'},
  ];
  const readTool={name:'Read',description:'read synthetic file',input_schema:{type:'object',properties:{file_path:{type:'string'}}}};
  const headers={'x-claude-code-session-id':'claude-client-correlation'};
  const toolUseFromSse=text=>{
    const values=text.split(/\r?\n/).filter(line=>line.startsWith('data: ')).flatMap(line=>{
      try{return [JSON.parse(line.slice(6))];}catch{return [];}
    });
    return values.find(value=>value?.content_block?.type==='tool_use')?.content_block;
  };
  await withDiagnosticsServer({
    logger:line=>lines.push(line),
    completeImpl:async options=>{
      calls.push(options);
      if(!options.session.id)options.session.id=`remote-${++remoteSequence}`;
      options.session.parentMessageId=`mock-parent-${calls.length}`;
      return outputs.shift();
    },
  },async post=>{
    const firstMessages=[{role:'user',content:'first synthetic task'}];
    const first=await post('/v1/messages',{model:'deepseek-chat',max_tokens:64,stream:true,messages:firstMessages,tools:[readTool]},headers);
    assert.match(first.text,/event: message_stop/);
    const firstCall=toolUseFromSse(first.text);
    assert.equal(firstCall.name,'Read');

    const firstTranscript=[
      ...firstMessages,
      {role:'assistant',content:[{type:'tool_use',id:firstCall.id,name:'Read',input:{file_path:'synthetic-one.txt'}}]},
      {role:'user',content:[{type:'tool_result',tool_use_id:firstCall.id,content:'synthetic result one'}]},
    ];
    const second=await post('/v1/messages',{model:'deepseek-chat',max_tokens:64,stream:true,messages:firstTranscript,tools:[readTool]},headers);
    assert.match(second.text,/event: message_stop/);

    const nextMessages=[...firstTranscript,{role:'assistant',content:[{type:'text',text:'first final'}]},{role:'user',content:'second synthetic task'}];
    const third=await post('/v1/messages',{model:'deepseek-chat',max_tokens:64,stream:true,messages:nextMessages,tools:[readTool]},headers);
    const secondCall=toolUseFromSse(third.text);
    assert.equal(secondCall.name,'Read');

    const fourthMessages=[
      ...nextMessages,
      {role:'assistant',content:[{type:'tool_use',id:secondCall.id,name:'Read',input:{file_path:'synthetic-two.txt'}}]},
      {role:'user',content:[{type:'tool_result',tool_use_id:secondCall.id,content:'synthetic result two'}]},
    ];
    const fourth=await post('/v1/messages',{model:'deepseek-chat',max_tokens:64,stream:true,messages:fourthMessages,tools:[readTool]},headers);
    assert.match(fourth.text,/event: message_stop/);
  });
  assert.equal(calls.length,4);
  assert.equal(calls[0].session,calls[1].session);
  assert.equal(calls[2].session,calls[3].session);
  assert.notEqual(calls[0].session,calls[2].session);
  assert.notEqual(calls[0].session.id,calls[2].session.id);
  assert.match(calls[1].prompt,/TOOL RESULT CONTINUATION/);
  assert.match(calls[3].prompt,/TOOL RESULT CONTINUATION/);
  assert.doesNotMatch(calls[1].prompt,/first synthetic task/);
  assert.doesNotMatch(calls[3].prompt,/second synthetic task/);
  const requests=diagnosticRecords(lines).filter(record=>record.event==='tool_request');
  const responses=diagnosticRecords(lines).filter(record=>record.event==='tool_response');
  assert.equal(requests.length,4);
  assert.equal(responses.length,4);
  assert.equal(new Set(requests.map(record=>record.request_ref)).size,4);
  assert.deepEqual(responses.map(record=>record.request_ref),requests.map(record=>record.request_ref));
  assert.ok(requests.every(record=>record.client_session_source==='claude_header'));
  assert.equal(new Set(requests.map(record=>record.client_session_ref)).size,1);
  assert.equal(requests[0].session_ref,requests[1].session_ref);
  assert.notEqual(requests[0].session_ref,requests[2].session_ref);
  assert.equal(requests[2].session_ref,requests[3].session_ref);
  assert.deepEqual(requests.map(record=>record.session_source),['anonymous','tool_result','anonymous','tool_result']);
  assert.deepEqual(requests.map(record=>record.is_tool_continuation),[false,true,false,true]);
});

test('explicit x-agent-session remains opt-in stateful upstream beside Claude client identity',async()=>{
  const lines=[];
  const calls=[];
  await withDiagnosticsServer({
    logger:line=>lines.push(line),
    completeImpl:async options=>{calls.push(options);return {content:'explicit final',reasoning:'',parentMessageId:`parent-${calls.length}`};},
  },async post=>{
    const headers={'x-claude-code-session-id':'claude-explicit-client','x-agent-session':'explicit-upstream-session'};
    await post('/v1/messages',{model:'deepseek-chat',max_tokens:64,messages:[{role:'user',content:'explicit first'}]},headers);
    await post('/v1/messages',{model:'deepseek-chat',max_tokens:64,messages:[{role:'user',content:'explicit second'}]},headers);
  });
  assert.equal(calls.length,2);
  assert.equal(calls[0].session,calls[1].session);
  const requests=diagnosticRecords(lines).filter(record=>record.event==='tool_request');
  assert.equal(requests.length,2);
  assert.ok(requests.every(record=>record.session_source==='explicit_header'));
  assert.ok(requests.every(record=>record.client_session_source==='claude_header'));
  assert.equal(new Set(requests.map(record=>record.session_ref)).size,1);
  assert.equal(new Set(requests.map(record=>record.client_session_ref)).size,1);
});

test('client diagnostic fingerprints are process-scoped and never expose stable identities',()=>{
  const rawClaude='CLAUDE_SESSION_VALUE_MUST_NOT_LEAK';
  const rawAgent='AGENT_SESSION_VALUE_MUST_NOT_LEAK';
  const rawMetadata='METADATA_VALUE_MUST_NOT_LEAK';
  const rawUser='USER_VALUE_MUST_NOT_LEAK';
  const clientKey=clientSessionKey('claude',rawClaude);
  const permanentDigest=clientKey.split(':').at(-1);
  const makeRecord=salt=>{
    const lines=[];
    const diagnostics=createToolDiagnostics({enabled:true,processSalt:salt,logger:line=>lines.push(line)});
    diagnostics.request({
      protocol:'anthropic',
      route:'/v1/messages',
      body:{
        model:'deepseek-chat',
        prompt:'PROMPT_VALUE_MUST_NOT_LEAK',
        messages:[{role:'user',content:'MESSAGE_VALUE_MUST_NOT_LEAK'}],
        metadata:{user_id:rawMetadata},
        user:rawUser,
        authorization:'AUTH_VALUE_MUST_NOT_LEAK',
        cookie:'COOKIE_VALUE_MUST_NOT_LEAK',
        token:'TOKEN_VALUE_MUST_NOT_LEAK',
      },
      upstreamSource:'explicit_header',
      upstreamKey:explicitSessionKey('header',rawAgent),
      clientSessionSource:'claude_header',
      clientSessionKey:clientKey,
      toolResultCount:1,
    });
    return {line:lines[0],record:diagnosticRecords(lines)[0]};
  };
  const first=makeRecord(Buffer.alloc(32,1));
  const same=makeRecord(Buffer.alloc(32,1));
  const differentSalt=makeRecord(Buffer.alloc(32,2));
  assert.equal(first.record.client_session_ref,same.record.client_session_ref);
  assert.notEqual(first.record.client_session_ref,differentSalt.record.client_session_ref);
  assert.equal(first.record.client_session_ref.length,12);
  for(const secret of [
    rawClaude,rawAgent,rawMetadata,rawUser,clientKey,permanentDigest,
    'PROMPT_VALUE_MUST_NOT_LEAK','MESSAGE_VALUE_MUST_NOT_LEAK',
    'AUTH_VALUE_MUST_NOT_LEAK','COOKIE_VALUE_MUST_NOT_LEAK','TOKEN_VALUE_MUST_NOT_LEAK',
  ])assert.equal(first.line.includes(secret),false,secret);
});

test('server tool_response correlates accepted and content-shadowed parser inspection',async()=>{
  const lines=[];
  const strict=jsonToolCall('Glob',{pattern:'**/InteractiveStars.tsx'});
  const outputs=[
    {content:strict,reasoning:'nonempty reasoning',parentMessageId:'accepted-parent'},
    {content:'ordinary final prose',reasoning:strict,parentMessageId:'shadowed-parent'},
  ];
  await withDiagnosticsServer({logger:line=>lines.push(line),completeImpl:async()=>outputs.shift()},async post=>{
    const body={model:'deepseek-reasoner',messages:[{role:'user',content:'offline parser inspection'}],tools:[{type:'function',function:{name:'Glob',parameters:{type:'object'}}}]};
    const accepted=(await post('/v1/chat/completions',body)).json();
    assert.equal(accepted.choices[0].finish_reason,'tool_calls');
    assert.equal(accepted.choices[0].message.tool_calls[0].function.name,'Glob');
    const shadowed=(await post('/v1/chat/completions',body)).json();
    assert.equal(shadowed.choices[0].finish_reason,'stop');
    assert.equal(shadowed.choices[0].message.content,'ordinary final prose');
    assert.equal(shadowed.choices[0].message.tool_calls,undefined);
  });
  const records=diagnosticRecords(lines);
  const requests=records.filter(record=>record.event==='tool_request');
  const responses=records.filter(record=>record.event==='tool_response');
  assert.equal(requests.length,2);
  assert.equal(responses.length,2);
  assert.equal(responses[0].request_ref,requests[0].request_ref);
  assert.equal(responses[0].strict_tool_call_detected,true);
  assert.equal(responses[0].tool_parse_source,'content');
  assert.equal(responses[0].tool_parse_reason,'accepted');
  assert.equal(responses[0].fenced_tool_retry_attempted,false);
  assert.equal(responses[0].tool_retry_reason,'none');
  assert.equal(Object.prototype.hasOwnProperty.call(responses[0],'content_bytes'),false);
  assert.equal(responses[1].request_ref,requests[1].request_ref);
  assert.equal(responses[1].strict_tool_call_detected,false);
  assert.equal(responses[1].tool_parse_source,'content');
  assert.equal(responses[1].tool_parse_reason,'invalid_json');
  assert.equal(responses[1].content_starts_with_brace,false);
  assert.equal(responses[1].content_contains_tool_call_marker,false);
  assert.equal(responses[1].reasoning_starts_with_brace,true);
  assert.equal(responses[1].reasoning_ends_with_brace,true);
  assert.equal(responses[1].reasoning_contains_tool_call_marker,true);
  assert.equal(responses[1].outcome,'final_text');
  assert.equal(responses[1].fenced_tool_retry_attempted,false);
  assert.equal(responses[1].tool_retry_reason,'none');
});

test('fenced Glob content gets one correction and becomes an Anthropic tool_use',async()=>{
  const lines=[];
  const calls=[];
  const strict=jsonToolCall('Glob',{pattern:'**/InteractiveStars.tsx'});
  await withDiagnosticsServer({logger:line=>lines.push(line),completeImpl:async options=>{
    calls.push(options);
    return calls.length===1
      ? {content:`\`\`\`json\n${strict}\n\`\`\``,reasoning:'nonempty initial reasoning',parentMessageId:'fenced'}
      : {content:strict,reasoning:'',parentMessageId:'corrected'};
  }},async post=>{
    const response=(await post('/v1/messages',{
      model:'deepseek-reasoner',max_tokens:128,messages:[{role:'user',content:'find component'}],
      tools:[
        {name:'Glob',input_schema:{type:'object'}},
        {name:'Read',input_schema:{type:'object'}},
        {name:'Grep',input_schema:{type:'object'}},
      ],
    })).json();
    assert.equal(response.stop_reason,'tool_use');
    assert.equal(response.content[0].type,'tool_use');
    assert.equal(response.content[0].name,'Glob');
    assert.deepEqual(response.content[0].input,{pattern:'**/InteractiveStars.tsx'});
  });
  assert.equal(calls.length,2);
  assert.equal(calls[1].session,calls[0].session);
  assert.equal(calls[1].model.reasoning,false);
  assert.equal(calls[1].model.search,false);
  assert.match(calls[1].prompt,/Return the intended tool call/);
  assert.match(calls[1].prompt,/\["Glob","Read","Grep"\]/);
  assert.doesNotMatch(calls[1].prompt,/InteractiveStars|nonempty initial reasoning|```/);
  const response=diagnosticRecords(lines).find(record=>record.event==='tool_response');
  assert.equal(response.fenced_tool_retry_attempted,true);
  assert.equal(response.reasoning_retry_attempted,false);
  assert.equal(response.repeated_tool_retry_attempted,false);
  assert.equal(response.tool_retry_reason,'code_fence');
  assert.equal(response.tool_parse_source,'content');
  assert.equal(response.tool_parse_reason,'accepted');
  assert.equal(response.strict_tool_call_detected,true);
  assert.equal(response.outcome,'tool_call');
});

test('failed fenced correction emits one safe failure with code_fence diagnostics',async()=>{
  const lines=[];
  let calls=0;
  const malformed=fencedToolCall('Glob',{pattern:'**/InteractiveStars.tsx'});
  let responseText='';
  await withDiagnosticsServer({logger:line=>lines.push(line),completeImpl:async()=>{
    calls+=1;
    return {content:malformed,reasoning:`FAILED_CORRECTION_REASONING_${calls}`,parentMessageId:String(calls)};
  }},async post=>{
    responseText=(await post('/v1/chat/completions',{
      model:'deepseek-reasoner',messages:[{role:'user',content:'find component'}],
      tools:[{type:'function',function:{name:'Glob'}}],
    })).text;
  });
  assert.equal(calls,2);
  const response=JSON.parse(responseText);
  assert.equal(response.choices[0].message.content,TOOL_RETRY_FAILURE_MESSAGE);
  assert.doesNotMatch(responseText,/tool_call|InteractiveStars|FAILED_CORRECTION_REASONING/);
  const diagnostic=diagnosticRecords(lines).find(record=>record.event==='tool_response');
  assert.equal(diagnostic.fenced_tool_retry_attempted,true);
  assert.equal(diagnostic.tool_retry_reason,'code_fence');
  assert.equal(diagnostic.tool_parse_reason,'invalid_json');
  assert.equal(diagnostic.strict_tool_call_detected,false);
  assert.equal(diagnostic.outcome,'safe_failure');
});

test('fenced retry prompt and diagnostics never copy rejected payload secrets',async()=>{
  const lines=[];
  const calls=[];
  const secrets=['TOPSECRET','secret.example','C:\\Users\\Sensitive','Bearer SECRET','D:\\private-project'];
  const malformed=fencedToolCall('Glob',{
    url:'https://secret.example/TOPSECRET',windows:'C:\\Users\\Sensitive',authorization:'Bearer SECRET',path:'D:\\private-project',
  });
  let responseText='';
  await withDiagnosticsServer({logger:line=>lines.push(line),completeImpl:async options=>{
    calls.push(options);
    return calls.length===1
      ? {content:malformed,reasoning:'PRIVATE_REJECTED_REASONING',parentMessageId:'one'}
      : {content:jsonToolCall('Glob',{pattern:'**/*'}),reasoning:'',parentMessageId:'two'};
  }},async post=>{
    responseText=(await post('/v1/chat/completions',{
      model:'deepseek-chat',messages:[{role:'user',content:'synthetic safe request'}],
      tools:[{type:'function',function:{name:'Glob'}}],
    })).text;
  });
  assert.equal(calls.length,2);
  assert.match(calls[1].prompt,/\["Glob"\]/);
  const observed=`${calls[1].prompt}\n${lines.join('\n')}\n${responseText}`;
  for(const secret of [...secrets,'PRIVATE_REJECTED_REASONING'])assert.equal(observed.includes(secret),false,secret);
  assert.doesNotMatch(observed,/https?:\/\//);
});

test('tool-result continuation can correct one fenced Read and keep the linked session',async()=>{
  const lines=[];
  const calls=[];
  await withDiagnosticsServer({logger:line=>lines.push(line),completeImpl:async options=>{
    calls.push(options);
    if(calls.length===1)return {content:jsonToolCall('Glob',{pattern:'**/*.tsx'}),reasoning:'',parentMessageId:'glob'};
    if(calls.length===2)return {content:fencedToolCall('Read',{file_path:'component.tsx'}),reasoning:'choose Read',parentMessageId:'fenced-read'};
    return {content:jsonToolCall('Read',{file_path:'component.tsx'}),reasoning:'',parentMessageId:'strict-read'};
  }},async post=>{
    const tools=[
      {name:'Glob',input_schema:{type:'object'}},
      {name:'Read',input_schema:{type:'object'}},
      {name:'Grep',input_schema:{type:'object'}},
    ];
    const headers={'x-agent-session':'fenced-continuation'};
    const first=(await post('/v1/messages',{
      model:'deepseek-reasoner',max_tokens:128,messages:[{role:'user',content:'find then read'}],tools,
    },headers)).json();
    const glob=first.content[0];
    const second=(await post('/v1/messages',{
      model:'deepseek-reasoner',max_tokens:128,
      messages:[{role:'user',content:[{type:'tool_result',tool_use_id:glob.id,content:'component.tsx'}]}],tools,
    },headers)).json();
    assert.equal(second.stop_reason,'tool_use');
    assert.equal(second.content[0].type,'tool_use');
    assert.equal(second.content[0].name,'Read');
    assert.deepEqual(second.content[0].input,{file_path:'component.tsx'});
  });
  assert.equal(calls.length,3);
  assert.equal(calls[0].session,calls[1].session);
  assert.equal(calls[1].session,calls[2].session);
  assert.match(calls[1].prompt,/TOOL RESULT CONTINUATION/);
  assert.match(calls[2].prompt,/Return the intended tool call/);
  assert.doesNotMatch(calls[2].prompt,/component\.tsx|Completed Tool Result/);
  const requests=diagnosticRecords(lines).filter(record=>record.event==='tool_request');
  const responses=diagnosticRecords(lines).filter(record=>record.event==='tool_response');
  assert.equal(requests[1].is_tool_continuation,true);
  assert.equal(requests[1].tool_result_count,1);
  assert.equal(responses[1].fenced_tool_retry_attempted,true);
  assert.equal(responses[1].tool_retry_reason,'code_fence');
  assert.equal(responses[1].strict_tool_call_detected,true);
  assert.equal(responses[1].outcome,'tool_call');
});

test('fenced correction consumes repeated-tool budget on a continuation',async()=>{
  const lines=[];
  const calls=[];
  let secondResponse;
  await withDiagnosticsServer({logger:line=>lines.push(line),completeImpl:async options=>{
    calls.push(options);
    if(calls.length===1)return {content:jsonToolCall('echo',{text:'same'}),reasoning:'',parentMessageId:'tool'};
    if(calls.length===2)return {content:fencedToolCall('echo',{text:'same'}),reasoning:'',parentMessageId:'fenced-repeat'};
    return {content:jsonToolCall('echo',{text:'same'}),reasoning:'',parentMessageId:'strict-repeat'};
  }},async post=>{
    const tools=[{type:'function',function:{name:'echo',parameters:{type:'object'}}}];
    const headers={'x-agent-session':'fenced-repeat-budget'};
    const first=(await post('/v1/chat/completions',{
      model:'deepseek-chat',messages:[{role:'user',content:'echo once'}],tools,
    },headers)).json();
    const call=first.choices[0].message.tool_calls[0];
    secondResponse=(await post('/v1/chat/completions',{
      model:'deepseek-chat',messages:[{role:'tool',name:'echo',tool_call_id:call.id,content:'same'}],tools,
    },headers)).json();
  });
  assert.equal(calls.length,3);
  assert.equal(secondResponse.choices[0].message.content,REPEATED_TOOL_FAILURE_MESSAGE);
  assert.equal(secondResponse.choices[0].message.tool_calls,undefined);
  const responses=diagnosticRecords(lines).filter(record=>record.event==='tool_response');
  assert.equal(responses[1].fenced_tool_retry_attempted,true);
  assert.equal(responses[1].repeated_tool_retry_attempted,false);
  assert.equal(responses[1].tool_retry_reason,'code_fence');
  assert.equal(responses[1].outcome,'safe_failure');
});

test('fenced correction works with structured diagnostics disabled',async()=>{
  const previous=process.env.BRIDGE_TOOL_DIAGNOSTICS;
  delete process.env.BRIDGE_TOOL_DIAGNOSTICS;
  const lines=[];
  let calls=0;
  try{
    const result=await toolRetryProxyCase({
      logger:line=>lines.push(line),
      body:{model:'deepseek-chat',messages:[{role:'user',content:'find'}],tools:[{type:'function',function:{name:'Glob'}}]},
      completeImpl:async()=>{calls+=1;return calls===1
        ? {content:fencedToolCall('Glob',{}),reasoning:'',parentMessageId:'one'}
        : {content:jsonToolCall('Glob',{}),reasoning:'',parentMessageId:'two'};},
    });
    const response=JSON.parse(result.text);
    assert.equal(response.choices[0].finish_reason,'tool_calls');
    assert.equal(response.choices[0].message.tool_calls[0].function.name,'Glob');
  }finally{
    if(previous===undefined)delete process.env.BRIDGE_TOOL_DIAGNOSTICS;
    else process.env.BRIDGE_TOOL_DIAGNOSTICS=previous;
  }
  assert.equal(calls,2);
  assert.equal(diagnosticRecords(lines).length,0);
});

test('throwing logger cannot break a successful fenced correction',async()=>{
  let calls=0;
  await withDiagnosticsServer({logger:()=>{throw new Error('logger failed');},completeImpl:async()=>{
    calls+=1;
    return calls===1
      ? {content:fencedToolCall('Glob',{}),reasoning:'',parentMessageId:'one'}
      : {content:jsonToolCall('Glob',{}),reasoning:'',parentMessageId:'two'};
  }},async post=>{
    const response=(await post('/v1/chat/completions',{
      model:'deepseek-chat',messages:[{role:'user',content:'find'}],tools:[{type:'function',function:{name:'Glob'}}],
    })).json();
    assert.equal(response.choices[0].finish_reason,'tool_calls');
    assert.equal(response.choices[0].message.tool_calls[0].function.name,'Glob');
  });
  assert.equal(calls,2);
});

test('rejected parser diagnostics expose no content, paths, URLs or tool arguments',async()=>{
  const lines=[];
  const rejected=[
    '[https://secret.example/private?token=TOPSECRET](https://secret.example/private?token=TOPSECRET)',
    'C:\\Users\\Sensitive\\private.txt',
    'Bearer VERYSECRET',
    '{"tool_call":{"name":"Glob","arguments":{"path":"D:\\\\secret-project"}}}',
  ].join('\n');
  await withDiagnosticsServer({logger:line=>lines.push(line),completeImpl:async()=>({content:rejected,reasoning:'',parentMessageId:null})},async post=>{
    const response=(await post('/v1/chat/completions',{model:'deepseek-chat',messages:[{role:'user',content:'synthetic'}],tools:[{type:'function',function:{name:'Glob',parameters:{type:'object'}}}]})).json();
    assert.equal(response.choices[0].message.content,rejected);
  });
  const records=diagnosticRecords(lines);
  const response=records.find(record=>record.event==='tool_response');
  assert.equal(response.tool_parse_source,'content');
  assert.equal(response.tool_parse_reason,'invalid_json');
  assert.equal(response.content_contains_tool_call_marker,true);
  assert.ok(response.content_bytes>0);
  const journal=lines.join('\n');
  for(const forbidden of ['TOPSECRET','Sensitive','VERYSECRET','secret-project','secret.example','Bearer']){
    assert.equal(journal.includes(forbidden),false,forbidden);
  }
});

test('long session diagnostics show tool presence, continuation, retry and safe outcomes without payloads',async()=>{
  const lines=[];
  const calls=[];
  const secret={
    prompt:'PROMPT_SECRET_LOCAL_PATH_C:\\private\\marker.txt',reasoning:'REASONING_SECRET',content:'CONTENT_SECRET',
    argument:'ARGUMENT_SECRET',result:'TOOL_RESULT_SECRET',description:'DESCRIPTION_SECRET',schema:'SCHEMA_SECRET',
    session:'SESSION_SECRET_FULL_VALUE',metadata:'METADATA_SECRET',call:'',token:'TOKEN_SECRET',cookie:'COOKIE_SECRET',authorization:'AUTHORIZATION_SECRET',
  };
  const tools=['Read','Write','Edit','Grep','Glob'].map((name,index)=>({type:'function',function:{name,description:index===0?secret.description:'safe',parameters:{type:'object',properties:{marker:{description:index===0?secret.schema:'safe'}}}}}));
  const outputs=[
    {content:secret.content,reasoning:'',parentMessageId:'p1'},
    {content:jsonToolCall('Read',{file_path:secret.argument}),reasoning:'',parentMessageId:'p2'},
    {content:'after tool result',reasoning:'',parentMessageId:'p3'},
    {content:jsonToolCall('Read',{file_path:'recap.json'}),reasoning:'',parentMessageId:'p4'},
    {content:'',reasoning:secret.reasoning,parentMessageId:'p5'},
    {content:'after reasoning retry',reasoning:'',parentMessageId:'p6'},
    {content:'other session final',reasoning:'',parentMessageId:'p7'},
  ];
  await withDiagnosticsServer({logger:line=>lines.push(line),completeImpl:async options=>{calls.push(options);return outputs.shift();}},async post=>{
    const headers={'x-agent-session':secret.session,authorization:`Bearer ${secret.authorization}`,cookie:`session=${secret.cookie}`};
    const base={model:'deepseek-reasoner',metadata:{user_id:secret.metadata},token:secret.token,messages:[{role:'user',content:secret.prompt}]};
    await post('/v1/chat/completions',{...base,tools},headers);
    const toolResponse=(await post('/v1/chat/completions',{...base,tools},headers)).json();
    const call=toolResponse.choices[0].message.tool_calls[0];
    secret.call=call.id;
    await post('/v1/chat/completions',{...base,messages:[...base.messages,{role:'assistant',content:null,tool_calls:[call]},{role:'tool',name:'Read',tool_call_id:call.id,content:secret.result}],tools},headers);
    const recap=(await post('/v1/chat/completions',{...base,messages:[{role:'user',content:'recap request'}]},headers)).json();
    assert.equal(recap.choices[0].message.tool_calls,undefined);
    assert.match(recap.choices[0].message.content,/^\{"tool_call"/);
    await post('/v1/chat/completions',{...base,messages:[{role:'user',content:'retry request'}],tools},headers);
    await post('/v1/chat/completions',{model:'deepseek-chat',messages:[{role:'user',content:'other'}],tools},{'x-agent-session':'OTHER_SESSION_SECRET'});
  });
  const records=diagnosticRecords(lines);
  const requests=records.filter(record=>record.event==='tool_request');
  const responses=records.filter(record=>record.event==='tool_response');
  assert.equal(requests.length,6);
  assert.equal(responses.length,6);
  assert.deepEqual(requests[0].tool_names,['Read','Write','Edit','Grep','Glob']);
  assert.equal(requests[0].raw_tool_count,5);
  assert.equal(requests[0].normalized_tool_count,5);
  assert.equal(requests[3].tools_field_present,false);
  assert.equal(requests[3].tools_field_shape,'absent');
  assert.equal(requests[3].raw_tool_count,0);
  assert.equal(requests[3].normalized_tool_count,0);
  assert.deepEqual(requests[3].tool_names,[]);
  assert.equal(new Set(requests.slice(0,5).map(record=>record.session_ref)).size,1);
  assert.notEqual(requests[0].session_ref,requests[5].session_ref);
  assert.equal(requests[2].is_tool_continuation,true);
  assert.equal(requests[2].tool_result_count,1);
  assert.equal(responses[1].strict_tool_call_detected,true);
  assert.equal(responses[1].outcome,'tool_call');
  assert.equal(responses[3].strict_tool_call_detected,false);
  assert.equal(responses[3].outcome,'final_text');
  assert.equal(responses[4].reasoning_retry_attempted,true);
  assert.equal(responses[4].fenced_tool_retry_attempted,false);
  assert.equal(responses[4].tool_retry_reason,'reasoning_only');
  assert.equal(responses[4].outcome,'final_text');
  assert.equal(calls.length,7);
  const journal=lines.join('\n');
  for(const value of Object.values(secret).filter(Boolean))assert.equal(journal.includes(value),false,value);
});

test('OpenAI, Anthropic and Responses diagnostics preserve protocol signs and streaming',async()=>{
  const lines=[];
  await withDiagnosticsServer({logger:line=>lines.push(line),completeImpl:async({onDelta})=>{onDelta?.({content:'stream final'});return {content:'stream final',reasoning:'',parentMessageId:null};}},async post=>{
    const openai=await post('/v1/chat/completions',{model:'deepseek-chat',stream:true,messages:[{role:'user',content:'probe'}],tools:[{type:'function',function:{name:'Read'}}]},{'x-agent-session':'protocol-openai'});
    const anthropic=await post('/v1/messages',{model:'deepseek-chat',stream:true,messages:[{role:'user',content:'probe'}],tools:[{name:'Grep',input_schema:{type:'object'}}]},{'x-agent-session':'protocol-anthropic'});
    const responses=await post('/v1/responses',{model:'deepseek-chat',stream:true,input:'probe',tools:[{type:'function',name:'Glob',parameters:{type:'object'}},{type:'other',name:'ignored'}]},{'x-agent-session':'protocol-responses'});
    assert.match(openai.text,/data: \[DONE\]/);
    assert.match(anthropic.text,/event: message_stop/);
    assert.match(responses.text,/event: response\.completed/);
  });
  const requests=diagnosticRecords(lines).filter(record=>record.event==='tool_request');
  assert.deepEqual(requests.map(record=>record.protocol),['openai','anthropic','responses']);
  assert.deepEqual(requests.map(record=>record.tool_names),[['Read'],['Grep'],['Glob']]);
  assert.deepEqual(requests.map(record=>record.normalized_tool_count),[1,1,1]);
  assert.deepEqual(requests.map(record=>record.raw_tool_count),[1,1,2]);
  assert.ok(requests.every(record=>record.stream===true));
});

test('diagnostic logger failures do not break a parser rejection or HTTP request',async()=>{
  await withDiagnosticsServer({logger:()=>{throw new Error('logger failed');},completeImpl:async()=>({content:'safe final',reasoning:jsonToolCall('Read',{}),parentMessageId:null})},async post=>{
    const response=(await post('/v1/chat/completions',{model:'deepseek-chat',messages:[{role:'user',content:'probe'}],tools:[{type:'function',function:{name:'Read'}}]},{'x-agent-session':'private-session'})).json();
    assert.equal(response.choices[0].message.content,'safe final');
    assert.equal(response.choices[0].message.tool_calls,undefined);
  });
});

test('repeated completed tool correction is visible only as a bounded diagnostic flag',async()=>{
  const lines=[];
  let calls=0;
  await withDiagnosticsServer({logger:line=>lines.push(line),completeImpl:async()=>{
    calls+=1;
    if(calls<=2)return {content:jsonToolCall('echo',{text:'same'}),reasoning:'',parentMessageId:`p${calls}`};
    return {content:'corrected final',reasoning:'',parentMessageId:'p3'};
  }},async post=>{
    const tools=[{type:'function',function:{name:'echo',parameters:{type:'object'}}}];
    const first=(await post('/v1/chat/completions',{model:'deepseek-chat',messages:[{role:'user',content:'echo once'}],tools},{'x-agent-session':'repeat-diagnostic'})).json();
    const call=first.choices[0].message.tool_calls[0];
    const second=(await post('/v1/chat/completions',{model:'deepseek-chat',messages:[{role:'tool',name:'echo',tool_call_id:call.id,content:'same'}],tools},{'x-agent-session':'repeat-diagnostic'})).json();
    assert.equal(second.choices[0].message.content,'corrected final');
  });
  assert.equal(calls,3);
  const responses=diagnosticRecords(lines).filter(record=>record.event==='tool_response');
  assert.equal(responses[1].repeated_tool_retry_attempted,true);
  assert.equal(responses[1].fenced_tool_retry_attempted,false);
  assert.equal(responses[1].tool_retry_reason,'repeated_tool');
  assert.equal(responses[1].outcome,'final_text');
});

let claudeProbeModule;
async function claudeProbe(){return claudeProbeModule??=await import('../scripts/claude_contract_probe.mjs');}

test('Claude contract probe records only its explicit safe field allowlist',async()=>{
  const {SAFE_RECORD_FIELDS,sanitizeContractRequest}=await claudeProbe();
  const secretValues=[
    'PROMPT_CONTRACT_SECRET','SYSTEM_CONTRACT_SECRET','MESSAGE_CONTRACT_SECRET',
    'ARGUMENT_CONTRACT_SECRET','RESULT_CONTRACT_SECRET','SCHEMA_CONTRACT_SECRET',
    'AUTH_CONTRACT_SECRET','Z:\\contract-probe-private\\marker.txt','toolu_full_private_identifier',
  ];
  const record=sanitizeContractRequest({
    sequence:1,method:'POST',pathname:'/v1/messages',salt:Buffer.alloc(32,7),
    body:{
      model:'probe-model',stream:true,prompt:secretValues[0],authorization:secretValues[6],
      system:secretValues[1],metadata:{safe_key:'value',authorization:secretValues[6]},
      messages:[
        {role:'user',content:[{type:'text',text:secretValues[2]}]},
        {role:'assistant',content:[{type:'tool_use',id:secretValues[8],name:'Read',input:{file_path:secretValues[7],secret:secretValues[3]}}]},
        {role:'user',content:[{type:'tool_result',tool_use_id:secretValues[8],content:secretValues[4]}]},
      ],
      tools:[{name:'Read',description:'private description',input_schema:{type:'object',properties:{file_path:{type:'string',description:secretValues[5]}}}}],
    },
  });
  assert.deepEqual(Object.keys(record),SAFE_RECORD_FIELDS);
  assert.deepEqual(record.tool_names,['Read']);
  assert.equal(record.tool_result_count,1);
  assert.equal(record.tool_use_count,1);
  assert.deepEqual(record.content_block_types,['text','tool_use','tool_result']);
  assert.deepEqual(record.tool_object_keys,[['description','input_schema','name']]);
  assert.equal(record.tool_schema_present,true);
  assert.equal(record.tool_result_id_fingerprint.length,1);
  assert.notEqual(record.tool_result_id_fingerprint[0],secretValues[8]);
  const serialized=JSON.stringify(record);
  for(const value of secretValues)assert.equal(serialized.includes(value),false,value);
  assert.equal(serialized.includes('private description'),false);
  assert.equal(serialized.includes('authorization'),false);
});

test('Claude contract probe bounds tool names and tolerates unexpected body shapes',async()=>{
  const {sanitizeContractRequest}=await claudeProbe();
  const tools=Array.from({length:80},(_,index)=>({name:index===0?`Read\n${'x'.repeat(200)}`:index===1?{bad:true}:`Tool_${index}`}));
  const record=sanitizeContractRequest({sequence:-1,method:null,pathname:null,salt:Buffer.alloc(32,8),body:{messages:{bad:true},tools}});
  assert.equal(record.sequence,0);
  assert.equal(record.messages_shape,'object');
  assert.equal(record.tool_count,80);
  assert.equal(record.tool_names.length,32);
  assert.ok(record.tool_names[0].length<=64);
  assert.doesNotMatch(record.tool_names[0],/[\r\n]/);
  assert.equal(record.tool_names[1],'invalid');
  assert.doesNotThrow(()=>sanitizeContractRequest({body:null,salt:Buffer.alloc(32,9)}));
  assert.doesNotThrow(()=>sanitizeContractRequest({body:['unexpected'],salt:Buffer.alloc(32,10)}));
});

test('Claude contract probe derives Read arguments only from the supplied schema',async()=>{
  const {deriveReadArguments}=await claudeProbe();
  assert.deepEqual(deriveReadArguments({input_schema:{type:'object',properties:{file_path:{type:'string'},offset:{type:'number'}}}},'private-path'),{file_path:'private-path'});
  assert.deepEqual(deriveReadArguments({input_schema:{type:'object',properties:{path:{type:'string'}}}},'private-path'),{path:'private-path'});
  assert.throws(()=>deriveReadArguments({input_schema:{type:'object',properties:{command:{type:'string'}}}},'private-path'),/supported string path field/);
});

test('Claude contract mock is loopback-only, bounded and survives logger exceptions',async()=>{
  const {startContractMockServer}=await claudeProbe();
  const mock=await startContractMockServer({maxMessageRequests:1,logger:()=>{throw new Error('logger failed');}});
  try{
    assert.match(mock.origin,/^http:\/\/127\.0\.0\.1:\d+$/);
    const body={model:'probe-model',messages:[{role:'user',content:'not logged'}],tools:[{name:'Read',input_schema:{type:'object',properties:{file_path:{type:'string'}}}}]};
    const first=await fetch(`${mock.origin}/v1/messages`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal(first.status,200);
    const second=await fetch(`${mock.origin}/v1/messages`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal(second.status,429);
    assert.equal(mock.state.messageRequests,2);
    assert.equal(mock.records.length,2);
  }finally{await mock.close();}
});

test('Claude contract mock supports local count_tokens without exposing request content',async()=>{
  const {startContractMockServer}=await claudeProbe();
  const lines=[];
  const mock=await startContractMockServer({logger:line=>lines.push(line)});
  try{
    const secret='COUNT_TOKEN_PROMPT_SECRET';
    const response=await fetch(`${mock.origin}/v1/messages/count_tokens?beta=true`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer HEADER_SECRET'},body:JSON.stringify({model:'probe-model',system:secret,messages:[{role:'user',content:secret}],tools:[{name:'Read',description:secret,input_schema:{type:'object',properties:{file_path:{description:secret}}}}]})});
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{input_tokens:100});
    assert.equal(mock.state.countTokenRequests,1);
    assert.equal(mock.records[0].pathname,'/v1/messages/count_tokens');
    assert.equal(mock.records[0].count_tokens_requested,true);
    assert.equal(mock.records[0].tools_field_present,true);
    assert.equal(lines.join('\n').includes(secret),false);
    assert.equal(lines.join('\n').includes('HEADER_SECRET'),false);
  }finally{await mock.close();}
});

test('Claude contract probe timeout is bounded and invokes cleanup callback once',async()=>{
  const {withTimeout}=await claudeProbe();
  let cleanups=0;
  await assert.rejects(withTimeout(new Promise(()=>{}),20,()=>{cleanups+=1;}),/timed out/);
  assert.equal(cleanups,1);
});

test('Claude contract probe always removes its temporary marker workspace',async()=>{
  const {withProbeWorkspace}=await claudeProbe();
  let directory;
  await assert.rejects(withProbeWorkspace(async workspace=>{
    directory=workspace.directory;
    assert.equal(fs.existsSync(path.join(directory,'marker.txt')),true);
    assert.equal(fs.existsSync(path.join(directory,'second-marker.txt')),true);
    throw new Error('intentional offline failure');
  }),/intentional offline failure/);
  assert.equal(fs.existsSync(directory),false);
});

let claudeIdentityProbeModule;
async function claudeIdentityProbe(){return claudeIdentityProbeModule??=await import('../scripts/claude_session_identity_probe.mjs');}

test('Claude identity probe records only safe identifier summaries',async()=>{
  const {SAFE_IDENTITY_RECORD_FIELDS,sanitizeIdentityRequest}=await claudeIdentityProbe();
  const salt=Buffer.alloc(32,11);
  const secrets={
    auth:'IDENTITY_AUTH_SECRET',cookie:'IDENTITY_COOKIE_SECRET',prompt:'IDENTITY_PROMPT_SECRET',
    message:'IDENTITY_MESSAGE_SECRET',argument:'IDENTITY_ARGUMENT_SECRET',
    result:'IDENTITY_RESULT_SECRET',session:'11111111-2222-4333-8444-555555555555',
    custom:'PROCESS_SCOPED_HEADER_SECRET',
  };
  const record=sanitizeIdentityRequest({
    sequence:1,method:'POST',pathname:'/v1/messages',salt,
    headers:{
      authorization:`Bearer ${secrets.auth}`,cookie:secrets.cookie,
      'x-claude-code-session-id':secrets.session,'x-agent-session':secrets.custom,
      'x-arbitrary-session-secret':'MUST_NOT_BE_CAPTURED','content-type':'application/json',
    },
    body:{
      prompt:secrets.prompt,session_id:secrets.session,
      metadata:{user_id:secrets.custom,authorization:secrets.auth},
      messages:[
        {role:'user',content:[{type:'text',text:secrets.message}]},
        {role:'assistant',content:[{type:'tool_use',id:'FULL_TOOL_ID',name:'Read',input:{file_path:secrets.argument}}]},
        {role:'user',content:[{type:'tool_result',tool_use_id:'FULL_TOOL_ID',content:secrets.result}]},
      ],
    },
  });
  assert.deepEqual(Object.keys(record),SAFE_IDENTITY_RECORD_FIELDS);
  assert.equal(record.candidate_headers['x-claude-code-session-id'].present,true);
  assert.equal(record.candidate_headers['x-claude-code-session-id'].type,'string');
  assert.equal(record.candidate_headers['x-claude-code-session-id'].length,36);
  assert.equal(record.candidate_headers['x-claude-code-session-id'].fingerprint.length,12);
  assert.equal(record.candidate_headers['x-agent-session'].fingerprint.length,12);
  assert.equal(record.body_candidates.top_level.session_id.present,true);
  assert.equal(record.body_candidates.metadata.user_id.present,true);
  assert.equal(record.tool_result_count,1);
  assert.ok(record.candidate_header_names.includes('x-arbitrary-session-secret'));
  assert.equal(Object.hasOwn(record.candidate_headers,'x-arbitrary-session-secret'),false);
  const serialized=JSON.stringify(record);
  for(const value of Object.values(secrets))assert.equal(serialized.includes(value),false,value);
  for(const forbidden of ['authorization','cookie','prompt','tool_use_id','file_path'])assert.equal(serialized.includes(forbidden),false,forbidden);
});

test('Claude identity fingerprints are process-salted, stable and bounded',async()=>{
  const {summarizeIdentifier}=await claudeIdentityProbe();
  const value='same-identity-value';
  const first=summarizeIdentifier(value,Buffer.alloc(32,1));
  const same=summarizeIdentifier(value,Buffer.alloc(32,1));
  const differentValue=summarizeIdentifier('different-identity-value',Buffer.alloc(32,1));
  const differentSalt=summarizeIdentifier(value,Buffer.alloc(32,2));
  assert.equal(first.fingerprint,same.fingerprint);
  assert.notEqual(first.fingerprint,differentValue.fingerprint);
  assert.notEqual(first.fingerprint,differentSalt.fingerprint);
  assert.equal(summarizeIdentifier('x'.repeat(300),Buffer.alloc(32,1)).fingerprint,'invalid');
  assert.equal(summarizeIdentifier({bad:true},Buffer.alloc(32,1)).fingerprint,'invalid');
  assert.doesNotThrow(()=>summarizeIdentifier(null,Buffer.alloc(32,1)));
  assert.doesNotThrow(()=>summarizeIdentifier(['one','two'],Buffer.alloc(32,1)));
});

test('Claude identity mock is loopback-only, bounded and omits arbitrary header values',async()=>{
  const {startIdentityMockServer}=await claudeIdentityProbe();
  const lines=[];
  const mock=await startIdentityMockServer({maxMessageRequests:1,logger:line=>lines.push(line)});
  try{
    assert.match(mock.origin,/^http:\/\/127\.0\.0\.1:\d+$/);
    const secret='ARBITRARY_HEADER_VALUE_SECRET';
    const body={model:'probe-model',messages:[{role:'user',content:'not logged'}],tools:[{name:'Read',input_schema:{type:'object',properties:{file_path:{type:'string'}}}}]};
    const headers={'content-type':'application/json','x-agent-session':'process-one','x-claude-code-session-id':'session-one','x-arbitrary-session-secret':secret,authorization:'Bearer AUTH_SECRET',cookie:'COOKIE_SECRET'};
    const first=await fetch(`${mock.origin}/v1/messages`,{method:'POST',headers,body:JSON.stringify(body)});
    assert.equal(first.status,200);
    const second=await fetch(`${mock.origin}/v1/messages`,{method:'POST',headers,body:JSON.stringify(body)});
    assert.equal(second.status,429);
    const serialized=lines.join('\n');
    assert.equal(serialized.includes(secret),false);
    assert.equal(serialized.includes('AUTH_SECRET'),false);
    assert.equal(serialized.includes('COOKIE_SECRET'),false);
    assert.equal(serialized.includes('authorization'),false);
    assert.equal(serialized.includes('cookie'),false);
  }finally{await mock.close();}
});

test('Claude identity workspace is always removed',async()=>{
  const {withIdentityWorkspace}=await claudeIdentityProbe();
  let directory;
  await assert.rejects(withIdentityWorkspace(async workspace=>{
    directory=workspace.directory;
    assert.equal(fs.existsSync(path.join(directory,'marker.txt')),true);
    assert.equal(fs.existsSync(path.join(directory,'second-marker.txt')),true);
    throw new Error('intentional identity probe failure');
  }),/intentional identity probe failure/);
  assert.equal(fs.existsSync(directory),false);
});

let claudeLiveProbeModule;
async function claudeLiveProbe(){return claudeLiveProbeModule??=await import('../scripts/claude_long_session_live_probe.mjs');}

test('Claude live probe reduces structured output to safe event flags',async()=>{
  const {summarizeClaudeEvent}=await claudeLiveProbe();
  const raw='{"tool_call":{"name":"Read","arguments":{"file_path":"PRIVATE_PATH"}}}';
  const summary=summarizeClaudeEvent({type:'assistant',subtype:'message',authorization:'AUTH_SECRET',message:{content:[{type:'tool_use',id:'FULL_CALL_ID',name:'Read',input:{file_path:'ARG_SECRET'}},{type:'text',text:raw}]}},['MARKER_SECRET']);
  assert.deepEqual(summary.tool_use_names,['Read']);assert.equal(summary.raw_tool_json_as_text,true);
  const serialized=JSON.stringify(summary);for(const value of [raw,'PRIVATE_PATH','AUTH_SECRET','FULL_CALL_ID','ARG_SECRET','MARKER_SECRET'])assert.equal(serialized.includes(value),false,value);
});

test('Claude live probe recognizes only explicit structured lifecycle events',async()=>{
  const {summarizeClaudeEvent}=await claudeLiveProbe();
  assert.equal(summarizeClaudeEvent({type:'system',subtype:'compact_boundary'}).explicit_compaction,true);
  assert.equal(summarizeClaudeEvent({type:'system',subtype:'recap'}).explicit_recap,true);
  const ordinary=summarizeClaudeEvent({type:'assistant',subtype:'message',message:{content:[{type:'text',text:'short summary and compact prose'}]}});
  assert.equal(ordinary.explicit_compaction,false);assert.equal(ordinary.explicit_recap,false);
});

test('Claude live probe sanitizes Bridge diagnostic records',async()=>{
  const {parseBridgeDiagnostics,sanitizeBridgeDiagnostic}=await claudeLiveProbe();
  const safe=sanitizeBridgeDiagnostic({event:'tool_request',protocol:'anthropic',route:'/v1/messages',model:'deepseek-reasoner',stream:true,session_source:'explicit_metadata',session_ref:'FULL_SESSION_ID',tools_field_present:true,tools_field_shape:'array',raw_tool_count:3,normalized_tool_count:3,tool_names:['Read','Glob','Grep'],is_tool_continuation:false,tool_result_count:0,prompt:'PROMPT_SECRET'});
  assert.equal(safe.session_ref,'invalid');assert.deepEqual(safe.tool_names,['Read','Glob','Grep']);assert.equal(JSON.stringify(safe).includes('PROMPT_SECRET'),false);assert.equal(JSON.stringify(safe).includes('FULL_SESSION_ID'),false);
  assert.equal(parseBridgeDiagnostics(`bad\n${JSON.stringify({...safe,session_ref:'abcdef012345'})}`).length,1);
});

test('Claude live probe workspace is bounded, unchanged and removed',async()=>{
  const {withSyntheticWorkspace}=await claudeLiveProbe();let directory;
  const result=await withSyntheticWorkspace(async value=>{directory=value.directory;assert.equal(value.markers.length,12);assert.ok(value.totalBytes<=160*1024);assert.equal(fs.readdirSync(directory).filter(name=>/^part-\d{2}\.txt$/.test(name)).length,12);return {ok:true};});
  assert.equal(result.ok,true);assert.equal(result.temporary_files_unchanged,true);assert.equal(fs.existsSync(directory),false);
});

test('Claude live probe uses confirmed resume and read-only tool flags',async()=>{
  const {buildClaudeArgs}=await claudeLiveProbe();const session='11111111-1111-4111-8111-111111111111';
  const first=buildClaudeArgs({sessionId:session,first:true,prompt:'synthetic'}),next=buildClaudeArgs({sessionId:session,first:false,prompt:'synthetic'});
  assert.ok(first.includes('--print'));assert.ok(first.includes('stream-json'));assert.equal(first[first.indexOf('--tools')+1],'Read,Glob,Grep');assert.equal(first[first.indexOf('--allowedTools')+1],'Read,Glob,Grep');assert.match(first[first.indexOf('--disallowedTools')+1],/Write.*Edit.*Bash/);
  assert.deepEqual(first.slice(first.indexOf('--session-id'),first.indexOf('--session-id')+2),['--session-id',session]);assert.deepEqual(next.slice(next.indexOf('--resume'),next.indexOf('--resume')+2),['--resume',session]);
});

let claudeToolExposureProbeModule;
async function claudeToolExposureProbe(){return claudeToolExposureProbeModule??=await import('../scripts/claude_2_1_226_tool_exposure_probe.mjs');}

test('Claude 2.1.226 exposure probe distinguishes verified and previous tool syntax',async()=>{
  const {argsForProbe}=await claudeToolExposureProbe();
  const correct=argsForProbe('glob-read','Safe probe prompt.');
  const previous=argsForProbe('previous','Safe probe prompt.');
  assert.equal(correct[correct.indexOf('--tools')+1],'Glob,Read');
  assert.equal(correct[correct.indexOf('--allowedTools')+1],'Glob,Read');
  assert.deepEqual(previous.slice(previous.indexOf('--tools')+1,previous.indexOf('--tools')+3),['Glob','Read']);
  assert.deepEqual(previous.slice(previous.indexOf('--allowedTools')+1,previous.indexOf('--allowedTools')+3),['Glob','Read']);
  assert.ok(previous.includes('--safe-mode'));
  assert.ok(previous.includes('--bare'));
});

test('Claude 2.1.226 exposure probes disable inherited customizations and MCP configs',async()=>{
  const {argsForProbe}=await claudeToolExposureProbe();
  for(const probe of ['default','glob','read','glob-read','previous']){
    const args=argsForProbe(probe,'Safe probe prompt.');
    assert.equal(args.filter(value=>value==='--safe-mode').length,1);
    assert.equal(args.filter(value=>value==='--strict-mcp-config').length,1);
    assert.equal(args.includes('--mcp-config'),false);
  }
});

test('Claude 2.1.226 exposure records omit request bodies and identifier values',async()=>{
  const {sanitizeRequest}=await claudeToolExposureProbe();
  const secret='MUST_NOT_APPEAR_IN_EXPOSURE_RECORD';
  const record=sanitizeRequest({
    model:'probe-model',stream:true,prompt:secret,
    messages:[{role:'user',content:[{type:'tool_result',tool_use_id:secret,content:secret}]}],
    tools:[{name:'Glob',description:secret,input_schema:{type:'object',properties:{pattern:{type:'string'}}}}],
  },{'x-claude-code-session-id':secret,authorization:secret,cookie:secret},1);
  assert.deepEqual(record.tool_names,['Glob']);
  assert.equal(record.tool_result_count,1);
  assert.equal(record.claude_session_header_present,true);
  assert.equal(JSON.stringify(record).includes(secret),false);
  assert.deepEqual(Object.keys(record),[
    'request_number','request_kind','tools_field_present','tools_field_type','tool_count',
    'tool_names','model','stream','tool_result_count','claude_session_header_present',
  ]);
});
