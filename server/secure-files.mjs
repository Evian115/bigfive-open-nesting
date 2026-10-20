import {randomBytes,randomUUID,createCipheriv,createDecipheriv,createHmac} from 'node:crypto';
import {mkdirSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync,readFileSync,existsSync} from 'node:fs';
import {dirname} from 'node:path';
export const digest=value=>createHmac('sha256','nest-record-lookup-v1').update(value).digest('hex');
export function seal(key,value,purpose) {
 const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',createHmac('sha256',key).update('encrypt:'+purpose).digest(),nonce);cipher.setAAD(Buffer.from(purpose));
 const encrypted=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),encrypted]).toString('base64url');
}
export function unseal(key,value,purpose) {
 if(typeof value!=='string'||value.length>131072||!/^[\w-]+$/.test(value))throw new Error('InvalidEncryptedValue');
 const bytes=Buffer.from(value,'base64url');if(bytes.length<29)throw new Error('InvalidEncryptedValue');
 const cipher=createDecipheriv('aes-256-gcm',createHmac('sha256',key).update('encrypt:'+purpose).digest(),bytes.subarray(0,12));cipher.setAAD(Buffer.from(purpose));cipher.setAuthTag(bytes.subarray(12,28));
 return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8'));
}
export function atomicJson(path,value) {
 const directory=dirname(path);mkdirSync(directory,{recursive:true,mode:0o700});const temp=path+'.'+randomUUID()+'.tmp',fd=openSync(temp,'wx',0o600);
 try{writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,path);const dir=openSync(directory,'r');try{fsyncSync(dir);}finally{closeSync(dir);}
 return value;
}
export const readJson=path=>existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null;
