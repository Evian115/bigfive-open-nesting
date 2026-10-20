import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config, defaultFields, dimensions } from '../server/config.mjs';
import { Store } from '../server/store.mjs';
import { extractReport } from '../server/report.mjs';
import { Worker } from '../server/worker.mjs';
import { DingtalkClient, dingFields } from '../server/dingtalk.mjs';
const html=readFileSync(new URL('./fixtures/report.html',import.meta.url),'utf8');
const cfg=config({});
const report=extractReport(html,'demo0001',cfg.upstreamOrigin);
function setup(t) {
 const dir=mkdtempSync(join(tmpdir(),'nest-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 return new Store(dir);
}
function accepted(store,session=store.newSession(),id=randomUUID()) {
 const claim=store.begin(id,session,'hash');store.accept(id,claim.token,'demo0001','{"id":"demo0001"}',201);return {id,session};
}
const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
test('原站报告提取五维原始整数，缺少维度/身份/冲突时拒绝采集',()=>{
 assert.deepEqual([report.openness,report.conscientiousness,report.extraversion,report.agreeableness,report.neuroticism],[78,82,28,52,34]);
 assert.equal(report.result_url,'https://bigfivepersonality.me/zh/r/demo0001');
 assert.throws(()=>extractReport(html,'notdemo1',cfg.upstreamOrigin),/Identity/);
 assert.throws(()=>extractReport(html.replace('78','101'),'demo0001',cfg.upstreamOrigin),/Scores/);
 assert.throws(()=>extractReport(html.replace('scores','none'),'demo0001',cfg.upstreamOrigin),/Scores/);
});
test('只去重同一次提交，不合并相同分数的独立测评；回执与任务跨重启保留',t=>{
 let store=setup(t);const a=accepted(store),b=accepted(store,a.session);
 assert.equal(store.begin(a.id,a.session,'hash').replay.upstream_id,'demo0001');
 assert.equal(store.begin(a.id,a.session,'changed').conflict,true);
 assert.equal(store.begin(a.id,store.newSession(),'hash').conflict,true);
 for(let n=0;n<2;n++)store.capture(store.claim('submissions'),report);
 assert.equal(store.all().length,2);assert.notEqual(store.getSubmission(a.id).delivery.client_token,store.getSubmission(b.id).delivery.client_token);
 store=new Store(store.directory);assert.equal(store.status(a.id,a.session).saved,true);
 assert.equal(store.session(a.session),true);assert.equal(store.session(a.session.slice(0,-1)+'0'),false);
 assert.equal(store.status(a.id,store.newSession()),null);
});
test('超时未确认原站回执不会盲目重发；原站明确拒绝后允许同一提交重试',t=>{
 const store=setup(t),session=store.newSession(),id=randomUUID();const claim=store.begin(id,session,'h',1000);
 assert.equal(store.begin(id,session,'h',1001).busy,true);
 assert.equal(store.begin(id,session,'h',62000).uncertain,true);
 assert.equal(store.begin(id,session,'h',63000).uncertain,true);
 const other=randomUUID(),c=store.begin(other,session,'h');store.reject(other,c.token,false,'UpstreamHttp429');
 assert.ok(store.begin(other,session,'h').token);assert.ok(claim.token);
});
test('采集故障持续重试，成功后原子保存分数与投递任务',async t=>{
 const store=setup(t),{id,session}=accepted(store);let fail=true;
 const worker=new Worker(store,{...cfg,retryBaseMs:1},{fetcher:async()=>fail?new Response('error',{status:503}):new Response(html,{headers:{'content-type':'text/html'}})});
 await worker.tick();assert.equal(store.status(id,session).saved,false);assert.equal(store.getSubmission(id).attempts,1);
 fail=false;await new Promise(r=>setTimeout(r,5));await worker.tick();assert.equal(store.status(id,session).saved,true);assert.equal(store.status(id,session).sync,'pending');
 assert.equal(store.result(id).openness,78);
});
test('回传失败重启续传，token与字段快照不变，成功移除暂存分数',async t=>{
 let store=setup(t);const {id,session}=accepted(store);store.capture(store.claim('submissions'),report);
 const settings={appKey:'x',appSecret:'y',operatorId:'z',baseId:'base',sheetId:'sheet',fields:config({}).dingtalk?.fields};
 // The production map is supplied by config, use the mapper defaults here.
 const calls=[];let fails=true;
 const client={insert:async task=>{calls.push(task);if(fails)throw new Error('NetworkOrTimeout');return 'remote123';}};
 let worker=new Worker(store,{...cfg,dingtalk:settings,retryBaseMs:1},{dingClient:client});
 await worker.tick();assert.equal(store.status(id,session).sync,'retrying');
 store=new Store(store.directory);fails=false;await new Promise(r=>setTimeout(r,5));worker=new Worker(store,{...cfg,dingtalk:settings},{dingClient:client});await worker.tick();
 assert.equal(calls.length,2);assert.equal(calls[0].client_token,calls[1].client_token);assert.equal(calls[0].fields_json,calls[1].fields_json);
 assert.equal(store.status(id,session).sync,'synced');assert.equal(store.result(id),undefined);assert.equal(store.getSubmission(id).delivery.fields_json,undefined);
 await worker.tick();assert.equal(calls.length,2);
});
test('未过期租约不被重复领取；过期任务恢复；旧租约不能确认成功',t=>{
 const store=setup(t);const {id}=accepted(store);store.capture(store.claim('submissions'),report);
 const first=store.claim('outbox',1000);assert.equal(store.claim('outbox',1001),null);
 const second=store.claim('outbox',62000);assert.notEqual(first.lease_token,second.lease_token);
 store.delivered(first,'bad');assert.notEqual(store.getSubmission(id).delivery.state,'synced');
 store.delivered(second,'good');assert.equal(store.getSubmission(id).delivery.remote_id,'good');
});
test('更改钉钉目标不会把已尝试过的旧任务写入另一张表',async t=>{
 const store=setup(t);const {id}=accepted(store);store.capture(store.claim('submissions'),report);
 const row=store.claim('outbox');store.bindTarget(row,{baseId:'old',sheetId:'old'},dingFields(report));store.failed('outbox',row,'Network',0);
 let called=false;const worker=new Worker(store,{...cfg,dingtalk:{baseId:'new',sheetId:'new'}},{dingClient:{insert:async()=>{called=true;return 'x';}}});
 await worker.tick();assert.equal(called,false);assert.equal(store.getSubmission(id).delivery.last_error,'DingTalkTargetChanged');
});
test('钉钉真实协议：重复 clientToken 必须核验并恢复记录 ID，不能直接当成功',async()=>{
 const fields=dingFields({...report,created_at:123,updated_at:123}), calls=[];
 const client=new DingtalkClient({appKey:'a',appSecret:'b',operatorId:'u'},{fetcher:async(url,init)=>{
  calls.push({url:String(url),body:JSON.parse(init.body)});
  if(String(url).endsWith('accessToken'))return response({accessToken:'private-token',expireIn:7200});
  assert.equal(init.headers['x-acs-dingtalk-access-token'],'private-token');
  if(String(url).includes('/records/list'))return response({records:[{id:'remote-id',fields}],hasMore:false});
  return response({code:'invalidRequest.duplicateClientToken'},400);
 }});
 const task={target_base:'base',target_sheet:'sheet',client_token:'abc123',fields_json:JSON.stringify(fields)};
 assert.equal(await client.insert(task),'remote-id');assert.match(calls[1].url,/clientToken=abc123/);assert.doesNotMatch(calls[2].url,/clientToken=/);
 const missing=new DingtalkClient({},{fetcher:async url=>String(url).endsWith('accessToken')?response({accessToken:'t',expireIn:60}):String(url).includes('/list')?response({records:[],hasMore:false}):response({code:'invalidRequest.duplicateClientToken'},400)});
 await assert.rejects(()=>missing.insert(task),/DuplicateRecordNotFound/);
});
test('钉钉仅在明确返回记录 ID 后成功，401 刷新 token 且保留 clientToken',async()=>{
 let tokens=0,inserts=0;const urls=[];
 const client=new DingtalkClient({appKey:'a',appSecret:'b',operatorId:'u'},{fetcher:async url=>{
  if(String(url).endsWith('accessToken'))return response({accessToken:`t${++tokens}`,expireIn:7200});
  urls.push(String(url));if(++inserts===1)return response({},401);return response({value:[{id:'remote'}]});
 }});
 assert.equal(await client.insert({target_base:'a',target_sheet:'b',client_token:'same',fields_json:'{}'}),'remote');
 assert.equal(tokens,2);assert.equal(urls[0],urls[1]);
 const malformed=new DingtalkClient({},{fetcher:async url=>String(url).endsWith('accessToken')?response({accessToken:'t',expireIn:60}):response({value:[]})});
 await assert.rejects(()=>malformed.insert({target_base:'a',target_sheet:'b',client_token:'same',fields_json:'{}'}),/InvalidInsertResponse/);
});
test('配置不允许部分凭据、重复字段名或非固定上游地址',()=>{
 assert.throws(()=>config({DINGTALK_APP_KEY:'a'}),/Missing/);assert.equal(config({}).dingtalk,null);
 assert.throws(()=>config({DINGTALK_FIELD_MAP:'{"openness":"链接"}'}),/Duplicate/);
 assert.throws(()=>config({UPSTREAM_ORIGIN:'https://example.com/path'}),/UPSTREAM/);
});
test('人格类型直接读取原站中文标题，不按五维分数分类；缺失、错配或冲突拒绝采集',()=>{
 assert.equal(report.personality_type,'架构师');
 for(const title of ['探索家','温柔智者'])assert.equal(extractReport(html.replaceAll('架构师',title),'demo0001',cfg.upstreamOrigin).personality_type,title);
 assert.throws(()=>extractReport(html.replaceAll('title','missingTitle'),'demo0001',cfg.upstreamOrigin),/Personality/);
 const conflicting='<script>self.__next_f.push('+JSON.stringify([1,'3:'+JSON.stringify(['$','archetype',null,{resultId:'demo0001',title:'探索家',archetypeMinor:'explorer'}])+'\n'])+')</script>';
 assert.throws(()=>extractReport(html+conflicting,'demo0001',cfg.upstreamOrigin),/Personality/);
 assert.equal(dingFields(report).人格类型,'架构师');
 assert.throws(()=>dingFields({...report,personality_type:undefined}),/MissingPersonality/);
});
test('历史未投递任务补读原站类型，保留原分数、时间与幂等令牌',async t=>{
 const store=setup(t),{id}=accepted(store),legacy={...report};delete legacy.personality_type;
 store.capture(store.claim('submissions'),legacy);
 const before=store.getSubmission(id);let sent;
 const worker=new Worker(store,{...cfg,dingtalk:{baseId:'b',sheetId:'s'}},{fetcher:async()=>new Response(html,{headers:{'content-type':'text/html'}}),dingClient:{insert:async task=>{sent=task;return 'remote';}}});
 await worker.tick();assert.equal(store.getSubmission(id).delivery.state,'synced');
 const fields=JSON.parse(sent.fields_json);assert.equal(fields.人格类型,'架构师');assert.equal(fields.开放性,before.pending_result.openness/100);assert.equal(fields.写入时间,before.pending_result.created_at);assert.equal(sent.client_token,before.delivery.client_token);
});
test('补读报告分数变化或旧字段快照已投递时保留失败任务，避免错误内容或重复写入',async t=>{
 for(const bound of [false,true]){
  const store=setup(t),{id}=accepted(store),legacy={...report};delete legacy.personality_type;
  store.capture(store.claim('submissions'),legacy);
  if(bound){const claim=store.claim('outbox');store.bindTarget(claim,{baseId:'b',sheetId:'s'},{开放性:78});store.failed('outbox',claim,'Network',0);}
  let sent=false;
  const worker=new Worker(store,{...cfg,dingtalk:{baseId:'b',sheetId:'s'}},{fetcher:async()=>new Response(html.replace('78','77'),{headers:{'content-type':'text/html'}}),dingClient:{insert:async()=>{sent=true;return 'wrong';}}});
  await worker.tick();assert.equal(sent,false);assert.equal(store.getSubmission(id).delivery.last_error,bound?'LegacySnapshotNeedsReview':'ReportChanged');
 }
});
test('重复钉钉令牌核验包含人格类型，类型不一致不能判为回传成功',async()=>{
 const fields=dingFields({...report,created_at:123,updated_at:123});
 const client=new DingtalkClient({},{fetcher:async url=>String(url).endsWith('accessToken')?response({accessToken:'t',expireIn:60}):String(url).includes('/list')?response({records:[{id:'wrong',fields:{...fields,人格类型:'探索家'}}],hasMore:false}):response({code:'invalidRequest.duplicateClientToken'},400)});
 await assert.rejects(()=>client.insert({target_base:'b',target_sheet:'s',client_token:'same',fields_json:JSON.stringify(fields)}),/DuplicateRecordNotFound/);
});
test('钉钉使用带连字符的 UUID，历史32位令牌确定性兼容且重试不变',async()=>{
 const raw='456d963997904b6bbb2e0f2197d26470',urls=[];
 const client=new DingtalkClient({},{fetcher:async url=>{
  if(String(url).endsWith('accessToken'))return response({accessToken:'t',expireIn:60});urls.push(new URL(url).searchParams.get('clientToken'));return response({value:[{id:'ok'}]});
 }});
 const task={target_base:'b',target_sheet:'s',client_token:raw,fields_json:'{}'};
 await client.insert(task);await client.insert(task);
 assert.deepEqual(urls,['456d9639-9790-4b6b-bb2e-0f2197d26470','456d9639-9790-4b6b-bb2e-0f2197d26470']);assert.equal(task.client_token,raw);
});
test('描述只采集当前类型标题下的短句和正文，保留原文分段',()=>{
 assert.equal(report.description,'高开放 + 高尽责 + 低外向 —— 先搭起来，再慢慢打磨。\n\n你不是只有想法，你会给想法画出一整套系统。你的草稿有草稿。人群让你累，白板不会。你是那种能把乱成一团的问题拎出一个干净形状，再一遍遍打磨到漂亮的人。');
 assert.deepEqual(dingFields(report).描述,{markdown:report.description});
 const unrelated='<script>self.__next_f.push('+JSON.stringify([1,'4:'+JSON.stringify(['$','p',null,{children:'其他类型和其他页面的说明'}])+'\n'])+')</script>';
 assert.equal(extractReport(html+unrelated,'demo0001',cfg.upstreamOrigin).description,report.description);
 assert.throws(()=>extractReport(html.replace('高开放 + 高尽责 + 低外向 —— 先搭起来，再慢慢打磨。',''),'demo0001',cfg.upstreamOrigin),/Description/);
 assert.throws(()=>dingFields({...report,description:undefined}),/MissingDescription/);
});
test('同一类型正文冲突时停止采集，不拼接猜测描述',()=>{
 const conflicting='<script>self.__next_f.push('+JSON.stringify([1,'4:'+JSON.stringify(['$','section',null,{children:[['$','h1',null,{children:'架构师'}],['$','p',null,{children:'另一条短句'}],['$','p',null,{children:'另一段正文'}]]}])+'\n'])+')</script>';
 assert.throws(()=>extractReport(html+conflicting,'demo0001',cfg.upstreamOrigin),/Description/);
});
test('钉钉单选读回对象按名称核验，描述仍须完整一致',async()=>{
 const fields=dingFields({...report,created_at:123,updated_at:123});
 for(const correct of [true,false]){
  const client=new DingtalkClient({},{fetcher:async url=>String(url).endsWith('accessToken')?response({accessToken:'t',expireIn:60}):String(url).includes('/list')?response({records:[{id:'same',fields:{...fields,人格类型:{id:'choice1',name:'架构师'},描述:correct?fields.描述:'其他正文'}}],hasMore:false}):response({code:'invalidRequest.duplicateClientToken'},400)});
  const send=()=>client.insert({target_base:'b',target_sheet:'s',client_token:'same',fields_json:JSON.stringify(fields)});
  if(correct)assert.equal(await send(),'same');else await assert.rejects(send,/DuplicateRecordNotFound/);
 }
});
test('未投递旧任务缺少描述时从原报告补采，保留时间、类型、令牌',async t=>{
 const store=setup(t),{id}=accepted(store),legacy={...report};delete legacy.description;
 store.capture(store.claim('submissions'),legacy);const before=store.getSubmission(id);let sent;
 const worker=new Worker(store,{...cfg,dingtalk:{baseId:'b',sheetId:'s'}},{fetcher:async()=>new Response(html,{headers:{'content-type':'text/html'}}),dingClient:{insert:async task=>{sent=task;return 'remote';}}});
 await worker.tick();assert.equal(store.getSubmission(id).delivery.state,'synced');const fields=JSON.parse(sent.fields_json);
 assert.deepEqual(fields.描述,{markdown:report.description});assert.equal(fields.人格类型,legacy.personality_type);assert.equal(fields.写入时间,before.pending_result.created_at);assert.equal(sent.client_token,before.delivery.client_token);assert.equal(store.result(id),undefined);
});
test('百分比分数在发送时转换一次，原始整数和描述不变；支持各列独立格式',()=>{
 const result={...report,openness:0,conscientiousness:100,extraversion:42};
 const fields=dingFields(result);
 assert.equal(fields.开放性,0);assert.equal(fields.尽责性,1);assert.equal(fields.外向性,0.42);
 assert.equal(result.extraversion,42);assert.equal(result.description,report.description);
 const schema=Object.keys(dimensions).map(key=>({name:defaultFields[key],type:'number',property:{formatter:key==='extraversion'?'INTEGER':'PERCENT'}}));
 schema.push({name:'描述',type:'text'});
 const mixed=dingFields(result,defaultFields,schema);
 assert.equal(mixed.外向性,42);assert.equal(mixed.尽责性,1);assert.equal(mixed.描述,report.description);
 assert.throws(()=>dingFields({...report,openness:0.42}),/InvalidScore/);
 assert.throws(()=>dingFields(report,defaultFields,[]),/FieldMissing/);
 schema[0].type='text';assert.throws(()=>dingFields(report,defaultFields,schema),/ScoreFieldType/);
});
test('新任务读取字段元数据，失败不绑定快照或投递；重启重试复用已绑定的新格式',async t=>{
 let store=setup(t);const {id}=accepted(store);store.capture(store.claim('submissions'),report);
 let schemaReads=0;const payloads=[];
 const client={prepareFields:async result=>{schemaReads++;if(schemaReads===1)throw new Error('NetworkOrTimeout');return dingFields(result);},insert:async task=>{payloads.push(task.fields_json);if(payloads.length===1)throw new Error('NetworkOrTimeout');return 'remote';}};
 let worker=new Worker(store,{...cfg,dingtalk:{baseId:'b',sheetId:'s'},retryBaseMs:1},{dingClient:client});
 await worker.tick();assert.equal(payloads.length,0);assert.equal(store.getSubmission(id).delivery.fields_json,undefined);
 await new Promise(r=>setTimeout(r,5));await worker.tick();assert.equal(payloads.length,1);
 store=new Store(store.directory);worker=new Worker(store,{...cfg,dingtalk:{baseId:'b',sheetId:'s'},retryBaseMs:1},{dingClient:client});
 await new Promise(r=>setTimeout(r,5));await worker.tick();assert.equal(store.getSubmission(id).delivery.state,'synced');
 assert.equal(schemaReads,2);assert.equal(payloads[0],payloads[1]);assert.equal(JSON.parse(payloads[0]).开放性,0.78);
});
test('钉钉字段元数据使用认证 GET；未知响应不使用默认格式盲投',async()=>{
 const schema=Object.keys(dimensions).map(key=>({name:defaultFields[key],type:'number',property:{formatter:'PERCENT'}}));schema.push({name:'描述',type:'richText'});
 const client=new DingtalkClient({baseId:'b',sheetId:'s',operatorId:'u'},{fetcher:async(url,init)=>{
  if(String(url).endsWith('accessToken'))return response({accessToken:'t',expireIn:7200});
  assert.equal(init.method,'GET');assert.equal(init.body,undefined);assert.equal(init.headers['x-acs-dingtalk-access-token'],'t');assert.equal(new URL(url).searchParams.get('operatorId'),'u');return response({value:schema});
 }});
 assert.deepEqual(await client.prepareFields(report),dingFields(report));
 const invalid=new DingtalkClient({},{fetcher:async url=>String(url).endsWith('accessToken')?response({accessToken:'t',expireIn:60}):response({})});
 await assert.rejects(()=>invalid.prepareFields(report),/InvalidFieldSchemaResponse/);
});
test('富文本重试允许钉钉追加的末尾换行，正文变化、空值或缩放错误不能误报成功',async()=>{
 const fields=dingFields({...report,openness:0,created_at:123,updated_at:123});
 const good={...fields,描述:{markdown:report.description+'\n'},开放性:'0'};
 for (const [change,valid] of [[{},true],[{描述:{markdown:'其他正文\n'}},false],[{描述:{}},false],[{描述:report.description},false],[{开放性:null},false],[{开放性:''},false],[{尽责性:82},false]]) {
  const client=new DingtalkClient({},{fetcher:async url=>String(url).endsWith('accessToken')?response({accessToken:'t',expireIn:60}):String(url).includes('/list')?response({records:[{id:'same',fields:{...good,...change}}],hasMore:false}):response({code:'invalidRequest.duplicateClientToken'},400)});
  const replay=()=>client.insert({target_base:'b',target_sheet:'s',client_token:'same',fields_json:JSON.stringify(fields)});
  if(valid)assert.equal(await replay(),'same');else await assert.rejects(replay,/DuplicateRecordNotFound/);
 }
});
