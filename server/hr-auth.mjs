import{digest}from'./secure-files.mjs';
import{DingtalkClient}from'./dingtalk.mjs';
export class AuthError extends Error {constructor(code,status=401){super(code);this.status=status;}}
export class HrAuth {
 constructor(config,{fetcher=fetch}={}){this.config=config;this.fetcher=fetcher;this.app=config.dingtalk?new DingtalkClient(config.dingtalk,{fetcher}):null;}
 get configured(){return !!(this.app&&this.config.publicOrigin);}
 get tenantKey(){return this.app?digest(this.config.dingtalk.appKey):'';}
 async request(url,options={}){
  let response;try{response=await this.fetcher(url,{...options,signal:AbortSignal.timeout(10000)});}catch{throw new AuthError('DingTalkIdentityUnavailable',503);}
  let data;try{data=await response.json();}catch{throw new AuthError('DingTalkIdentityUnavailable',503);}
  if(!response.ok||(data.errcode!==undefined&&Number(data.errcode)!==0)||(data.code!==undefined&&String(data.code)!=='0'))throw new AuthError('DingTalkIdentityRejected',403);return data;
 }
 async member(unionId){
  if(!this.configured)throw new AuthError('LoginNotConfigured',503);
  const signal=AbortSignal.timeout(15000),accessToken=await this.app.accessToken(signal);
  const directory=await this.request('https://oapi.dingtalk.com/topapi/user/getbyunionid?access_token='+encodeURIComponent(accessToken),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({unionid:unionId})});
  if(directory.result?.contact_type!==undefined&&Number(directory.result.contact_type)!==0)throw new AuthError('NotCompanyMember',403);
  const userId=directory.result?.userid;if(typeof userId!=='string'||!userId)throw new AuthError('NotCompanyMember',403);
  const user=await this.request('https://oapi.dingtalk.com/topapi/v2/user/get?access_token='+encodeURIComponent(accessToken),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userid:userId,language:'zh_CN'})});
  if(user.result?.unionid!==unionId||user.result?.active!==true)throw new AuthError('NotCompanyMember',403);
  return {userId,unionId,name:user.result.name||'企业成员',tenantKey:this.tenantKey};
 }
 async exchange(code){
  if(!this.configured)throw new AuthError('LoginNotConfigured',503);
  const settings=this.config.dingtalk;
  const token=await this.request('https://api.dingtalk.com/v1.0/oauth2/userAccessToken',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientId:settings.appKey,clientSecret:settings.appSecret,code,grantType:'authorization_code'})});
  if(!token.accessToken)throw new AuthError('InvalidUserIdentity',403);
  const identity=await this.request('https://api.dingtalk.com/v1.0/contact/users/me',{headers:{'x-acs-dingtalk-access-token':token.accessToken}});
  if(typeof identity.unionId!=='string'||!identity.unionId)throw new AuthError('InvalidUserIdentity',403);
  return this.member(identity.unionId);
 }
}
