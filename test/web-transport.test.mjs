import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, createHmac } from 'node:crypto';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { DshWebTransport, localWebUrl, ownerCookie } from '../src/web-transport.mjs';

async function fixture(t, respond) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-web-transport-'));
  const secret=randomBytes(32).toString('base64url');
  fs.writeFileSync(path.join(home,'.credentials.yaml'),JSON.stringify({records:{'client-connection/browser-session':{kind:'grant',payload:{version:1,secret}}}}));
  const server=http.createServer(respond);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  t.after(()=>{server.closeAllConnections();server.close();fs.rmSync(home,{recursive:true,force:true});});
  return {home,secret,server,url,transport:new DshWebTransport({dshHome:home,dshWebUrl:url})};
}

test('owner grant is scoped to loopback authority and signed without disclosure',async t=>{
  for(const url of ['https://example.com','http://127.0.0.1/path','http://user@localhost','http://localhost?x=1'])assert.throws(()=>localWebUrl(url));
  const f=await fixture(t,()=>{});
  const cookie=ownerCookie(f.home,f.url,1000);
  const [version,body,signature]=cookie.split('=')[1].split('.');
  assert.equal(version,'v1');
  assert.deepEqual(JSON.parse(Buffer.from(body,'base64url')),{version:1,authority:new URL(f.url).host,issuedAt:1000,expiresAt:301000});
  assert.equal(signature,createHmac('sha256',Buffer.from(f.secret,'base64url')).update(body).digest('base64url'));
  assert.ok(!cookie.includes(f.secret));
});

test('RPC uses the DSH envelope and forwards event result args unchanged',async t=>{
  const seen=[];
  const f=await fixture(t,async(req,res)=>{
    let body='';for await(const data of req)body+=data;
    const message=JSON.parse(body);seen.push({message,cookie:req.headers.cookie});
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({type:'server-response',rpcId:message.rpcId,result:{ok:true,value:{accepted:true}}}));
  });
  const args={clientId:'client',eventId:'event',outcome:{kind:'next'}};
  assert.deepEqual(await f.transport.rpc('$events/result',args),{accepted:true});
  assert.equal(seen[0].message.type,'client-request');
  assert.equal(seen[0].message.method,'$events/result');
  assert.deepEqual(seen[0].message.payload,{args});
  assert.match(seen[0].cookie,/^dsh-auth-/);
});

test('stream supplies the baseline once and reports abrupt closure',async t=>{
  const f=await fixture(t,()=>{});
  const ws=new WebSocketServer({server:f.server});t.after(()=>ws.close());
  let peer;
  ws.on('connection',socket=>{peer=socket;socket.on('message',data=>{
    const open=JSON.parse(data);
    socket.send(JSON.stringify({type:'item',streamId:open.streamId,value:{type:'baseline',value:{items:[]}}}));
  });});
  const stream=f.transport.stream('workspace/follow',{});t.after(()=>stream.close());
  const baseline=await stream.ready;
  assert.deepEqual(await stream.events.next(),{done:false,value:baseline});
  peer.terminate();
  await assert.rejects(stream.events.next(),/closed/);
});

test('stream ending before its first frame rejects readiness',async t=>{
  const f=await fixture(t,()=>{});
  const ws=new WebSocketServer({server:f.server});t.after(()=>ws.close());
  ws.on('connection',socket=>socket.on('message',data=>{
    socket.send(JSON.stringify({type:'end',streamId:JSON.parse(data).streamId}));
  }));
  const stream=f.transport.stream('workspace/follow',{});t.after(()=>stream.close());
  await assert.rejects(stream.ready,/ended before ready/);
});
