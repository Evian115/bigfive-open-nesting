const assert=require('node:assert/strict');
const path=require('node:path');
const {chromium}=require(process.argv[3] || process.env.PLAYWRIGHT_MODULE || 'playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'msedge'});
 try{
 const page=await browser.newPage({viewport:{width:390,height:844}});
 const id='456d9639-9790-4b6b-bb2e-0f2197d26470';
 let state={submission:'accepted',saved:false,attempts:0,dingtalkConfigured:false};
 await page.route('**/zh',route=>route.fulfill({contentType:'text/html',body:'<html><body><h1>原站测试夹具</h1><script>parent.postMessage({source:"nest-bridge",type:"submit",id:"'+id+'"},location.origin)</script></body></html>'}));
 await page.route('**/_nest/submissions/'+id,route=>route.fulfill({contentType:'application/json',body:JSON.stringify(state)}));
 await page.goto('http://localhost:8082/');
 await page.frameLocator('#assessment').locator('h1').waitFor();
 await page.frames().find(f=>f.url().endsWith('/zh')).evaluate(id=>parent.postMessage({source:'nest-bridge',type:'submit',id},location.origin),id);
 await page.getByText('正在保存原站结果',{exact:true}).waitFor();
 state={...state,saved:true,sync:'pending',resultUrl:'https://bigfivepersonality.me/zh/r/demo0001'};
 await page.getByText('结果已保存、等待同步',{exact:true}).waitFor();
 state={...state,dingtalkConfigured:true,sync:'retrying',attempts:2,lastError:'NetworkOrTimeout'};
 await page.getByText('回传失败，正在自动重试',{exact:true}).waitFor();
 assert.equal(await page.locator('#status').getAttribute('data-tone'),'error');
 state={...state,sync:'synced',lastError:null};
 await page.getByText('已回传钉钉',{exact:true}).waitFor();
 assert.equal(await page.locator('#status').getAttribute('data-tone'),'success');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.reload();await page.getByText('已回传钉钉',{exact:true}).waitFor();
 await page.screenshot({path:path.resolve(__dirname,'../test-results/mobile-status.png'),fullPage:true});
 console.log('PASS: capture/pending/failure/confirmed success/refresh/mobile width');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
