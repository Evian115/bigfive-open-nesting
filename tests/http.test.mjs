import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { config } from '../server/config.mjs';
import { Store } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
const cfg=config({}),fixture=readFileSync(new URL('./fixtures/report.html',import.meta.url),'utf8');
async function setup(t,fetcher,settings=cfg) {
 const dir=mkdtempSync(join(tmpdir(),'nest-http-')),store=new Store(dir),worker={tick:async()=>{}};
 const server=createApp({config:settings,store,worker,fetcher});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});});
 const origin=`http://127.0.0.1:${server.address().port}`;
 const home=await fetch(origin);const cookie=home.headers.get('set-cookie').split(';')[0];
 return {store,origin,cookie};
}
const input={answers:Array(50).fill(3),locale:'zh',startedAt:100,finishedAt:200};
function submitHeaders(origin,cookie,id) {return {origin,cookie,'content-type':'application/json','x-nesting-submission-id':id};}
test('统一入口和同源代理：保留原站页面、脚本、cookies、RSC 与资源',async t=>{
 const calls=[];const {origin,cookie}=await setup(t,async(url,init)=>{calls.push({url:String(url),init});return new Response(fixture.replace('<head>','<head><link href="https://bigfivepersonality.me/a.css">'),{headers:{'content-type':'text/html','x-frame-options':'DENY','content-encoding':'gzip','set-cookie':'NEXT_LOCALE=zh; Domain=bigfivepersonality.me; Path=/; SameSite=Lax'}});});
 const page=await fetch(origin+'/zh/test',{headers:{cookie}});const html=await page.text();
 assert.match(html,/<script src="\/_nest\/bridge.js"><\/script>/);assert.match(html,new RegExp(origin+'/a.css'));
 assert.equal(page.headers.get('x-frame-options'),null);assert.equal(page.headers.get('content-encoding'),null);assert.doesNotMatch(page.headers.get('set-cookie'),/Domain=/i);
 assert.equal(calls[0].url,'https://bigfivepersonality.me/zh/test');
});
test('同次并发提交只转发一次，重试返回同一原站回执，无需重算分数',async t=>{
 let posts=0;const {store,origin,cookie}=await setup(t,async()=>{posts++;await new Promise(r=>setTimeout(r,20));return new Response('{"id":"demo0001"}',{status:201,headers:{'content-type':'application/json'}});});
 const id=randomUUID(),headers=submitHeaders(origin,cookie,id);
 const responses=await Promise.all(Array.from({length:8},()=>fetch(origin+'/api/results',{method:'POST',headers,body:JSON.stringify(input)})));
 for(const r of responses){assert.equal(r.status,201);assert.deepEqual(await r.json(),{id:'demo0001'});}
 assert.equal(posts,1);assert.equal(store.all().length,1);
 const replay=await fetch(origin+'/api/results',{method:'POST',headers,body:JSON.stringify({...input,finishedAt:300})});assert.equal(replay.status,201);assert.equal(posts,1);
 const conflict=await fetch(origin+'/api/results',{method:'POST',headers,body:JSON.stringify({...input,answers:Array(50).fill(4)})});assert.equal(conflict.status,409);
 const status=await fetch(origin+`/_nest/submissions/${id}`,{headers:{cookie}});assert.equal((await status.json()).submission,'accepted');
 assert.equal((await fetch(origin+`/_nest/submissions/${id}`)).status,401);
});
test('原站 429 原样返回，不创建分数或回传任务；网络不确定不自动重发',async t=>{
 let fail=false,posts=0;const {store,origin,cookie}=await setup(t,async()=>{posts++;if(fail)throw new Error('network');return new Response('{"error":"Too fast"}',{status:429,headers:{'content-type':'application/json','retry-after':'30'}});});
 const id=randomUUID(),headers=submitHeaders(origin,cookie,id),url=origin+'/api/results';
 let response=await fetch(url,{method:'POST',headers,body:JSON.stringify(input)});assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'30');assert.equal(store.result(id),undefined);
 fail=true;response=await fetch(url,{method:'POST',headers,body:JSON.stringify(input)});assert.equal(response.status,502);
 response=await fetch(url,{method:'POST',headers,body:JSON.stringify(input)});assert.equal(response.status,409);assert.equal(posts,2);
});
test('禁止跨站提交、裸 API 写入与会话越权，不把本地 session 或伪造代理头传给原站',async t=>{
 let received;const {store,origin,cookie}=await setup(t,async(url,init)=>{received=init.headers;return new Response('{"id":"demo0001"}',{headers:{'content-type':'application/json'}});});
 const id=randomUUID(),url=origin+'/api/results';
 assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,403);
 assert.equal((await fetch(url,{method:'POST',headers:{...submitHeaders(origin,cookie,id),origin:'https://evil.example'},body:'{}'})).status,403);
 const headers={...submitHeaders(origin,cookie,id),'x-forwarded-for':'1.2.3.4','x-forwarded-host':'evil'};
 await fetch(url,{method:'POST',headers,body:JSON.stringify(input)});
 assert.equal(received.get('cookie'),null);assert.equal(received.get('x-forwarded-for'),null);assert.equal(received.get('x-nesting-submission-id'),null);assert.equal(received.get('origin'),cfg.upstreamOrigin);
 const other=store.newSession();assert.equal((await fetch(origin+`/_nest/submissions/${id}`,{headers:{cookie:`nest_session=${other}`}})).status,404);
});
test('原站成功但回执结构异常不显示成功，也不创建同步任务',async t=>{
 const {store,origin,cookie}=await setup(t,async()=>new Response('{}',{headers:{'content-type':'application/json'}}));
 const id=randomUUID(),r=await fetch(origin+'/api/results',{method:'POST',headers:submitHeaders(origin,cookie,id),body:JSON.stringify(input)});
 assert.equal(r.status,502);assert.equal(store.getSubmission(id).state,'uncertain');assert.equal(store.result(id),undefined);
});
test('代理资源读取超时只终止该响应，不导致整个服务退出',async t=>{
 let calls=0;
 const {origin,cookie}=await setup(t,async()=>{
  if(calls++===0)return new Response(new ReadableStream({start(controller){setTimeout(()=>controller.error(new DOMException('timeout','TimeoutError')),10);}}),{headers:{'content-type':'image/png'}});
  return new Response('OK',{headers:{'content-type':'text/plain'}});
 });
 await assert.rejects(async()=>{const response=await fetch(origin+'/slow.png',{headers:{cookie}});await response.arrayBuffer();});
 const health=await fetch(origin+'/_nest/health');assert.equal(health.status,200);
 const next=await fetch(origin+'/next.txt',{headers:{cookie}});assert.equal(await next.text(),'OK');
});
test('保留原站过快拒绝的具体原因并跨重启可查，不保存答案或创建回传任务',async t=>{
 const original={error:'too_fast',message:'Test completed suspiciously quickly'};
 const {store,origin,cookie}=await setup(t,async()=>new Response(JSON.stringify(original),{status:400,headers:{'content-type':'application/json'}}));
 const id=randomUUID();const r=await fetch(origin+'/api/results',{method:'POST',headers:submitHeaders(origin,cookie,id),body:JSON.stringify(input)});
 assert.equal(r.status,400);assert.deepEqual(await r.json(),original);
 const restarted=new Store(store.directory),state=restarted.status(id,cookie.slice('nest_session='.length));
 assert.equal(state.rejectionCode,'too_fast');assert.equal(state.rejectionReason,original.message);assert.equal(state.upstreamStatus,400);assert.equal(state.saved,false);assert.equal(state.sync,null);
 assert.equal(restarted.getSubmission(id).answers,undefined);assert.equal(restarted.getSubmission(id).delivery,undefined);
});
test('原站未返回错误说明时只记录 HTTP 状态，不推断拒绝原因',async t=>{
 const {store,origin,cookie}=await setup(t,async()=>new Response('<html>Unavailable</html>',{status:400}));
 const id=randomUUID();await fetch(origin+'/api/results',{method:'POST',headers:submitHeaders(origin,cookie,id),body:JSON.stringify(input)});
 const state=store.status(id,cookie.slice('nest_session='.length));assert.equal(state.upstreamStatus,400);assert.equal(state.rejectionCode,null);assert.equal(state.rejectionReason,null);
});
test('HTTPS 隧道按已配置外网来源提交并改写链接，不信任伪造转发来源',async t=>{
 const publicOrigin='https://assessment.example',settings=config({PUBLIC_ORIGIN:publicOrigin});let forwarded;
 const {origin,cookie}=await setup(t,async(url,init)=>{
  if(init.method==='POST'){forwarded=init.headers;return new Response('{"id":"demo0001"}',{status:201});}
  return new Response('<html><head></head><body>https://bigfivepersonality.me/zh/test</body></html>',{headers:{'content-type':'text/html'}});
 },settings);
 const home=await fetch(origin+'/',{headers:{host:'assessment.example'}});assert.match(home.headers.get('set-cookie'),/; Secure/);
 const page=await fetch(origin+'/zh',{headers:{host:'assessment.example'}});assert.match(await page.text(),/https:\/\/assessment.example\/zh\/test/);
 const accepted=await fetch(origin+'/api/results',{method:'POST',headers:submitHeaders(publicOrigin,cookie,randomUUID()),body:JSON.stringify(input)});
 assert.equal(accepted.status,201);assert.equal(forwarded.get('origin'),cfg.upstreamOrigin);
 const blocked=await fetch(origin+'/api/results',{method:'POST',headers:{...submitHeaders('https://evil.example',cookie,randomUUID()),'x-forwarded-proto':'https','x-forwarded-host':'assessment.example'},body:JSON.stringify(input)});
 assert.equal(blocked.status,403);assert.equal((await blocked.json()).error,'CrossOriginRequest');
});
test('额外明确配置的本机来源仍能提交，HTTP 本机 cookie 不强制 Secure',async t=>{
 const settings=config({PUBLIC_ORIGIN:'https://assessment.example',COOKIE_SECURE:'true'});
 const {origin,cookie}=await setup(t,async()=>new Response('{"id":"demo0001"}',{status:201}),settings);
 settings.additionalOrigins.push(origin);
 const home=await fetch(origin+'/');assert.doesNotMatch(home.headers.get('set-cookie'),/; Secure/);
 const submitted=await fetch(origin+'/api/results',{method:'POST',headers:submitHeaders(origin,cookie,randomUUID()),body:JSON.stringify(input)});
 assert.equal(submitted.status,201);
 assert.throws(()=>config({ADDITIONAL_ORIGINS:'http://localhost:8082'}),/requires PUBLIC_ORIGIN/);
 assert.throws(()=>config({PUBLIC_ORIGIN:'https://assessment.example',ADDITIONAL_ORIGINS:'http://localhost:8082/path'}),/Invalid ADDITIONAL_ORIGINS/);
});
