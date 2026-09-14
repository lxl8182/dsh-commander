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
client.registerCapabilities({roots:{listChanged:true}});
client.setRequestHandler(ListRootsRequestSchema,()=>({roots:[{uri:pathToFileURL(workspace).href,name:'installed smoke workspace'}]}));
let taskId;const evidence={pluginRoot:root,startedAt:new Date().toISOString()};
async function call(name,args={}){const r=await client.callTool({name,arguments:args},undefined,{timeout:160000});if(r.isError)throw new Error(r.content[0].text);return JSON.parse(r.content[0].text);}
try{
  const mcp=JSON.parse(fs.readFileSync(path.join(root,'.mcp.json'),'utf8')).mcpServers.dsh_commander;
  await client.connect(new StdioClientTransport({command:process.execPath,args:mcp.args,cwd:path.resolve(root,mcp.cwd),stderr:'pipe'}));
  evidence.doctor=await call('dsh_doctor');
  assert.equal(evidence.doctor.provider,config.provider);assert.equal(evidence.doctor.model,config.model);
  const task=await call('dsh_start_task',{title:'安装副本验收',reasoningEffort:'low',requestId:randomUUID(),prompt:
    '这是安装副本的最终验收。请使用提示中给出的 Node.js 绝对路径，实际通过 PowerShell 执行 node 的 -e 参数，打印 INSTALLED_DSH_PLUGIN_OK。不要修改文件，不联网，不安装依赖。然后简短报告实际执行结果。'});
  taskId=task.taskId;let cursor=task.cursor;
  const deadline=Date.now()+180000;
  while(Date.now()<deadline){const result=await call('dsh_get_task',{taskId,cursor,waitMs:10000});cursor=result.cursor;
    if(result.status==='waiting_permission')throw new Error('Unexpected pending permission in installed smoke');
    if(['completed','failed','cancelled','interrupted'].includes(result.status)){
      assert.equal(result.status,'completed',result.error);assert.match(result.result,/INSTALLED_DSH_PLUGIN_OK/);
      const events=fs.readFileSync(result.artifacts.events,'utf8');assert.match(events,/"title":"pwsh"/);
      evidence.result=result;console.log(JSON.stringify({ok:true,provider:result.provider,model:result.model,sessionId:result.sessionId,result:result.result},null,2));break;
    }
  }
  if(!evidence.result)throw new Error('Installed smoke deadline');
}catch(e){evidence.error=e.message;throw e;}finally{if(taskId)await call('dsh_close_task',{taskId}).catch(()=>{});await client.close();evidence.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(workspace,'evidence-'+Date.now()+'.json'),JSON.stringify(evidence,null,2));}
