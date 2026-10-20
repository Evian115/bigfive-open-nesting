// Opt-in live assessment test. Use an isolated service/STATE_DIRECTORY, never production.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require(process.argv[3] || process.env.PLAYWRIGHT_MODULE || 'playwright');
(async()=>{
 const base=process.argv[2];if(!base || !base.includes(':18082'))throw new Error('Use the isolated test service on 18082');
 const browser=await chromium.launch({headless:true,channel:'msedge'});
 try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 let submitRequest,submitResponse;
 page.on('response',async r=>{if(r.url()===base+'/api/results' && r.request().method()==='POST'){submitRequest=r.request();submitResponse={status:r.status(),body:await r.text()};}});
 await page.goto(base+'/',{waitUntil:'domcontentloaded'});
 const frame=page.frameLocator('#assessment');await frame.locator('h1').waitFor({timeout:60000});
 await frame.getByRole('link',{name:'立即开始测试',exact:true}).first().click();
 await frame.getByRole('button',{name:'开始测试',exact:true}).click();
 const labels=['非常不同意','不同意','中立','同意','非常同意'];
 const sequence=[2,3,4,3,1,5,4,2,5,3,4,2,1];
 const started=Date.now();
 for(let n=1;n<=50;n++) {
  await frame.getByText(`第 ${n} 题，共 50 题`,{exact:true}).waitFor();
  await page.waitForTimeout(2000);
  await frame.getByRole('button',{name:labels[sequence[(n-1)%sequence.length]-1],exact:true}).click();
  if(n%10===0)console.log('Answered',n,'elapsedSec',Math.round((Date.now()-started)/1000));
 }
 console.log('Final buttons',await frame.getByRole('button').allTextContents());
 await frame.getByRole('button',{name:'查看结果',exact:true}).click();
 await page.waitForTimeout(12000);
 console.log('Submit',submitResponse,'Frame',page.frames()[1].url());
 console.log('Status',await page.locator('#status').innerText());
 assert.ok(submitResponse);assert.ok([200,201].includes(submitResponse.status));
 const {id}=JSON.parse(submitResponse.body);assert.ok(id);
 const sid=await submitRequest.headerValue('x-nesting-submission-id');
 let state;
 for(let n=0;n<15;n++){state=await (await page.request.get(base+'/_nest/submissions/'+sid)).json();if(state.saved)break;await page.waitForTimeout(2000);}
 assert.equal(state.saved,true);assert.equal(state.sync,'pending');assert.equal(state.dingtalkConfigured,false);
 assert.equal(page.url(),base+'/');assert.match(page.frames()[1].url(),new RegExp('/zh/r/'+id));
 assert.equal(await page.locator('#status-title').innerText(),'结果已保存、等待同步');
 assert.equal(await page.locator('#report-link').getAttribute('href'),'https://bigfivepersonality.me/zh/r/'+id);
 const replay=await page.request.post(base+'/api/results',{headers:{origin:base,'x-nesting-submission-id':sid},data:{...submitRequest.postDataJSON(),finishedAt:Date.now()}});
 assert.equal(replay.status(),submitResponse.status);assert.equal((await replay.json()).id,id);
 await page.reload({waitUntil:'domcontentloaded'});await page.waitForTimeout(4000);
 assert.equal(await page.locator('#status-title').innerText(),'结果已保存、等待同步');
 const screenshot=path.resolve(__dirname,'../test-results/live-result.png');
 await page.screenshot({path:screenshot,fullPage:true});
 const summary={checkedAt:new Date().toISOString(),outerUrl:page.url(),reportUrl:state.resultUrl,submissionId:sid,state,pageErrors:errors};
 fs.writeFileSync(path.resolve(__dirname,'../test-results/live-summary.json'),JSON.stringify(summary,null,2));
 console.log('PASS',JSON.stringify(summary));
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
