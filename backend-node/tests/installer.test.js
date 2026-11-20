import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { createInstaller } from '../bin/install.js';
import http from 'node:http';
import { Script } from 'node:vm';

test('Node web installer enforces Host/CSRF, serializes setup and closes after completion',async()=>{
  let calls=0,starts=0;
  const server=createInstaller({existingFile:path.join(os.tmpdir(),`absent-${randomBytes(12).toString('hex')}`),setup:async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,100));return {success:true,message:'done'}},start:async()=>{starts++;await new Promise(resolve=>setTimeout(resolve,50));return {open_url:'http://localhost:3000/vengg4/'}}}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const untrusted=await new Promise((resolve,reject)=>{const request=http.get(base,{headers:{Host:'evil.invalid'}},response=>{response.resume();resolve(response.statusCode)});request.on('error',reject)});
    assert.equal(untrusted,403);
    const page=await fetch(base),html=await page.text();assert.equal(page.status,200);assert.match(page.headers.get('cache-control'),/no-store/);
    assert.doesNotThrow(()=>new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]));
    const token=html.match(/const token="([a-f0-9]{64})"/)?.[1];assert.ok(token);
    const post=value=>fetch(`${base}/setup`,{method:'POST',headers:{'Content-Type':'application/json','X-Setup-Token':value},body:'{}'});
    assert.equal((await post('wrong')).status,403);
    const start=value=>fetch(`${base}/start`,{method:'POST',headers:{'Content-Type':'application/json','X-Setup-Token':value},body:'{}'});
    assert.equal((await start('wrong')).status,403);
    assert.equal((await start(token)).status,409);assert.equal(starts,0);
    const responses=await Promise.all([post(token),post(token)]);assert.deepEqual(responses.map(response=>response.status).sort(),[200,409]);assert.equal(calls,1);
    assert.equal((await fetch(base)).status,410);assert.equal((await post(token)).status,410);
    const ready=await Promise.all([start(token),start(token)]);assert.ok(ready.every(response=>response.status===200));assert.equal(starts,1);
    assert.equal((await ready[0].json()).open_url,'http://localhost:3000/vengg4/');
    const state=await(await fetch(`${base}/setup-status`)).json();assert.equal(state.application,'vengg4-web-setup');assert.match(state.installation,/^[a-f0-9]{64}$/);
  }finally{await new Promise(resolve=>server.close(resolve))}
});
