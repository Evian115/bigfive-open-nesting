import {randomBytes,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {atomicJson,readJson,seal,unseal,digest} from './secure-files.mjs';
import {HrAuth,AuthError,safeAvatarUrl} from './hr-auth.mjs';
import {Registrations} from './registrations.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const files=Object.fromEntries(['hr.html','hr.js','hr.css','invitation.html','invitation.js'].map(name=>[name,readFileSync(new URL('../public/'+name,import.meta.url))]));
export const readCookie=(req,name)=>(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1);
export class PortalError extends Error {constructor(code,status=400){super(code);this.status=status;}}
export function validateContact(input){
 const name=typeof input.name==='string'?input.name:'',raw=typeof input.phone==='string'?input.phone.trim():'';
 if(!name||name.length>80||/[^\p{Unified_Ideograph}]/u.test(name))throw new PortalError('InvalidName');
 const phone=raw.replace(/[\s-]/g,'').replace(/^\+86/,'');if(!/^1[3-9]\d{9}$/.test(phone))throw new PortalError('InvalidPhone');
 return {visitor_name:name,visitor_phone:phone};
}
export class Portal {
 constructor(store,config,{fetcher=fetch,auth,registrations}={}){this.store=store;this.config=config;this.auth=auth||new HrAuth(config,{fetcher});this.registrations=registrations||new Registrations(store,config,{fetcher});}
 path(kind,id){if(!uuid.test(id))throw new PortalError('InvalidIdentifier');return join(this.store.directory,kind,id+'.json');}
 get(kind,id){return readJson(this.path(kind,id));} put(kind,row){return atomicJson(this.path(kind,row.id),row);}
 cookie(res,name,value,secure,maxAge){const previous=res.getHeader('set-cookie')||[];res.setHeader('set-cookie',[...(Array.isArray(previous)?previous:[previous]),`${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure?'; Secure':''}`]);}
 json(res,status,value){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));return true;}
 page(res,file,status=200){res.writeHead(status,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https:; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"});res.end(files[file]);return true;}
 invalid(res){res.writeHead(410,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer'});res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>测评链接已失效</title><body><h2>测评链接已失效</h2><p>本次测评已完成或链接已过期。如需重新测评，请联系人事生成新的链接。</p></body></html>');return true;}
 sameOrigin(req,origin){if(req.headers.origin!==origin)throw new PortalError('CrossOriginRequest',403);}
 async input(req){let size=0,parts=[];for await(const part of req){size+=part.length;if(size>16384)throw new PortalError('BodyTooLarge',413);parts.push(part);}try{return JSON.parse(Buffer.concat(parts).toString());}catch{throw new PortalError('InvalidJson');}}
 async hr(req){
  const token=readCookie(req,'nest_hr'),id=token?.split('.')[0];if(!uuid.test(id||''))return null;
  const session=this.get('hr-sessions',id);if(!session||session.tokenHash!==digest(token)||session.expiresAt<=Date.now()||session.tenantKey!==this.auth.tenantKey)return null;
  return session;
 }
 createInvitation(contact,owner,now=Date.now()){
  const id=randomUUID(),expiresAt=now+72*3600000,value={id,expiresAt,...contact};
  const token=seal(this.store.key,value,'invite');
  this.put('invitations',{id,createdAt:now,expiresAt,owner,contact_cipher:seal(this.store.key,contact,'contact')});
  return {id,expiresAt,token};
 }
 sync(inv){
  if(!inv)throw new PortalError('InvitationInvalid',410);
  const task=inv.submissionId&&this.store.getSubmission(inv.submissionId);
  if(task&&['accepted','captured'].includes(task.state)){inv.resultId=task.upstream_id;inv.completedAt=inv.completedAt||task.updated_at;}
  return inv;
 }
 open(token,session){
  let data;try{if(typeof token!=='string'||token.length>4096)throw new Error();data=unseal(this.store.key,token,'invite');}catch{throw new PortalError('InvitationInvalid',410);}
  const inv=this.get('invitations',data.id);if(!inv||inv.expiresAt!==data.expiresAt)throw new PortalError('InvitationInvalid',410);
  if(inv.registration&&inv.registration.state!=='synced')throw new PortalError('RegistrationPending',409);
  this.sync(inv);if(inv.resultId||inv.closedAt)throw new PortalError('InvitationCompleted',410);
  if(inv.expiresAt<=Date.now())throw new PortalError('InvitationExpired',410);
  if(inv.claimedSession&&inv.claimedSession!==digest(session))throw new PortalError('InvitationInUse',409);
  const id=randomUUID(),secret=randomBytes(32).toString('base64url'),visit=id+'.'+secret;
  this.put('visits',{id,invitationId:inv.id,sessionHash:digest(session),tokenHash:digest(visit),createdAt:Date.now()});
  return {visit,invitationId:inv.id,expiresAt:inv.expiresAt};
 }
 visit(token,session,{completed=true}={}){
  const id=typeof token==='string'?token.split('.')[0]:'';if(!uuid.test(id))throw new PortalError('InvitationRequired',403);
  const view=this.get('visits',id);if(!view||view.tokenHash!==digest(token)||view.sessionHash!==digest(session||''))throw new PortalError('InvitationRequired',403);
  const inv=this.sync(this.get('invitations',view.invitationId));if(!inv)throw new PortalError('InvitationInvalid',410);
  if(inv.closedAt||view.closedAt)throw new PortalError('InvitationCompleted',410);
  if(inv.resultId){if(!completed||inv.resultVisitId!==view.id)throw new PortalError('InvitationCompleted',410);}
  else if(inv.expiresAt<=Date.now())throw new PortalError('InvitationExpired',410);
  return {inv,view};
 }
 activate(token,session){const {inv,view}=this.visit(token,session,{completed:false});if(inv.claimedSession&&inv.claimedSession!==digest(session))throw new PortalError('InvitationInUse',409);inv.claimedSession=digest(session);this.put('invitations',inv);return {inv,view};}
 reserve(token,session,submissionId){
  const {inv,view}=this.activate(token,session);
  if(inv.submissionId&&inv.submissionId!==submissionId){const prior=this.store.getSubmission(inv.submissionId);if(prior&&prior.state!=='rejected')throw new PortalError('InvitationAlreadySubmitted',409);}
  inv.submissionId=submissionId;inv.resultVisitId=view.id;this.put('invitations',inv);
  return {invitation_id:inv.id,contact_cipher:inv.contact_cipher};
 }
 submission(token,session,submissionId){
  // A response-lost replay can return the same original receipt without starting another assessment.
  const {inv,view}=this.visit(token,session);
  if(inv.resultId){if(inv.submissionId!==submissionId||inv.resultVisitId!==view.id)throw new PortalError('InvitationCompleted',410);return {invitation_id:inv.id};}
  return this.reserve(token,session,submissionId);
 }
 report(req,session,id){
  const token=req.headers['x-nesting-visit']||readCookie(req,'nest_report_visit');const {inv,view}=this.visit(token,session);
  if(inv.resultId!==id||inv.resultVisitId!==view.id)throw new PortalError('InvitationCompleted',410);
  if(!req.headers['x-nesting-visit']&&view.reportServed){inv.closedAt=Date.now();this.put('invitations',inv);throw new PortalError('InvitationCompleted',410);}
  view.reportServed=true;this.put('visits',view);return true;
 }
 async handle(req,res,{path,url,origin,secureCookie,session}){
  if(path==='/'&&req.method==='GET'&&!req.headers.rsc&&req.headers['sec-fetch-dest']!=='iframe')return this.page(res,'hr.html');
  if(path==='/i'&&req.method==='GET'){
   if(!this.store.session(session))this.cookie(res,'nest_session',this.store.newSession(),secureCookie,7776000);
   return this.page(res,'invitation.html');
  }
  const asset=path.match(/^\/_nest\/(hr\.js|hr\.css|invitation\.js)$/)?.[1];
  if(asset&&req.method==='GET'){res.writeHead(200,{'content-type':asset.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8','cache-control':'no-cache'});res.end(files[asset]);return true;}
  if(path==='/auth/dingtalk/start'&&req.method==='GET'){
   if(!this.auth.configured)throw new AuthError('LoginNotConfigured',503);
   const id=randomUUID(),state=id+'.'+randomBytes(32).toString('base64url');this.put('oauth-states',{id,hash:digest(state),expiresAt:Date.now()+600000});
   this.cookie(res,'nest_oauth',state,secureCookie,600);
   const next=new URL('https://login.dingtalk.com/oauth2/auth');for(const[k,v]of Object.entries({client_id:this.config.dingtalk.appKey,redirect_uri:this.config.publicOrigin+'/auth/dingtalk/callback',response_type:'code',scope:'openid',state,prompt:'consent'}))next.searchParams.set(k,v);
   res.writeHead(302,{location:next.href,'cache-control':'no-store','referrer-policy':'no-referrer'});res.end();return true;
  }
  if(path==='/auth/dingtalk/callback'&&req.method==='GET'){
   const state=url.searchParams.get('state'),bound=readCookie(req,'nest_oauth'),id=state?.split('.')[0];
   if(!state||state!==bound||!uuid.test(id||''))throw new AuthError('InvalidOAuthState');
   const row=this.get('oauth-states',id);if(!row||row.usedAt||row.expiresAt<=Date.now()||row.hash!==digest(state))throw new AuthError('InvalidOAuthState');
   row.usedAt=Date.now();this.put('oauth-states',row);this.cookie(res,'nest_oauth','',secureCookie,0);
   const code=url.searchParams.get('authCode')||url.searchParams.get('code');if(!code||code.length>2048)throw new AuthError('OAuthCancelled');
   const member=await this.auth.exchange(code);if(member.tenantKey!==this.auth.tenantKey)throw new AuthError('InvalidUserIdentity',403);
   const sid=randomUUID(),token=sid+'.'+randomBytes(32).toString('base64url');
   this.put('hr-sessions',{id:sid,tokenHash:digest(token),...member,createdAt:Date.now(),verifiedAt:Date.now(),expiresAt:Date.now()+12*3600000});
   this.cookie(res,'nest_hr',token,secureCookie,12*3600);res.writeHead(303,{location:this.config.publicOrigin+'/','cache-control':'no-store','referrer-policy':'no-referrer'});res.end();return true;
  }
  if(path==='/_nest/hr/session'&&req.method==='GET'){
   const user=await this.hr(req);return this.json(res,200,user?{authenticated:true,name:user.name,avatarUrl:safeAvatarUrl(user.avatarUrl),csrf:digest(readCookie(req,'nest_hr')+':csrf')}:{authenticated:false,configured:this.auth.configured});
  }
  if(path==='/_nest/hr/invitations'&&req.method==='POST'){
   this.sameOrigin(req,origin);const user=await this.hr(req);if(!user)throw new AuthError('LoginRequired');
   if(req.headers['x-nesting-csrf']!==digest(readCookie(req,'nest_hr')+':csrf'))throw new AuthError('InvalidCsrf',403);
   const input=await this.input(req),contact=validateContact(input),issued=this.registrations.create(contact,user.unionId,input.id);
   await this.registrations.process(issued.id);
   const result=this.registrations.response(issued.id,user.unionId,this.config.publicOrigin||origin);
   return this.json(res,result.state==='synced'?201:202,result);
  }
  const registrationId=path.match(/^\/_nest\/hr\/invitations\/([0-9a-f-]{36})$/)?.[1];
  if(registrationId&&req.method==='GET'){const user=await this.hr(req);if(!user)throw new AuthError('LoginRequired');return this.json(res,200,this.registrations.response(registrationId,user.unionId,this.config.publicOrigin||origin));}
  if(path==='/_nest/hr/logout'&&req.method==='POST'){
   this.sameOrigin(req,origin);const token=readCookie(req,'nest_hr'),id=token?.split('.')[0];if(uuid.test(id||'')){const user=this.get('hr-sessions',id);if(user?.tokenHash===digest(token)){user.expiresAt=0;this.put('hr-sessions',user);}}
   this.cookie(res,'nest_hr','',secureCookie,0);return this.json(res,200,{ok:true});
  }
  if(path.startsWith('/_nest/invitations/')){
   if(req.method!=='POST')throw new PortalError('MethodNotAllowed',405);this.sameOrigin(req,origin);if(!this.store.session(session))throw new PortalError('SessionRequired',401);
   const input=await this.input(req),token=req.headers['x-nesting-visit']||input.visit;
   if(path==='/_nest/invitations/open')return this.json(res,200,this.open(input.token,session));
   const {inv,view}=this.visit(token,session);
   if(path==='/_nest/invitations/activate'){this.activate(token,session);return this.json(res,200,{ok:true});}
   if(path==='/_nest/invitations/status')return this.json(res,200,{completed:!!inv.resultId,resultId:inv.resultId||null,expiresAt:inv.expiresAt});
   if(path==='/_nest/invitations/close'){
    if(inv.resultId){inv.closedAt=Date.now();view.closedAt=Date.now();this.put('invitations',inv);this.put('visits',view);}return this.json(res,200,{ok:true});
   }
   throw new PortalError('NotFound',404);
  }
  return false;
 }
}
