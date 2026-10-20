const assert=require('node:assert/strict');
const {chromium}=require(process.argv[3] || process.env.PLAYWRIGHT_MODULE || 'playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'msedge'});
 try {
 const base=process.argv[2] || 'http://localhost:8082',page=await browser.newPage();
 const id='456d9639-9790-4b6b-bb2e-0f2197d26470';
 let calls=0,state={submission:'rejected',saved:false,sync:null,rejectionCode:'too_fast'};
 const fixture='<html><head><script src="/_nest/bridge.js"></script></head><body><h1>原站页面夹具</h1></body></html>';
 await page.route('**/zh',route=>route.fulfill({contentType:'text/html',body:fixture}));
 await page.route('**/zh/r/**',route=>route.fulfill({contentType:'text/html',body:fixture}));
 await page.route('**/_nest/submissions/'+id,route=>{calls++;return route.fulfill({contentType:'application/json',body:JSON.stringify(state)});});
 await page.goto(base+'/');
 await page.evaluate(id=>localStorage.setItem('nest_active_submission',JSON.stringify(id)),id);
 await page.reload();await page.waitForFunction(()=>JSON.parse(localStorage.getItem('nest_active_submission'))===null);
 assert.equal(await page.locator('#status').isVisible(),false);assert.equal(await page.locator('#notice').isVisible(),false);
 const rejectedCalls=calls;assert.equal(rejectedCalls,1);await page.waitForTimeout(3500);assert.equal(calls,rejectedCalls);
 await page.reload();await page.frameLocator('#assessment').locator('h1').waitFor();
 assert.equal(await page.locator('#status').isVisible(),false);assert.equal(calls,rejectedCalls);
 await page.frames().find(f=>f.url().endsWith('/zh')).evaluate(id=>parent.postMessage({source:'nest-bridge',type:'submit',id},location.origin),id);
 await page.getByText('原站未接受此次提交',{exact:true}).waitFor();assert.match(await page.locator('#status-detail').innerText(),/作答过快/);
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('nest_active_submission'))),null);
 await page.reload();await page.frameLocator('#assessment').locator('h1').waitFor();assert.equal(await page.locator('#status').isVisible(),false);
 state={submission:'captured',saved:true,sync:'pending',dingtalkConfigured:true,resultUrl:'https://bigfivepersonality.me/zh/r/demo0001'};
 await page.evaluate(id=>localStorage.setItem('nest_active_submission',JSON.stringify(id)),id);await page.reload();
 await page.getByText('结果已保存、等待同步',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('nest_active_submission'))),id);
 const pendingCalls=calls;await page.waitForTimeout(3500);assert.ok(calls>pendingCalls);
 console.log('PASS: old rejection cleared on reopen; current rejection visible; pending delivery still restored and polled');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
