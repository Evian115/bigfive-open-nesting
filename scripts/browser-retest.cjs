const assert=require('node:assert/strict');
const {chromium}=require(process.argv[3] || process.env.PLAYWRIGHT_MODULE || 'playwright');
(async()=>{
 const base=process.argv[2]||'http://localhost:8082',id='456d9639-9790-4b6b-bb2e-0f2197d26470';
 const browser=await chromium.launch({headless:true,channel:'msedge'});
 try {
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 await context.addInitScript(({base,id})=>{
  if(location.origin!==base||localStorage.getItem('nest_retest_fixture'))return;
  localStorage.setItem('nest_retest_fixture','1');localStorage.setItem('nest_active_submission',JSON.stringify(id));
  localStorage.setItem('bf_answers',JSON.stringify(Object.fromEntries(Array.from({length:50},(_,i)=>[i+1,3]))));
  localStorage.setItem('bf_currentQuestion','49');localStorage.setItem('bf_testStarted','true');localStorage.setItem('bf_startedAt','1');
  localStorage.setItem('bf_completedAt',JSON.stringify('2026-10-20T00:00:00.000Z'));
  localStorage.setItem('bf_scores',JSON.stringify(Object.fromEntries(['O','C','E','A','N'].map(k=>[k,{score:50,rawScore:30,level:'medium'}]))));
  localStorage.setItem('bf_owned_result_ids','["demo0001"]');localStorage.setItem('nest_submission_identity_v1','old-submission');
 },{base,id});
 const page=await context.newPage(),errors=[];let posts=0;page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/_nest/submissions/'+id,route=>route.fulfill({contentType:'application/json',body:JSON.stringify({submission:'captured',saved:true,sync:'synced',dingtalkConfigured:true,resultUrl:'https://bigfivepersonality.me/zh/r/demo0001'})}));
 await page.route('**/api/results',route=>{if(route.request().method()==='POST'){posts++;return route.abort();}return route.continue();});
 await page.goto(base+'/',{waitUntil:'domcontentloaded'});
 const frame=page.frameLocator('#assessment');
 await frame.getByRole('heading',{name:'通过大五人格测试探索你的性格',exact:true}).waitFor({timeout:60000});
 await page.waitForFunction(()=>JSON.parse(localStorage.getItem('nest_active_submission'))===null);
 assert.equal(await page.locator('#status').isVisible(),false);assert.ok(page.frames().some(f=>f.url()===base+'/zh'));
 await frame.getByRole('link',{name:'立即开始测试',exact:true}).first().click();
 await frame.getByRole('button',{name:'开始测试',exact:true}).click();
 await frame.getByText('第 1 题，共 50 题',{exact:true}).waitFor();
 const current=page.frames().find(f=>f.url()===base+'/zh/test');
 const cache=await current.evaluate(()=>Object.fromEntries(['bf_completedAt','bf_scores','bf_answers','bf_startedAt','bf_owned_result_ids','nest_submission_identity_v1'].map(k=>[k,localStorage.getItem(k)])));
 assert.equal(cache.bf_completedAt,null);assert.equal(cache.bf_scores,null);assert.equal(cache.bf_answers,null);assert.equal(cache.nest_submission_identity_v1,null);assert.equal(cache.bf_owned_result_ids,'["demo0001"]');assert.ok(Number(cache.bf_startedAt)>1);
 await frame.getByRole('button',{name:'同意',exact:true}).click();await frame.getByText('第 2 题，共 50 题',{exact:true}).waitFor();
 await page.waitForTimeout(3500);assert.equal(current.url(),base+'/zh/test');
 await frame.locator('a[href="/zh"]').first().click();
 await frame.getByRole('heading',{name:'通过大五人格测试探索你的性格',exact:true}).waitFor();
 await frame.getByRole('link',{name:'立即开始测试',exact:true}).first().click();
 await frame.getByText('第 2 题，共 50 题',{exact:true}).waitFor();
 assert.equal(await current.evaluate(()=>localStorage.getItem('bf_startedAt')),cache.bf_startedAt);
 assert.deepEqual(await current.evaluate(()=>JSON.parse(localStorage.getItem('bf_answers'))),{'1':4});
 await page.locator('#assessment').evaluate(el=>{el.src='/zh/r/demo0001';});
 await frame.getByRole('heading',{name:'架构师',exact:true}).waitFor({timeout:60000});
 await frame.getByRole('button',{name:'再测一次',exact:true}).click();
 await frame.getByRole('button',{name:'开始测试',exact:true}).click();
 await frame.getByText('第 1 题，共 50 题',{exact:true}).waitFor();
 assert.equal(posts,0);assert.deepEqual(errors,[]);
 console.log('PASS: reopening shows home; start clears completed draft; unfinished draft resumes; original retake button starts question 1; no submissions made');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
