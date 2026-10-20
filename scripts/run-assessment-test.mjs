// Reuse the installed browser runtime when running this workspace inside WSL.
import {existsSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {release} from 'node:os';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),script=join(root,'scripts/test-assessment.cjs');
let executable=process.execPath,args=[script,...process.argv.slice(2)];
if(process.platform==='linux'&&release().toLowerCase().includes('microsoft')){
 let userRoot=process.env.CODEX_HOME?.startsWith('/mnt/')?dirname(process.env.CODEX_HOME):null;
 if(!userRoot){
  try{
   const profile=execFileSync('cmd.exe',['/d','/c','echo','%USERPROFILE%'],{cwd:'/mnt/c',encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
   userRoot=execFileSync('wslpath',['-u',profile],{encoding:'utf8'}).trim();
  }catch{}
 }
 const runtime=userRoot&&join(userRoot,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node');
 if(runtime){
 const windowsNode=join(runtime,'bin/node.exe'),playwright=join(runtime,'node_modules/playwright');
 if(existsSync(windowsNode)&&existsSync(playwright)){
  const windowsPath=value=>execFileSync('wslpath',['-w',value],{encoding:'utf8'}).trim();
  executable=windowsNode;args=[windowsPath(script),'--playwright-module',process.env.PLAYWRIGHT_MODULE||windowsPath(playwright),...process.argv.slice(2)];
 }
 }
}
const child=spawn(executable,args,{cwd:root,stdio:'inherit',env:process.env});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',(code,signal)=>{process.exitCode=code??1;if(signal)console.error('Browser test stopped:',signal);});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
