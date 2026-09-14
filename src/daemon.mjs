import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { timingSafeEqual } from 'node:crypto';
import { loadConfig, pipePath, atomicJson, version } from './config.mjs';
import { controlToken } from './ipc.mjs';
import { TaskManager } from './manager.mjs';
import { validateOperation } from './tools.mjs';

const config=loadConfig();const token=controlToken(config);let manager;let stopping=false;
const server=net.createServer(socket=>{
  const decoder=new StringDecoder('utf8');let input='';let handled=false;
  socket.on('error',()=>{});
  socket.on('data',data=>{
    if(handled)return;input+=decoder.write(data);
    if(input.length>1_000_000){handled=true;socket.destroy();return;}
    const index=input.indexOf('\n');if(index<0)return;handled=true;
    void (async()=>{
      let reply;
      try{
        const request=JSON.parse(input.slice(0,index));
        const candidate=Buffer.from(String(request.token||''));const expected=Buffer.from(token);
        if(candidate.length!==expected.length||!timingSafeEqual(candidate,expected))throw new Error('Unauthorized local controller request');
        if(request.method==='ping')reply={version,pid:process.pid};
        else if(request.method==='shutdown'){reply={stopping:true};setTimeout(shutdown,100);}
        else {if(stopping)throw new Error('Controller is shutting down');reply=await manager.dispatch(request.method,validateOperation(request.method,request.args||{}));}
        if(!socket.destroyed)socket.end(JSON.stringify({result:reply})+'\n');
      }catch(e){if(!socket.destroyed)socket.end(JSON.stringify({error:e.message})+'\n');}
    })();
  });
});
server.on('error',e=>{if(e.code==='EADDRINUSE')process.exit(0);console.error(e.message);process.exit(1);});
// Bind first: concurrent starters must never load/mutate the same task store twice.
server.listen(pipePath(config),()=>{
  try{manager=new TaskManager(config);atomicJson(path.join(config.stateDir,'daemon.json'),{pid:process.pid,version,startedAt:new Date().toISOString()});
    if(process.platform!=='win32')fs.chmodSync(pipePath(config),0o600);
  }catch(e){console.error(e.stack);process.exit(1);}
});
async function shutdown(){if(stopping)return;stopping=true;server.close();await manager?.shutdown();process.exit(0);}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
