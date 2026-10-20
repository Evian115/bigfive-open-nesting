import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const script=readFileSync(new URL('../public/shell.js',import.meta.url),'utf8');
const id='456d9639-9790-4b6b-bb2e-0f2197d26470';
function harness(previous,state) {
 const data=new Map(previous?[['nest_active_submission',JSON.stringify(previous)]]:[]),timers=new Map(),events=new Map();
 const nodes=Object.fromEntries(['assessment','load-error'].map(name=>[name,{hidden:name==='load-error',textContent:'',dataset:{},addEventListener(){}}]));
 nodes.assessment.src='/zh';nodes.assessment.contentWindow={postMessage(){}};
 let nextTimer=1,calls=0;
 const context={document:{getElementById:name=>nodes[name]},window:{addEventListener:(name,listener)=>events.set(name,listener)},location:{origin:'http://localhost:8082'},localStorage:{getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)},
  fetch:async()=>{calls++;const value=typeof state==='function'?await state():state;return {ok:true,json:async()=>value};},
  setTimeout:()=>nextTimer++,setInterval:fn=>{const key=nextTimer++;timers.set(key,fn);return key;},clearInterval:key=>timers.delete(key),AbortSignal,URL};
 vm.runInNewContext(script,context);
 return {nodes,data,timers,get calls(){return calls;},message(value){events.get('message')({origin:context.location.origin,source:nodes.assessment.contentWindow,data:{source:'nest-bridge',...value}});},flush:()=>new Promise(resolve=>setImmediate(resolve))};
}
test('外层页面没有顶部状态栏或报告快捷入口',()=>{
 const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
 assert.doesNotMatch(html,/id="(?:notice|status|status-title|status-detail|report-link)"/);
 assert.match(html,/<iframe id="assessment" src="\/zh"/);
});
test('历史拒绝或同步完成后清除恢复编号并停止轮询，保持原站首页',async()=>{
 for(const state of [{submission:'rejected',sync:null},{submission:'captured',sync:'synced'}]){
  const page=harness(id,state);await page.flush();
  assert.equal(JSON.parse(page.data.get('nest_active_submission')),null);assert.equal(page.timers.size,0);assert.equal(page.calls,1);assert.equal(page.nodes.assessment.src,'/zh');
 }
});
test('当前提交无论被拒绝或同步成功都只清理恢复信息，不插入顶部提示',async()=>{
 for(const state of [{submission:'rejected',sync:null,rejectionCode:'too_fast'},{submission:'captured',sync:'synced',resultUrl:'https://bigfivepersonality.me/zh/r/demo0001'}]){
  const page=harness(null,state);page.message({type:'submit',id});await page.flush();
  assert.equal(JSON.parse(page.data.get('nest_active_submission')),null);assert.equal(page.timers.size,0);assert.equal(page.nodes.assessment.src,'/zh');
 }
});
test('等待、失败重试和提交不确定状态继续后台查询，不跳离首页',async()=>{
 for(const state of [{submission:'captured',sync:'pending',saved:true},{submission:'captured',sync:'retrying',saved:true},{submission:'uncertain',sync:null,saved:false}]){
  const page=harness(id,state);await page.flush();
  assert.equal(JSON.parse(page.data.get('nest_active_submission')),id);assert.equal(page.timers.size,1);assert.equal(page.nodes.assessment.src,'/zh');
  for(const tick of page.timers.values())tick();await page.flush();assert.equal(page.calls,2);
 }
});
test('开始新测评后迟到的旧成功、拒绝与错误不影响新测评',async()=>{
 for(const state of [{submission:'captured',sync:'synced'},{submission:'rejected',sync:null}]){
  let release;const page=harness(id,()=>new Promise(resolve=>{release=resolve;}));page.message({type:'start'});
  const newer='856d9639-9790-4b6b-bb2e-0f2197d26470';page.message({type:'submit',id:newer});
  release(state);await page.flush();page.message({type:'error',id,code:'NetworkError'});
  assert.equal(JSON.parse(page.data.get('nest_active_submission')),newer);assert.equal(page.nodes.assessment.src,'/zh');assert.equal(page.timers.size,1);
 }
});
test('查询网络错误不清除待同步指针，后续轮询仍可完成',async()=>{
 let fails=true;const page=harness(id,()=>{if(fails)throw new Error('Offline');return {submission:'captured',sync:'synced'};});
 await page.flush();assert.equal(JSON.parse(page.data.get('nest_active_submission')),id);assert.equal(page.timers.size,1);
 fails=false;for(const tick of page.timers.values())tick();await page.flush();assert.equal(JSON.parse(page.data.get('nest_active_submission')),null);assert.equal(page.timers.size,0);
});
