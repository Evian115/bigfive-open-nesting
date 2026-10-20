// Browser UI test: real clicks and elapsed time; never edits answers, scores or timestamps in storage.
const fs=require('node:fs');
const path=require('node:path');
const {randomInt}=require('node:crypto');
const {parseArgs}=require('node:util');
const {values:options}=parseArgs({options:{'invite-url':{type:'string'},url:{type:'string',default:'http://localhost:8082'},submit:{type:'boolean',default:false},headless:{type:'boolean',default:false},'delay-ms':{type:'string',default:'3000'},'playwright-module':{type:'string'},output:{type:'string'},'expect-sync':{type:'boolean',default:false},help:{type:'boolean',default:false}}});
if(options.help){console.log('Usage: npm run test:assessment -- --url https://your-host/ --submit [--headless] [--expect-sync]\nWithout --submit, stops after answering. Default: 3 seconds per question. --expect-sync waits for DingTalk confirmation.');process.exit(0);}
const target=new URL(options.url);if(!['http:','https:'].includes(target.protocol)||target.username||target.password||target.pathname!=='/'||target.search||target.hash)throw new Error('--url must be a service origin without credentials or path');
const invitation=options['invite-url']?new URL(options['invite-url']):null;
if(invitation&&(invitation.origin!==target.origin||invitation.pathname!=='/i'||!invitation.hash))throw new Error('--invite-url must be a full invitation URL under --url');
const base=target.origin,delay=Number(options['delay-ms']);if(!Number.isInteger(delay)||delay<3000)throw new Error('--delay-ms must be at least 3000; upstream submission limits remain in effect');
const output=path.resolve(options.output||path.join(__dirname,'../test-results/assessment-'+new Date().toISOString().replace(/[:.]/g,'-')));fs.mkdirSync(output,{recursive:true});
const {chromium}=require(options['playwright-module']||process.env.PLAYWRIGHT_MODULE||'playwright');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 const browser=await chromium.launch({headless:options.headless,channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'});
 let summary={checkedAt:new Date().toISOString(),base,submitRequested:options.submit,success:false},page;
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1000}});page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  // Capture the original response as evidence; this never supplies a replacement response.
  let submitted;const requests=[];
  page.on('response',response=>{
   if(response.url()===base+'/api/results'&&response.request().method()==='POST')requests.push((async()=>{
    const request=response.request(),submissionId=await request.headerValue('x-nesting-submission-id');
    let body;try{body=await response.json();}catch{body={error:'NonJsonResponse'};}
    submitted={status:response.status(),submissionId,body};
   })());
  });
  console.log('Target:',base,options.submit?'Will create ONE real assessment and use this service’s configured DingTalk delivery.':'Answer-only mode; no result submission.');
  const health=await context.request.get(base+'/_nest/health');if(!health.ok())throw new Error('ServiceHealthUnavailable');
  const service=await health.json();summary.dingtalkConfigured=service.dingtalkConfigured;
  // Validate the public HTTPS origin/session path before spending time answering. Missing UUID stops before creating any task.
  await page.goto(invitation?invitation.href:base+'/',{waitUntil:'domcontentloaded',timeout:60000});
  const probe=await context.request.post(base+'/api/results',{headers:{origin:base},data:{}});const probeBody=await probe.json();
  if(probe.status()!==400||probeBody.error!=='SubmissionIdRequired')throw new Error(`Origin/session check failed: HTTP ${probe.status()} ${probeBody.error}`);
  console.log('Origin/session check passed.');
  const frame=page.frameLocator('#assessment');await frame.locator('h1').waitFor({timeout:60000});
  await frame.getByRole('link',{name:'立即开始测试',exact:true}).first().click();
  await frame.getByRole('button',{name:'开始测试',exact:true}).click();
  const labels=['非常不同意','不同意','中立','同意','非常同意'];
  const started=Date.now();
  for(let n=1;n<=50;n++){
   const progress=frame.getByText(`第 ${n} 题，共 50 题`,{exact:true});await progress.waitFor({timeout:30000});
   await pause(delay);await frame.getByRole('button',{name:labels[randomInt(labels.length)],exact:true}).click();
   if(n%10===0)console.log(`Answered ${n}/50 (${Math.round((Date.now()-started)/1000)}s)`);
  }
  summary.elapsedSeconds=Math.round((Date.now()-started)/1000);
  const submit=frame.getByRole('button',{name:'查看结果',exact:true});await submit.waitFor({timeout:30000});
  if(!options.submit){summary.success=true;summary.answerOnly=true;console.log('All answers selected. No assessment was submitted. Add --submit to run the full workflow.');return;}
  const response=page.waitForResponse(r=>r.url()===base+'/api/results'&&r.request().method()==='POST',{timeout:45000});
  await submit.click();await response;await Promise.all(requests);
  summary.submission=submitted;
  if(!submitted||![200,201].includes(submitted.status)||typeof submitted.body?.id!=='string')throw new Error(`Original submission failed: HTTP ${submitted?.status} ${submitted?.body?.error||''} ${submitted?.body?.message||''}`);
  if(!submitted.submissionId)throw new Error('Submission identity was not captured');
  const reportId=submitted.body.id;
  await page.waitForFunction(id=>document.getElementById('assessment').contentWindow.location.pathname==='/zh/r/'+id,reportId,{timeout:60000});
  await frame.locator('h1').waitFor({timeout:60000});
  const reportPage=page.frames().find(f=>new URL(f.url()).pathname==='/zh/r/'+reportId);if(!reportPage)throw new Error('OriginalReportNavigationMissing');
  // Parse only the source report. No local classification or score calculation.
  const visit=await page.evaluate(()=>window.__nestVisit||null);
  const reportResponse=await context.request.get(base+'/zh/r/'+reportId,{headers:visit?{'x-nesting-visit':visit}:{}});if(!reportResponse.ok())throw new Error('OriginalReportUnavailable');
  const {extractReport}=await import('../server/report.mjs');const report=extractReport(await reportResponse.text(),reportId,'https://bigfivepersonality.me');
  await frame.getByRole('heading',{name:report.personality_type,exact:true}).waitFor({timeout:30000});
  summary.report={id:reportId,type:report.personality_type,description:report.description,resultUrl:report.result_url,scores:Object.fromEntries(['openness','conscientiousness','extraversion','agreeableness','neuroticism'].map(key=>[key,report[key]]))};
  let state;const deadline=Date.now()+90000;
  do{
   const status=await context.request.get(base+'/_nest/submissions/'+submitted.submissionId);if(!status.ok())throw new Error(`StatusHttp${status.status()}`);state=await status.json();summary.state=state;
   if(state.sync==='synced')break;
   if(state.saved&&!options['expect-sync']&&!service.dingtalkConfigured)break;
   if(!options['expect-sync']&&state.saved)break;
   await pause(2000);
  }while(Date.now()<deadline);
  if(!state.saved)throw new Error(`Report capture incomplete: ${state.lastError||state.submission}`);
  if(options['expect-sync']&&state.sync!=='synced')throw new Error(`DingTalk not confirmed: ${state.sync}, ${state.lastError||''}`);
  summary.success=true;summary.pageErrors=errors;
  console.log('Report:',report.personality_type,report.result_url);
  console.log('Delivery:',state.sync==='synced'?'DingTalk CONFIRMED':state.sync==='retrying'?'FAILED; backend will retry':'SAVED; waiting for DingTalk confirmation');
 }catch(error){summary.error=error.message;process.exitCode=1;console.error('FAIL:',error.message);}
 finally{
  if(page){try{await page.screenshot({path:path.join(output,'page.png'),fullPage:true});}catch{}}
  fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify(summary,null,2));console.log('Evidence:',output);
  await browser.close();
 }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
