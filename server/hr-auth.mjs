import{digest}from'./secure-files.mjs';
export function safeAvatarUrl(value){try{if(typeof value!=='string'||value.length>2048)return null;const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:null;}catch{return null;}}
export class AuthError extends Error {constructor(code,status=401){super(code);this.status=status;}}
export class HrAuth {
 constructor(config,{fetcher=fetch}={}){this.config=config;this.fetcher=fetcher;}
 get configured(){return !!(this.config.dingtalk?.appKey&&this.config.dingtalk?.appSecret&&this.config.publicOrigin);}
 get tenantKey(){return this.config.dingtalk?digest(this.config.dingtalk.appKey):'';}
 async request(url,options={}){
  let response;try{response=await this.fetcher(url,{...options,signal:AbortSignal.timeout(10000)});}catch{throw new AuthError('DingTalkIdentityUnavailable',503);}
  let data;try{data=await response.json();}catch{throw new AuthError('DingTalkIdentityUnavailable',503);}
  if(!response.ok||(data.errcode!==undefined&&Number(data.errcode)!==0)||(data.code!==undefined&&String(data.code)!=='0'))throw new AuthError('DingTalkIdentityRejected',403);return data;
 }
 async exchange(code){
  if(!this.configured)throw new AuthError('LoginNotConfigured',503);
  const settings=this.config.dingtalk;
  const token=await this.request('https://api.dingtalk.com/v1.0/oauth2/userAccessToken',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientId:settings.appKey,clientSecret:settings.appSecret,code,grantType:'authorization_code'})});
  if(!token.accessToken)throw new AuthError('InvalidUserIdentity',403);
  const identity=await this.request('https://api.dingtalk.com/v1.0/contact/users/me',{headers:{'x-acs-dingtalk-access-token':token.accessToken}});
  if(typeof identity.unionId!=='string'||!identity.unionId)throw new AuthError('InvalidUserIdentity',403);
  return {unionId:identity.unionId,name:typeof identity.nick==='string'&&identity.nick.trim()?identity.nick:'钉钉用户',avatarUrl:safeAvatarUrl(identity.avatarUrl),tenantKey:this.tenantKey};
 }
}
