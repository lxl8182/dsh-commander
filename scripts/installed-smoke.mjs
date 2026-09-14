import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';
import { loadConfig, pluginRoot } from '../src/config.mjs';
const config=loadConfig();const root=process.env.DSH_TEST_PLUGIN_ROOT||pluginRoot;
const workspace=path.join(config.stateDir,'verification','installed-smoke');fs.mkdirSync(workspace,{recursive:true});
const client=new Client({name:'installed-plugin-smoke',version:'0.1.0'});
const noRoots=process.argv.includes('--no-roots');
if(!noRoots){
  client.registerCapabilities({roots:{listChanged:true}});
  client.setRequestHandler(ListRootsRequestSchema,()=>({roots:[{uri:pathToFileURL(workspace).href,name:'installed smoke workspace'}]}));
}
let taskId;const evidence={pluginRoot:root,noRoots,workspace,startedAt:new Date().toISOString()};
async function call(name,args={}){const r=await client.callTool({name,arguments:args},undefined,{timeout:160000});if(r.isError)throw new Error(r.content[0].text);return JSON.parse(r.content[0].text);}
try{
  const mcp=JSON.parse(fs.readFileSync(path.join(root,'.mcp.json'),'utf8')).mcpServers.dsh_commander;
  // Reproduce the desktop failure: plugin cwd, no roots, and a stale fallback.
  const env=noRoots?{...process.env,DSH_COMMANDER_WORKDIR:root}:undefined;
  await client.connect(new StdioClientTransport({command:process.execPath,args:mcp.args,cwd:path.resolve(root,mcp.cwd),env,stderr:'pipe'}));
  evidence.doctor=await call('dsh_doctor');
  assert.equal(evidence.doctor.provider,config.provider);assert.equal(evidence.doctor.model,config.model);
  const task=await call('dsh_start_task',{...(noRoots?{cwd:workspace}:{}),title:'安装副本验收',reasoningEffort:'low',requestId:randomUUID(),prompt:
    '这是安装副本的最终验收。请使用提示中给出的 Node.js 绝对路径，实际通过 PowerShell 执行 node 的 -e 参数，打印 INSTALLED_DSH_PLUGIN_OK。不要修改文件，不联网，不安装依赖。然后简短报告实际执行结果。'});
  taskId=task.taskId;let cursor=task.cursor;
  assert.equal(task.cwd,fs.realpathSync(workspace),'first dispatch must select the current task workspace');
  const deadline=Date.now()+180000;
  while(Date.now()<deadline){const result=await call('dsh_get_task',{taskId,cursor,waitMs:55000,waitFor:'actionable'});cursor=result.cursor;
    if(result.status==='waiting_permission')throw new Error('Unexpected pending permission in installed smoke');
    if(['completed','failed','cancelled','interrupted'].includes(result.status)){
      assert.equal(result.status,'completed',result.error);
      // Compact view returns the structured report; the full body stays in the artifact.
      const raw=fs.readFileSync(result.artifacts.result,'utf8');assert.match(raw,/INSTALLED_DSH_PLUGIN_OK/);
      assert.equal(result.reportState,'returned');
      assert.equal(result.resultFallback,false,'DS must follow the injected report contract');
      assert.equal(result.report?.outcome,'done');
      assert.ok(result.report.checks.some(check=>check.status==='pass'&&check.command),'must report an executed check');
      assert.ok(fs.existsSync(result.artifacts.report));
      const duplicate=await call('dsh_get_task',{taskId,afterResultVersion:String(result.resultVersion)});
      assert.equal(duplicate.reportState,'omitted');assert.equal(duplicate.report,null);
      assert.equal(duplicate.artifacts.report,result.artifacts.report);
      const events=fs.readFileSync(result.artifacts.events,'utf8');assert.match(events,/"title":"pwsh"/);
      evidence.report={outcome:result.reportOutcome,fallback:result.resultFallback,reason:result.resultFallbackReason};
      evidence.result={status:result.status,provider:result.provider,model:result.model,sessionId:result.sessionId,resultVersion:result.resultVersion,report:result.report,finalText:result.finalText};
      console.log(JSON.stringify({ok:true,provider:result.provider,model:result.model,sessionId:result.sessionId,reportState:result.reportState,report:result.report},null,2));break;
    }
  }
  if(!evidence.result)throw new Error('Installed smoke deadline');
  // Tiny follow-up proves native session continuity and contract injection on
  // continue. No tools or network are required for this second turn.
  const previous=evidence.result;
  const continued=await call('dsh_continue_task',{taskId,requestId:randomUUID(),prompt:'继续上一轮验收。不要调用任何工具、读文件或联网。请根据本会话记忆，在报告 summary 中准确复述上一轮命令打印的验收标记；changedFiles/checks/unresolved 用空数组，decision 用 null。'});
  assert.equal(continued.report,null,'continue should not repeat the prior report');
  const continuationDeadline=Date.now()+180000;
  while(Date.now()<continuationDeadline){
    const next=await call('dsh_get_task',{taskId,afterResultVersion:String(previous.resultVersion),waitMs:55000});
    if(['completed','failed','cancelled','interrupted'].includes(next.status)){
      assert.equal(next.status,'completed');assert.equal(next.resultFallback,false);
      assert.equal(next.sessionId,previous.sessionId);assert.ok(next.resultVersion>previous.resultVersion);
      assert.match(next.report.summary,/INSTALLED_DSH_PLUGIN_OK/);
      evidence.continuation={sessionId:next.sessionId,resultVersion:next.resultVersion,report:next.report};break;
    }
    if(next.status==='waiting_permission')throw new Error('Unexpected follow-up permission');
  }
  assert.ok(evidence.continuation,'follow-up deadline');
  console.log(JSON.stringify({continuationOk:true,resultVersion:evidence.continuation.resultVersion}));
}catch(e){evidence.error=e.message;throw e;}finally{if(taskId)await call('dsh_close_task',{taskId}).catch(()=>{});await client.close().catch(()=>{});evidence.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(workspace,'evidence-'+Date.now()+'.json'),JSON.stringify(evidence,null,2));}
