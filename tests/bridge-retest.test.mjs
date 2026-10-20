import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const source=readFileSync(new URL('../public/bridge.js',import.meta.url),'utf8');
const keys=['bf_answers','bf_currentQuestion','bf_scores','bf_completedAt','bf_testStarted','bf_startedAt'];
function harness(path,{completed=true}={}) {
 const data=new Map(keys.map(key=>[key,key==='bf_completedAt'&&!completed?null:'old-value']).filter(([,value])=>value!==null));
 data.set('bf_owned_result_ids','["old-report"]');data.set('nest_submission_identity_v1','old-identity');
 const events=new Map(),messages=[],window={};const location={origin:'http://localhost:8082',pathname:path,href:'http://localhost:8082'+path};
 window.fetch=async()=>new Response('{}');window.addEventListener=(name,fn)=>{};
 const context={window,location,parent:{postMessage:data=>messages.push(data)},document:{readyState:'loading',addEventListener:(name,fn)=>events.set(name,fn)},localStorage:{getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)},navigator:{},crypto:webcrypto,Request,Headers,URL,setInterval:()=>1};
 vm.runInNewContext(source,context);
 return {data,messages,click(path){events.get('click')({target:{closest:()=>({href:new URL(path,location.origin).href})}});}};
}
test('从已完成报告点击开始测试时只清原站六项旧草稿和提交标识',()=>{
 const page=harness('/zh/r/demo0001');assert.equal(page.data.has('bf_completedAt'),true);page.click('/zh/test');
 for(const key of keys)assert.equal(page.data.has(key),false,key);
 assert.equal(page.data.has('nest_submission_identity_v1'),false);assert.equal(page.data.get('bf_owned_result_ids'),'["old-report"]');assert.equal(page.messages.at(-1).type,'start');
});
test('首页重开不改原站缓存，进入作答页时才重置已完成草稿',()=>{
 const home=harness('/zh');assert.equal(home.data.has('bf_completedAt'),true);assert.equal(home.messages.length,0);
 const assessment=harness('/zh/test');for(const key of keys)assert.equal(assessment.data.has(key),false,key);
});
test('未完成作答的刷新或继续入口保留答案、题号和真实开始时间',()=>{
 const draft=harness('/zh/test',{completed:false});draft.click('/zh/test');
 for(const key of keys.filter(key=>key!=='bf_completedAt'))assert.equal(draft.data.get(key),'old-value',key);
 assert.equal(draft.messages.length,0);
});
test('其他页面链接不会触发测评重置',()=>{
 const page=harness('/zh/r/demo0001');page.click('/zh');page.click('/zh/traits/openness');page.click('https://elsewhere.example/test');
 assert.equal(page.data.has('bf_completedAt'),true);assert.equal(page.messages.length,0);
});
