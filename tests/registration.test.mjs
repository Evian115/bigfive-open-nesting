import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.mjs';
import {config,defaultFields} from '../server/config.mjs';
import {Registrations} from '../server/registrations.mjs';
import {DingtalkClient,dingFields} from '../server/dingtalk.mjs';
import {Worker} from '../server/worker.mjs';
import {extractReport} from '../server/report.mjs';
const schema=Object.entries(defaultFields).map(([key,name])=>({id:'field-'+key,name,type:({visitor_name:'text',visitor_phone:'telephone',created_at:'date',updated_at:'lastModifiedTime',description:'richText',personality_type:'singleSelect',result_url:'url'})[key]||'number',property:key==='personality_type'?{choices:[{name:'架构师',id:'architect'}]}:{formatter:'PERCENT'}}));
const contact={visitor_name:'两阶段联调访客',visitor_phone:'13912345678'};
const response=(data,status=200)=>new Response(JSON.stringify(data),{status});
const fixture=readFileSync(new URL('./fixtures/report.html',import.meta.url),'utf8');
function setup(t){const dir=mkdtempSync(join(tmpdir(),'nest-registration-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return {store:new Store(dir),settings:{...config({HR_PORTAL_ENABLED:'true'}),publicOrigin:'https://test.example',retryBaseMs:1,dingtalk:{appKey:'app',appSecret:'secret',baseId:'base',sheetId:'sheet',operatorId:'operator',fields:defaultFields}}};}
function remote(settings){
 const rows=[],tokens=new Map(),calls=[];let loseInsert=false,loseUpdate=false;
 const client=new DingtalkClient(settings.dingtalk,{fetcher:async(raw,options)=>{
  const url=new URL(raw),body=options.body&&JSON.parse(options.body);calls.push({path:url.pathname,method:options.method,body,clientToken:url.searchParams.get('clientToken')});
  if(url.pathname.endsWith('/accessToken'))return response({accessToken:'token',expireIn:7200});
  if(url.pathname.endsWith('/fields'))return response({value:schema});
  if(url.pathname.endsWith('/list'))return response({records:rows.map(r=>({...r,fields:{...r.fields}})),hasMore:false});
  if(options.method==='POST'){
   const token=url.searchParams.get('clientToken');if(tokens.has(token))return response({code:'invalidRequest.duplicateClientToken'},400);
   const row={id:'row-'+(rows.length+1),fields:{...body.records[0].fields}};rows.push(row);tokens.set(token,row.id);
   if(loseInsert){loseInsert=false;throw new Error('response dropped');}return response({value:[{id:row.id}]});
  }
  if(options.method==='PUT'){
   const patch=body.records[0],row=rows.find(r=>r.id===patch.id);if(!row)return response({code:'NotFound'},404);
   Object.assign(row.fields,patch.fields);if(loseUpdate){loseUpdate=false;throw new Error('response dropped');}return response({value:[{id:patch.id}]});
  }
  throw new Error('UnexpectedRequest');
 }});
 return {client,rows,calls,dropInsert(){loseInsert=true;},dropUpdate(){loseUpdate=true;}};
}
function capture(store,inv){const id=randomUUID(),session=store.newSession(),claim=store.begin(id,session,'hash',Date.now(),{invitation_id:inv.id,contact_cipher:inv.contact_cipher});store.accept(id,claim.token,'demo0001','{"id":"demo0001"}',201);store.capture(store.claim('submissions'),extractReport(fixture,'demo0001','https://bigfivepersonality.me'));return id;}
const pause=()=>new Promise(r=>setTimeout(r,8));

test('先登记三字段、确认后才发链接；同一请求并发和响应丢失重试均不新增登记行',async t=>{
 const {store,settings}=setup(t),r=remote(settings),queue=new Registrations(store,settings,{dingClient:r.client}),id=randomUUID();
 const inv=queue.create(contact,'owner',id);r.dropInsert();
 await Promise.all([queue.process(id),queue.process(id)]);
 assert.equal(r.rows.length,1);assert.deepEqual(Object.keys(r.rows[0].fields).sort(),['姓名','电话','写入时间'].sort());assert.equal(r.rows[0].fields.写入时间,inv.createdAt);
 const pending=queue.response(id,'owner',settings.publicOrigin);assert.equal(pending.state,'retrying');assert.equal(pending.url,undefined);
 assert.throws(()=>queue.response(id,'another-owner',settings.publicOrigin),/RegistrationNotFound/);
 assert.throws(()=>queue.create(contact,'another-owner',id),/RegistrationConflict/);
 assert.throws(()=>queue.create({...contact,visitor_phone:'13800138000'},'owner',id),/RegistrationConflict/);
 const saved=readFileSync(queue.path(id),'utf8');assert.ok(!saved.includes(contact.visitor_name)&&!saved.includes(contact.visitor_phone));assert.ok(queue.get(id).registration.fields_cipher);
 await pause();const restarted=new Registrations(new Store(store.directory),settings,{dingClient:r.client});
 assert.equal(restarted.create(contact,'owner',id).createdAt,inv.createdAt);await restarted.process(id);
 assert.equal(r.rows.length,1);assert.equal(restarted.get(id).registration.state,'synced');assert.equal(restarted.get(id).registration.fields_cipher,undefined);
 assert.ok(restarted.get(id).contact_cipher);assert.ok(restarted.response(id,'owner',settings.publicOrigin).url.startsWith(settings.publicOrigin+'/i#'));
 const inserts=r.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/records'));assert.equal(inserts.length,2);assert.equal(inserts[0].clientToken,inserts[1].clientToken);assert.deepEqual(inserts[0].body,inserts[1].body);
});

test('每次独立登记单独建行，同姓名电话也保持不同 UUID 和写入时间；表格变更不串投',async t=>{
 const {store,settings}=setup(t),r=remote(settings),queue=new Registrations(store,settings,{dingClient:r.client});
 const a=queue.create(contact,'owner'),b=queue.create(contact,'owner');assert.notEqual(a.id,b.id);assert.ok(b.createdAt>a.createdAt);
 await queue.process(a.id);await queue.process(b.id);assert.equal(r.rows.length,2);
 const c=queue.create(contact,'owner');r.dropInsert();await queue.process(c.id);const calls=r.calls.length;await pause();
 const changed=new Registrations(store,{...settings,dingtalk:{...settings.dingtalk,sheetId:'another'}},{dingClient:r.client});await changed.process(c.id);
 assert.equal(changed.get(c.id).registration.last_error,'DingTalkTargetChanged');assert.equal(r.calls.length,calls);
});

test('结果按姓名电话精确匹配并跨页取最大写入时间，不使用记录创建时间或列表顺序',async()=>{
 const settings={fields:defaultFields,baseId:'base',sheetId:'sheet'},pages=[
  [{id:'wrong-phone',fields:{姓名:contact.visitor_name,电话:'13800138000',写入时间:9999}},{id:'old',createdTime:99999,fields:{姓名:contact.visitor_name,电话:contact.visitor_phone,写入时间:1000}}],
  [{id:'wrong-name',fields:{姓名:'另一个人',电话:contact.visitor_phone,写入时间:9999}},{id:'newest',createdTime:1,fields:{姓名:contact.visitor_name,电话:contact.visitor_phone,写入时间:'2000'}}]
 ];let lists=0;
 const client=new DingtalkClient(settings,{fetcher:async(url,options)=>{
  if(String(url).endsWith('accessToken'))return response({accessToken:'t',expireIn:60});
  if(String(url).includes('/fields'))return response({value:schema});
  const body=JSON.parse(options.body);assert.deepEqual(body.fieldIdOrNames,['姓名','电话','写入时间']);if(lists)assert.equal(body.nextToken,'next');
  return response({records:pages[lists],hasMore:lists++===0,nextToken:'next'});
 }});
 assert.deepEqual(await client.findLatest(contact),{id:'newest',createdAt:2000});assert.equal(lists,2);
});

test('缺少匹配、非法时间、最新写入时间并列或分页游标循环时拒绝误更新',async()=>{
 for(const [rows,error,cycle]of [
  [[],/RegistrationNotFound/],
  [[{id:'x',fields:{姓名:contact.visitor_name,电话:contact.visitor_phone,写入时间:'bad'}}],/RegistrationTimeInvalid/],
  [[{id:'a',fields:{姓名:contact.visitor_name,电话:contact.visitor_phone,写入时间:123}},{id:'b',fields:{姓名:contact.visitor_name,电话:contact.visitor_phone,写入时间:123}}],/LatestRecordAmbiguous/],
  [[],/InvalidPagination/,true]
 ]){
  const client=new DingtalkClient({fields:defaultFields,baseId:'b',sheetId:'s'},{fetcher:async url=>String(url).endsWith('accessToken')?response({accessToken:'t',expireIn:60}):String(url).includes('/fields')?response({value:schema}):response({records:rows,hasMore:!!cycle,nextToken:'loop'})});
  await assert.rejects(()=>client.findLatest(contact),error);
 }
});

test('测评更新最新登记行的八项结果；断网重试固定目标行，不重写联系人和时间，也不新增行',async t=>{
 const {store,settings}=setup(t),r=remote(settings),queue=new Registrations(store,settings,{dingClient:r.client});
 const a=queue.create(contact,'owner');await queue.process(a.id);const b=queue.create(contact,'owner');await queue.process(b.id);
 const id=capture(store,a);r.dropUpdate();let worker=new Worker(store,settings,{dingClient:r.client});await worker.tick();
 let task=store.getSubmission(id);assert.equal(task.delivery.state,'retrying');assert.equal(task.delivery.record_id,'row-2');const firstCipher=task.delivery.fields_cipher;
 assert.equal(r.rows[0].fields.开放性,undefined);assert.equal(r.rows[1].fields.开放性,.78);
 const c=queue.create(contact,'owner');await queue.process(c.id);await pause();
 const restarted=new Store(store.directory);worker=new Worker(restarted,settings,{dingClient:r.client});await worker.tick();
 task=restarted.getSubmission(id);assert.equal(task.delivery.state,'synced');assert.equal(task.delivery.remote_id,'row-2');assert.equal(r.rows.length,3);assert.equal(r.rows[2].fields.开放性,undefined);
 const patches=r.calls.filter(c=>c.method==='PUT');assert.equal(patches.length,2);assert.deepEqual(patches[0].body,patches[1].body);
 const fields=patches[0].body.records[0].fields;assert.deepEqual(Object.keys(fields).sort(),['开放性','尽责性','外向性','宜人性','神经质','人格类型','描述','链接'].sort());assert.ok(fields.描述.markdown);assert.equal(r.rows[1].fields.写入时间,b.createdAt);
 assert.ok(firstCipher);assert.equal(task.contact_cipher,undefined);assert.equal(task.pending_result,undefined);assert.equal(task.delivery.fields_cipher,undefined);assert.equal(queue.get(a.id).contact_cipher,undefined);assert.ok(queue.get(b.id).contact_cipher);
});

test('已发旧链接升级后补建登记，结果找不到匹配行时保持任务重试，不退回新增结果行',async t=>{
 const {store,settings}=setup(t),r=remote(settings),queue=new Registrations(store,settings,{dingClient:r.client}),id=randomUUID();
 const inv=queue.create(contact,'owner',id);delete inv.registration;queue.put(inv);await queue.tick();assert.equal(queue.get(id).registration.state,'synced');assert.equal(r.rows.length,1);
 const taskId=capture(store,inv);r.rows.length=0;await new Worker(store,settings,{dingClient:r.client}).tick();
 assert.equal(store.getSubmission(taskId).delivery.last_error,'DingTalkRegistrationNotFound');assert.equal(r.calls.filter(c=>c.method==='PUT').length,0);assert.equal(r.calls.filter(c=>c.path.endsWith('/records')&&c.method==='POST').length,1);
});

test('更新时间在普通发送、旧快照重试与结果更新中均不写入，更新回执必须匹配目标 ID',async()=>{
 const report=extractReport(fixture,'demo0001','https://bigfivepersonality.me');assert.equal(dingFields({...report,created_at:123,updated_at:456}).更新时间,undefined);
 const bodies=[];const client=new DingtalkClient({fields:defaultFields},{fetcher:async(url,options)=>{
  if(String(url).endsWith('/accessToken'))return response({accessToken:'t',expireIn:60});bodies.push(JSON.parse(options.body));return response({value:[{id:'wrong-id'}]});
 }});
 const task={target_base:'b',target_sheet:'s',record_id:'target',client_token:randomUUID(),fields_json:JSON.stringify({姓名:'旧姓名',电话:'13800138000',写入时间:123,更新时间:456,开放性:.42})};
 await client.insert(task);assert.equal(bodies[0].records[0].fields.更新时间,undefined);
 await assert.rejects(()=>client.update(task),/InvalidUpdateResponse/);assert.deepEqual(bodies[1].records[0].fields,{开放性:.42});
});

test('登记字段元数据读取失败或电话类型不符时不创建行、不发链接；修复后继续处理',async t=>{
 const {store,settings}=setup(t);let invalid=true,inserts=0;
 const ding=new DingtalkClient(settings.dingtalk,{fetcher:async(url)=>{
  if(String(url).endsWith('/accessToken'))return response({accessToken:'t',expireIn:60});
  if(String(url).includes('/fields'))return response({value:schema.map(f=>f.name==='电话'&&invalid?{...f,type:'text'}:f)});
  inserts++;return response({value:[{id:'registered'}]});
 }});
 const queue=new Registrations(store,settings,{dingClient:ding}),inv=queue.create(contact,'owner');await queue.process(inv.id);
 assert.equal(inserts,0);assert.equal(queue.get(inv.id).registration.last_error,'DingTalkRegistrationFieldTypeChanged');assert.equal(queue.response(inv.id,'owner',settings.publicOrigin).url,undefined);
 invalid=false;await pause();await queue.process(inv.id);assert.equal(inserts,1);assert.ok(queue.response(inv.id,'owner',settings.publicOrigin).url);
});

 test('更新结果前补齐缺失的单选类型，保留已有选项 ID，并等待字段配置读回确认',async()=>{
 const original={id:'type',name:'人格类型',type:'singleSelect',property:{choices:[{id:'old',name:'探索家'}]}},calls=[];let updated,reads=0;
 const client=new DingtalkClient({fields:defaultFields,baseId:'base',sheetId:'sheet'},{fetcher:async(url,options)=>{
  if(String(url).endsWith('/accessToken'))return response({accessToken:'t',expireIn:60});
  if(new URL(url).pathname.endsWith('/fields'))return response({value:[updated&&++reads>1?updated:original]});
  const body=JSON.parse(options.body);calls.push(body);
  if(new URL(url).pathname.endsWith('/fields/type')){assert.equal(options.method,'PUT');assert.deepEqual(body.property.choices,[{id:'old',name:'探索家'},{name:'温柔智者'}]);updated={...original,property:{choices:[{id:'old',name:'探索家'},{id:'new',name:'温柔智者'}]}};return response({id:'type'});}
  return response({value:[{id:'target'}]});
 }});
 const task={target_base:'base',target_sheet:'sheet',record_id:'target',fields_json:JSON.stringify({人格类型:'温柔智者'})};
 assert.equal(await client.update(task),'target');assert.equal(calls.length,2);assert.equal(calls[1].records[0].fields.人格类型,'温柔智者');
 });
