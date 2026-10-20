const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require(process.argv[3] || process.env.PLAYWRIGHT_MODULE || 'playwright');
(async()=>{
 const base=process.argv[2];if(!base?.includes(':18082'))throw new Error('Use isolated service on 18082');
 const tasks=path.resolve(__dirname,'../test-results/live-state/tasks');
 const row=fs.readdirSync(tasks).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(tasks,n),'utf8'))).find(r=>r.state==='captured'&&r.pending_result);
 assert.ok(row,'Run the live assessment test first');
 const browser=await chromium.launch({headless:true,channel:'msedge'});
 try {
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 await context.addCookies([{name:'nest_session',value:row.session_id,url:base,sameSite:'Lax',httpOnly:true}]);
 await context.addInitScript(id=>localStorage.setItem('nest_active_submission',JSON.stringify(id)),row.id);
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/',{waitUntil:'domcontentloaded'});
 await page.getByText('结果已保存、等待同步',{exact:true}).waitFor({timeout:30000});
 assert.ok(page.frames().some(f=>f.url()===base+'/zh'));
 const reportPage=await context.newPage();await reportPage.goto(base+'/zh/r/'+row.upstream_id,{waitUntil:'domcontentloaded'});
 const frame=reportPage;
 await frame.getByRole('heading',{name:'开放性',exact:true}).waitFor({timeout:60000});
 const names={openness:'开放性',conscientiousness:'尽责性',extraversion:'外向性',agreeableness:'宜人性',neuroticism:'神经质'};
 const scores={};
 for(const [key,name] of Object.entries(names)) {
  const text=await frame.getByRole('heading',{name,exact:true}).locator('..').innerText();
  const score=Number(text.match(/(\d+)\s*%/)[1]);assert.equal(score,row.pending_result[key]);scores[key]=score;
 }
 const current=await (await page.request.get(base+'/_nest/submissions/'+row.id)).json();
 assert.equal(current.saved,true);assert.equal(current.sync,'pending');assert.equal(current.resultUrl,row.pending_result.result_url);
 assert.equal(page.url(),base+'/');assert.ok(page.frames().some(f=>f.url()===base+'/zh'));
 await page.reload({waitUntil:'domcontentloaded'});await page.frameLocator('#assessment').locator('h1').waitFor({timeout:60000});assert.ok(page.frames().some(f=>f.url()===base+'/zh'));
 assert.equal(await page.locator('#status-title').innerText(),'结果已保存、等待同步');
 await page.screenshot({path:path.resolve(__dirname,'../test-results/live-result.png'),fullPage:true});
 const summary={checkedAt:new Date().toISOString(),reportUrl:current.resultUrl,submissionId:row.id,scores,serverRestartRecovery:true,browserRefreshRecovery:true,sync:'pending',pageErrors:errors};
 fs.writeFileSync(path.resolve(__dirname,'../test-results/live-summary.json'),JSON.stringify(summary,null,2));
 console.log('PASS',JSON.stringify(summary));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
