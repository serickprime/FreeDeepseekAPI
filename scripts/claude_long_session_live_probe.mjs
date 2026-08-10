import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_TURNS = 12;
const MAX_REQUESTS = 40;
const MAX_TOTAL_MS = 20 * 60 * 1000;
const MAX_TURN_MS = 90 * 1000;
const ALLOWED = 'Read,Glob,Grep';
const DENIED = 'Write,Edit,Bash,NotebookEdit,WebFetch,WebSearch';
const REQUEST_FIELDS = ['event','protocol','route','model','stream','session_source','session_ref','tools_field_present','tools_field_shape','raw_tool_count','normalized_tool_count','tool_names','is_tool_continuation','tool_result_count'];
const RESPONSE_FIELDS = ['event','strict_tool_call_detected','reasoning_nonempty','content_nonempty','reasoning_retry_attempted','repeated_tool_retry_attempted','outcome'];

function safeName(value) {
  if (typeof value !== 'string') return 'invalid';
  return value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 64) || 'invalid';
}

function strictEnvelope(text) {
  if (typeof text !== 'string' || text.length > 65536) return false;
  let value;
  try { value = JSON.parse(text.trim()); } catch { return false; }
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 1 && value.tool_call
    && typeof value.tool_call === 'object' && typeof value.tool_call.name === 'string'
    && value.tool_call.arguments && typeof value.tool_call.arguments === 'object'
    && !Array.isArray(value.tool_call.arguments);
}

export function summarizeClaudeEvent(input, expected = []) {
  let event;
  try { event = typeof input === 'string' ? JSON.parse(input) : input; } catch { return null; }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const type = safeName(event.type);
  const subtype = safeName(event.subtype);
  const names = [type, subtype, safeName(event.name)].map(value => value.toLowerCase());
  const blocks = Array.isArray(event?.message?.content) ? event.message.content : [];
  const texts = [];
  if (event.type === 'assistant') for (const block of blocks) if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
  if (event.type === 'result' && typeof event.result === 'string') texts.push(event.result);
  return {
    type,
    subtype,
    explicit_compaction: names.some(value => ['compact','compaction','compact_boundary','precompact','postcompact','pre_compact','post_compact'].includes(value)),
    explicit_recap: names.some(value => ['recap','session_recap','recap_boundary'].includes(value)),
    tool_use_names: blocks.filter(block => block?.type === 'tool_use').slice(0,16).map(block => safeName(block.name)),
    tool_result_count: blocks.filter(block => block?.type === 'tool_result').length,
    raw_tool_json_as_text: texts.some(strictEnvelope),
    expected_markers_observed: expected.map(marker => texts.some(text => text.includes(marker))),
    result_event: event.type === 'result',
    result_error: event.type === 'result' && event.is_error === true,
  };
}

export function sanitizeBridgeDiagnostic(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  if (record.event === 'tool_request') {
    const safe = Object.fromEntries(REQUEST_FIELDS.map(field => [field, record[field]]));
    safe.event = 'tool_request';
    safe.protocol = record.protocol === 'anthropic' ? 'anthropic' : 'unknown';
    safe.route = record.route === '/v1/messages' ? '/v1/messages' : 'unknown';
    safe.model = typeof record.model === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(record.model) ? record.model : 'invalid';
    safe.stream = record.stream === true;
    safe.session_source = ['explicit_header','explicit_metadata','explicit_user','tool_result','anonymous'].includes(record.session_source) ? record.session_source : 'unknown';
    safe.session_ref = typeof record.session_ref === 'string' && /^[a-f0-9]{12}$/.test(record.session_ref) ? record.session_ref : 'invalid';
    safe.tools_field_present = record.tools_field_present === true;
    safe.tools_field_shape = ['absent','array','null','object','string','number','boolean'].includes(record.tools_field_shape) ? record.tools_field_shape : 'invalid';
    for (const field of ['raw_tool_count','normalized_tool_count','tool_result_count']) safe[field] = Number.isSafeInteger(record[field]) && record[field] >= 0 && record[field] <= 1024 ? record[field] : 0;
    safe.tool_names = Array.isArray(record.tool_names) ? record.tool_names.slice(0,16).map(safeName) : [];
    safe.is_tool_continuation = record.is_tool_continuation === true;
    return safe;
  }
  if (record.event === 'tool_response') {
    const safe = Object.fromEntries(RESPONSE_FIELDS.map(field => [field, record[field]]));
    safe.event = 'tool_response';
    for (const field of RESPONSE_FIELDS.slice(1,-1)) safe[field] = record[field] === true;
    safe.outcome = ['tool_call','final_text','safe_failure','upstream_error'].includes(record.outcome) ? record.outcome : 'safe_failure';
    return safe;
  }
  return null;
}

export function parseBridgeDiagnostics(text) {
  if (typeof text !== 'string') return [];
  return text.split(/\r?\n/).flatMap(line => {
    try { const safe = sanitizeBridgeDiagnostic(JSON.parse(line)); return safe ? [safe] : []; }
    catch { return []; }
  });
}

function hash(value) { return createHash('sha256').update(value).digest('hex'); }

export async function withSyntheticWorkspace(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(),'deepseek-bridge-long-session-'));
  const markers=[];
  const hashes=new Map();
  try {
    for(let index=1;index<=12;index+=1){
      const number=String(index).padStart(2,'0');
      const marker=`LS${number}_${randomBytes(6).toString('hex')}`;
      const name=`part-${number}.txt`;
      const content=`Synthetic document ${number}\nMarker: ${marker}\n`+`Neutral synthetic observations about stars, colors, shapes, and numbered samples ${number}.\n`.repeat(80);
      markers.push(marker); hashes.set(name,hash(content)); await writeFile(path.join(directory,name),content,'utf8');
    }
    const rules=['# Read-only experiment','- Only read files in this temporary directory.','- Never modify or create files.','- Never use Bash, Write, Edit, or NotebookEdit.','- Never install packages or access the network.','- Never read files outside this temporary directory.'].join('\n');
    hashes.set('CLAUDE.md',hash(rules)); await writeFile(path.join(directory,'CLAUDE.md'),rules,'utf8');
    const sizes=await Promise.all([...hashes.keys()].map(async name=>(await stat(path.join(directory,name))).size));
    const totalBytes=sizes.reduce((sum,size)=>sum+size,0);
    if(totalBytes>160*1024)throw new Error('Synthetic workspace exceeds its size limit.');
    const value=await run({directory,markers,totalBytes});
    let unchanged=true;
    for(const [name,digest] of hashes)if(!existsSync(path.join(directory,name))||hash(await readFile(path.join(directory,name)))!==digest)unchanged=false;
    return {...value,temporary_files_unchanged:unchanged,temporary_total_bytes:totalBytes};
  }finally{await rm(directory,{recursive:true,force:true});}
}

function tasks(markers){return[
  {p:'Use Read on part-01.txt and part-02.txt. Return only their short markers in file order.',e:[markers[0],markers[1]]},
  {p:'Use Read on part-03.txt and part-04.txt. Return only their short markers in file order.',e:[markers[2],markers[3]]},
  {p:'Use Glob to find all part text files, then Read part-05.txt. Return only its short marker.',e:[markers[4]]},
  {p:'Use Read on part-06.txt and part-07.txt. Return only their short markers in file order.',e:[markers[5],markers[6]]},
  {p:`Use Grep to find ${markers[7]} in this folder, then Read part-08.txt. Return only that marker.`,e:[markers[7]]},
  {p:'Use Read on part-09.txt. Return only its short marker.',e:[markers[8]]},
  {p:'Use Glob to list part text files, then Read part-10.txt. Return only its short marker.',e:[markers[9]]},
  {p:`Use Grep to find ${markers[10]} in this folder, then Read part-11.txt. Return only that marker.`,e:[markers[10]]},
  {p:'Forget the previous plan. Use Read and inspect only part-12.txt. Return its exact short marker.',e:[markers[11]],independent:true},
  {p:'Use Read on part-01.txt and part-12.txt. Return only their short markers in file order.',e:[markers[0],markers[11]]},
  {p:`Use Glob to list part text files, then use Grep to find ${markers[1]}. Return only the matched marker.`,e:[markers[1]]},
  {p:'Use Read on only part-06.txt. Return only its short marker.',e:[markers[5]]},
];}

export function buildClaudeArgs({sessionId,first,prompt}){
  const args=['--print','--output-format','stream-json','--verbose','--model','deepseek-reasoner','--strict-mcp-config','--setting-sources','project','--disable-slash-commands','--no-chrome','--tools',ALLOWED,'--allowedTools',ALLOWED,'--disallowedTools',DENIED];
  args.push(first?'--session-id':'--resume',sessionId,prompt); return args;
}

function childEnv(directory){
  const env={}; for(const name of ['SystemRoot','WINDIR','ComSpec','PATH','PATHEXT','TEMP','TMP'])if(typeof process.env[name]==='string')env[name]=process.env[name];
  return {...env,ANTHROPIC_BASE_URL:'http://127.0.0.1:9655',ANTHROPIC_AUTH_TOKEN:'local-long-session-probe-token',CLAUDE_CONFIG_DIR:path.join(directory,'.claude-config'),CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_TELEMETRY:'1',DISABLE_AUTOUPDATER:'1',DISABLE_UPDATES:'1'};
}

function messageCount(log){try{return parseBridgeDiagnostics(readFileSync(log,'utf8')).filter(r=>r.event==='tool_request'&&r.route==='/v1/messages').length;}catch{return 0;}}
function killOwned(child){if(!child?.pid)return;if(process.platform==='win32')spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else child.kill('SIGTERM');}

function runTurn({directory,sessionId,first,prompt,expected,log,timeoutMs}){
  const child=spawn('claude.cmd',buildClaudeArgs({sessionId,first,prompt}),{cwd:directory,env:childEnv(directory),shell:true,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let buffer='',stderr=false,limited=false;const events=[];child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk=>{buffer+=chunk;if(buffer.length>2*1024*1024){limited=true;killOwned(child);return;}const lines=buffer.split(/\r?\n/);buffer=lines.pop()||'';for(const line of lines){const safe=summarizeClaudeEvent(line,expected);if(safe)events.push(safe);}});
  child.stderr.on('data',chunk=>{if(chunk.length)stderr=true;});
  const monitor=setInterval(()=>{if(messageCount(log)>=MAX_REQUESTS){limited=true;killOwned(child);}},100);
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{killOwned(child);reject(new Error('Claude live turn timed out.'));},timeoutMs);
    child.once('error',error=>{clearTimeout(timer);clearInterval(monitor);reject(error);});
    child.once('close',(code,signal)=>{clearTimeout(timer);clearInterval(monitor);if(buffer){const safe=summarizeClaudeEvent(buffer,expected);if(safe)events.push(safe);}resolve({exit_code:code,signal,stderr_present:stderr,limit_reached:limited,event_types:[...new Set(events.map(e=>e.type))],tool_use_names:events.flatMap(e=>e.tool_use_names).slice(0,16),tool_result_count:events.reduce((n,e)=>n+e.tool_result_count,0),explicit_compaction:events.some(e=>e.explicit_compaction),explicit_recap:events.some(e=>e.explicit_recap),raw_tool_json_as_text:events.some(e=>e.raw_tool_json_as_text),expected_markers_observed:expected.map((_,i)=>events.some(e=>e.expected_markers_observed[i])),result_event_seen:events.some(e=>e.result_event),result_error_seen:events.some(e=>e.result_error)});});
  });
}

export async function runLongSessionExperiment({bridgeLogPath}){
  if(typeof bridgeLogPath!=='string'||!bridgeLogPath)throw new Error('Bridge diagnostic log is required.');
  return withSyntheticWorkspace(async({directory,markers})=>{
    await mkdir(path.join(directory,'.claude-config'),{recursive:true});
    const sessionId=randomUUID(),turns=[],plan=tasks(markers),started=Date.now();let seenDiagnostics=parseBridgeDiagnostics(existsSync(bridgeLogPath)?readFileSync(bridgeLogPath,'utf8'):'').length,seenTool=false,afterLifecycle=false,stop='turn_limit';
    for(let i=0;i<Math.min(MAX_TURNS,plan.length);i+=1){
      const elapsed=Date.now()-started;if(elapsed>=MAX_TOTAL_MS){stop='total_timeout';break;}if(messageCount(bridgeLogPath)>=MAX_REQUESTS){stop='message_request_limit';break;}
      const task=plan[i];const cli=await runTurn({directory,sessionId,first:i===0,prompt:task.p,expected:task.e,log:bridgeLogPath,timeoutMs:Math.min(MAX_TURN_MS,MAX_TOTAL_MS-elapsed)});
      const all=parseBridgeDiagnostics(readFileSync(bridgeLogPath,'utf8')),diagnostics=all.slice(seenDiagnostics);seenDiagnostics=all.length;
      const requests=diagnostics.filter(r=>r.event==='tool_request'),responses=diagnostics.filter(r=>r.event==='tool_response');if(responses.some(r=>r.outcome==='tool_call'))seenTool=true;
      const missing=seenTool&&requests.some(r=>!r.tools_field_present||r.normalized_tool_count===0);
      turns.push({turn:i+1,independent_task:task.independent===true,cli,bridge_diagnostics:diagnostics});
      if(afterLifecycle){stop='one_turn_after_lifecycle';break;}if(cli.explicit_compaction||cli.explicit_recap)afterLifecycle=true;
      if(cli.raw_tool_json_as_text){stop='raw_tool_json_as_text';break;}if(missing){stop='tools_missing_after_tool_calls';break;}if(cli.limit_reached||messageCount(bridgeLogPath)>=MAX_REQUESTS){stop='message_request_limit';break;}if(cli.exit_code!==0||cli.result_error_seen){stop='cli_error';break;}
    }
    const requests=turns.flatMap(t=>t.bridge_diagnostics).filter(r=>r.event==='tool_request'),refs=[...new Set(requests.map(r=>r.session_ref).filter(Boolean))],independent=turns.find(t=>t.independent_task);
    return {node_version:process.version,turns_completed:turns.length,message_request_count:requests.length,stop_reason:stop,explicit_compaction:turns.some(t=>t.cli.explicit_compaction),explicit_recap:turns.some(t=>t.cli.explicit_recap),session_ref_count:refs.length,session_ref_consistent:refs.length===1,raw_tool_json_as_text:turns.some(t=>t.cli.raw_tool_json_as_text),reasoning_retry_attempted:turns.some(t=>t.bridge_diagnostics.some(r=>r.reasoning_retry_attempted===true)),repeated_tool_retry_attempted:turns.some(t=>t.bridge_diagnostics.some(r=>r.repeated_tool_retry_attempted===true)),read_observed:turns.some(t=>t.cli.tool_use_names.includes('Read')),glob_observed:turns.some(t=>t.cli.tool_use_names.includes('Glob')),grep_observed:turns.some(t=>t.cli.tool_use_names.includes('Grep')),independent_task_completed:Boolean(independent&&independent.cli.exit_code===0&&independent.cli.expected_markers_observed.every(Boolean)),turns};
  });
}

async function main(){const i=process.argv.indexOf('--bridge-log');const result=await runLongSessionExperiment({bridgeLogPath:i>=0?process.argv[i+1]:''});process.stdout.write(`${JSON.stringify(result,null,2)}\n`);if(!result.temporary_files_unchanged||result.stop_reason==='cli_error'||result.stop_reason==='total_timeout')process.exitCode=1;}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)main().catch(()=>{process.stderr.write('Claude long-session live probe failed safely.\n');process.exitCode=1;});
