import { extractReport } from '../server/report.mjs';
const origin='https://bigfivepersonality.me';
const [test,report]=await Promise.all([fetch(`${origin}/zh/test`),fetch(`${origin}/zh/r/demo0001`)]);
if(!test.ok||!report.ok)throw new Error(`UpstreamUnavailable: ${test.status}/${report.status}`);
const html=await test.text();
if(!html.includes('/_next/static/'))throw new Error('UpstreamStructureChanged');
const result=extractReport(await report.text(),'demo0001',origin);
console.log(JSON.stringify({checkedAt:new Date().toISOString(),testStatus:test.status,reportParser:'ok',demoScores:result},null,2));
// Read-only: this command never submits an assessment or writes to DingTalk.
