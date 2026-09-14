import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';
import { loadConfig, pluginRoot } from '../src/config.mjs';
import { rpc, ensureDaemon } from '../src/ipc.mjs';
const config=loadConfig();const runId=randomUUID();
const workspace=path.join(config.stateDir,'verification',runId);fs.mkdirSync(workspace,{recursive:true});
let client;let taskId;const evidence={runId,workspace,checks:[],startedAt:new Date().toISOString()};
async function connect(){const c=new Client({name:'dsh-commander-e2e',version:'0.1.0'});
  c.registerCapabilities({roots:{listChanged:true}});
  c.setRequestHandler(ListRootsRequestSchema,()=>({roots:[{uri:pathToFileURL(workspace).href,name:'e2e workspace'}]}));
  const env={};
  for(const name of ['DSH_COMMANDER_HOME','DSH_COMMANDER_CONFIG','DSH_HOME','DSH_COMMANDER_WORKDIR'])if(process.env[name])env[name]=process.env[name];
  await c.connect(new StdioClientTransport({command:process.execPath,args:[path.join(process.env.DSH_TEST_PLUGIN_ROOT||pluginRoot,'dist/server.mjs')],stderr:'pipe',env}));return c;}
async function call(name,args={}){const r=await client.callTool({name,arguments:args},undefined,{timeout:160000});if(r.isError)throw new Error(r.content[0].text);return JSON.parse(r.content[0].text);}
async function finish(id){
  // Every poll sends the cursor (or an empty page for fresh clients) but never
  // asks for events: compact diagnostics come from the artifacts when needed.
  let cursor=0;const until=Date.now()+300000;let waited=false;
  while(Date.now()<until){
    const r=await call('dsh_get_task',{taskId:id,cursor,waitMs:waited?15000:0});
    cursor=r.cursor;
    console.log(JSON.stringify({taskId:id,status:r.status,cursor,reportState:r.reportState,outcome:r.reportOutcome,fallback:r.resultFallback}));
    if(r.status==='waiting_permission'){
      // Only the isolated verification directory and the prescribed local test command are authorized here.
      for(const p of r.pendingPermissions){const safe=!/delete|remove|network|http|install/i.test(p.title+' '+p.input);
        if(!safe)throw new Error('Unexpected permission in verification: '+p.title);
        await call('dsh_respond_permission',{taskId:id,permissionId:p.id,allow:true});}
    }
    if(['completed','failed','cancelled','interrupted','closed'].includes(r.status))return r;
    if(!waited){waited=true;continue;}
  }
  throw new Error('E2E task deadline exceeded');}
try{
  client=await connect();const tools=await client.listTools();assert.equal(tools.tools.length,8);
  evidence.doctor=await call('dsh_doctor');assert.equal(evidence.doctor.provider,config.provider);assert.equal(evidence.doctor.model,config.model);
  evidence.checks.push('MCP handshake, eight tools, pinned configured route');
  const first=await call('dsh_start_task',{title:'插件验收：文件与测试',requestId:runId+'-first',reasoningEffort:'low',prompt:
    '这是插件验收。在当前工作目录新建 calc.mjs，导出 add(a,b) 返回 a+b；新建 verify.mjs，用 node:assert/strict 断言 add(2,3) 等于 5，然后打印 DSH_TEST_OK。必须实际写文件，并通过 shell 运行 node verify.mjs。只能操作当前目录，不联网、不安装依赖。完成后简短报告。请记住本次会话口令是 BLUE_RIVER_714，但不要把口令写到文件中。'});
  taskId=first.taskId;const repeated=await call('dsh_start_task',{title:'插件验收：文件与测试',requestId:runId+'-first',reasoningEffort:'low',prompt:
    '这是插件验收。在当前工作目录新建 calc.mjs，导出 add(a,b) 返回 a+b；新建 verify.mjs，用 node:assert/strict 断言 add(2,3) 等于 5，然后打印 DSH_TEST_OK。必须实际写文件，并通过 shell 运行 node verify.mjs。只能操作当前目录，不联网、不安装依赖。完成后简短报告。请记住本次会话口令是 BLUE_RIVER_714，但不要把口令写到文件中。'});
  assert.equal(repeated.taskId,taskId);evidence.checks.push('Idempotent submission');
  await client.close();client=await connect();evidence.checks.push('MCP disconnect/reconnect while task runs');
  const result1=await finish(taskId);assert.equal(result1.status,'completed',result1.error);assert.ok(fs.existsSync(path.join(workspace,'calc.mjs')));
  assert.match(fs.readFileSync(result1.artifacts.events,'utf8'),/"type":"tool"/);
  // The compact contract asks every turn for a structured report; the raw
  // output artifact must keep whatever actually arrived.
  const rawFirst=fs.readFileSync(result1.artifacts.result,'utf8');assert.ok(rawFirst.length>0);
  evidence.reportFirst={state:result1.reportState,outcome:result1.reportOutcome,fallback:result1.resultFallback,reason:result1.resultFallbackReason,version:result1.resultVersion};
  assert.equal(result1.reportState,'returned');
  const repeatedRead=await call('dsh_get_task',{taskId,cursor:result1.cursor,afterResultVersion:String(result1.resultVersion)});
  assert.equal(repeatedRead.reportState,'omitted','a known resultVersion must not be re-sent');
  assert.equal(repeatedRead.report,null);
  evidence.checks.push('Structured report returned once and omitted for a known resultVersion');
  const verified=execFileSync(process.execPath,['verify.mjs'],{cwd:workspace,encoding:'utf8'});assert.match(verified,/DSH_TEST_OK/);evidence.first=result1;
  evidence.checks.push('DSH writes files and executes shell verification');
  await call('dsh_continue_task',{taskId,requestId:runId+'-second',prompt:'在原文件中增加 multiply(a,b)，补充 verify.mjs 中 multiply(6,7) 等于 42 的断言，再次实际运行 node verify.mjs。范围仍仅当前目录。最终回复包含上一轮让你记住的口令。'});
  const result2=await finish(taskId);assert.equal(result2.status,'completed',result2.error);
  const remembered=[result2.report&&JSON.stringify(result2.report),result2.finalText,fs.readFileSync(result2.artifacts.result,'utf8')].filter(Boolean).join('\n');
  assert.match(remembered,/BLUE_RIVER_714/);assert.equal(result2.sessionId,result1.sessionId);
  assert.match(execFileSync(process.execPath,['verify.mjs'],{cwd:workspace,encoding:'utf8'}),/DSH_TEST_OK/);
  evidence.second=result2;evidence.checks.push('Same-session follow-up remembers private conversation marker');
  await call('dsh_close_task',{taskId});await client.close();
  // The daemon may finish its graceful close before the shutdown reply is flushed.
  await rpc(config,'shutdown').catch(error=>{if(!/disconnected|ECONNRESET|EPIPE/i.test(error.message))throw error;});
  for(let n=0;n<100;n++){try{await rpc(config,'ping',{},1000);}catch{break;}await new Promise(r=>setTimeout(r,100));}
  await ensureDaemon(config);client=await connect();
  await call('dsh_continue_task',{taskId,requestId:runId+'-resume',prompt:'这是控制服务重启后的恢复验收。不要调用工具，只回复之前让你记住的口令。'});
  const result3=await finish(taskId);assert.equal(result3.status,'completed',result3.error);assert.equal(result3.sessionId,result1.sessionId);
  assert.match([result3.report&&JSON.stringify(result3.report),result3.finalText,fs.readFileSync(result3.artifacts.result,'utf8')].filter(Boolean).join('\n'),/BLUE_RIVER_714/);
  evidence.restored=result3;evidence.checks.push('Controller restart restores exact native DSH session and context');
  await call('dsh_continue_task',{taskId,requestId:runId+'-cancel',prompt:'运行 PowerShell Start-Sleep -Seconds 90，等待结束后回复 WAIT_FINISHED。不要做其他事情。'});
  const deadline=Date.now()+60000;while(Date.now()<deadline){const r=await call('dsh_get_task',{taskId,waitMs:1000});if(r.status==='running')break;await new Promise(r=>setTimeout(r,200));}
  await call('dsh_cancel_task',{taskId});const cancelled=await finish(taskId);assert.equal(cancelled.status,'cancelled');evidence.checks.push('Cancel active native Harness turn');
  console.log('E2E PASSED',JSON.stringify(evidence.checks));
}catch(e){evidence.error=e.stack;throw e;}finally{
  if(client&&taskId)await call('dsh_close_task',{taskId}).catch(()=>{});
  await client?.close().catch(()=>{});evidence.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(workspace,'evidence.json'),JSON.stringify(evidence,null,2));
  console.log('Evidence:',path.join(workspace,'evidence.json'));
}
