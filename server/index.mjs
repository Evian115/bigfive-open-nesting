import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { config } from './config.mjs';
import { Store } from './store.mjs';
import { Worker } from './worker.mjs';
import { createApp } from './app.mjs';
const settings=config();
process.umask(0o077);
mkdirSync(settings.stateDirectory,{recursive:true,mode:0o700});
const unlock=await lockfile.lock(settings.stateDirectory,{realpath:true,lockfilePath:join(settings.stateDirectory,'.service.lock'),stale:30000,update:10000,retries:{retries:35,factor:1,minTimeout:1000,maxTimeout:1000}});
const store=new Store(settings.stateDirectory);
const worker=new Worker(store,settings);
const server=createApp({config:settings,store,worker});
server.listen(settings.port,settings.host,()=>{
 console.log(`Nesting service: http://${settings.host}:${server.address().port}`);
 console.log(settings.dingtalk?'DingTalk configured':'DingTalk not configured; results will stay queued');
 worker.start();
});
let stopping=false;
async function shutdown() {
 if(stopping)return;stopping=true;
 const deadline=setTimeout(()=>process.exit(1),55000);deadline.unref();
 await new Promise(resolve=>server.close(resolve));await worker.stop();store.close();await unlock();clearTimeout(deadline);
}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
