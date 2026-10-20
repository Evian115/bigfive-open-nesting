import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {Portal,PortalError,readCookie} from './portal.mjs';
import {AuthError} from './hr-auth.mjs';
import {RegistrationError} from './registrations.mjs';
import { validResultId } from './report.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const assets = Object.fromEntries(['index.html','shell.js','shell.css','bridge.js'].map(name => [name,readFileSync(new URL(`../public/${name}`,import.meta.url))]));
const hop = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','content-length','host','accept-encoding','x-forwarded-for','x-forwarded-host','x-forwarded-proto','forwarded']);
function json(res,status,body) { res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}); res.end(JSON.stringify(body)); }
async function body(req,max=32768) {
  let size=0;const chunks=[];
  for await (const chunk of req) { size+=chunk.length; if (size>max) throw Object.assign(new Error('BodyTooLarge'),{status:413}); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function cookie(req) { return (req.headers.cookie || '').split(';').map(v=>v.trim()).find(v=>v.startsWith('nest_session='))?.slice(13); }
function requestHeaders(req,config,origin) {
  const headers=new Headers();
  for (const [name,value] of Object.entries(req.headers)) {
    if (hop.has(name) || name.startsWith('x-nesting-') || name.startsWith('sec-fetch-') || name === 'cookie' || name === 'origin' || name === 'referer') continue;
    if (typeof value === 'string') headers.set(name,value);
  }
  const cookies=(req.headers.cookie || '').split(';').filter(v=>!v.trim().startsWith('nest_')).join(';');
  if (cookies) headers.set('cookie',cookies);
  if (req.headers.origin === origin) headers.set('origin',config.upstreamOrigin);
  if (req.headers.referer) {
    try { const u=new URL(req.headers.referer); if (u.origin===origin) headers.set('referer',config.upstreamOrigin+u.pathname+u.search); } catch {}
  }
  return headers;
}
function copyHeaders(upstream,res,config,origin) {
  for (const [key,value] of upstream.headers) {
    if (hop.has(key) || ['set-cookie','content-encoding','content-security-policy','content-security-policy-report-only','x-frame-options','strict-transport-security','etag'].includes(key)) continue;
    if (key==='location') {
      const target=new URL(value,config.upstreamOrigin);
      // Upstream's own redirects stay in the service. External destinations are never proxied.
      res.setHeader(key,target.origin===config.upstreamOrigin ? origin+target.pathname+target.search+target.hash : target.href);
    } else res.setHeader(key,value);
  }
  const cookies=upstream.headers.getSetCookie?.().filter(v=>!v.startsWith('nest_')) ?? [];
  if (cookies.length) res.setHeader('set-cookie',[...(res.getHeader('set-cookie')||[]),...cookies.map(v=>v.replace(/;\s*Domain=[^;]*/ig,''))]);
  res.setHeader('x-content-type-options','nosniff');
  res.setHeader('referrer-policy','same-origin');
}
export function parseUpstreamRejection(bytes,status) {
  const result={status};
  if(bytes.length>4096)return result;
  try {
    const value=JSON.parse(bytes);
    const code=typeof value?.code==='string'?value.code:typeof value?.error==='string'?value.error:null;
    if(/^[A-Za-z0-9_.-]{1,100}$/.test(code || ''))result.code=code;
    const message=value?.message ?? value?.error?.message ?? (result.code?null:value?.error);
    if(typeof message==='string')result.reason=message.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,240);
  }catch{}
  return result;
}
export function createApp({ config,store,worker,fetcher=fetch,portalAuth }) {
  const inFlight=new Map(),portal=config.portalEnabled?new Portal(store,config,{fetcher,auth:portalAuth,registrations:worker.registrations}):null;
  const server=createServer(async(req,res) => {
    try {
      const fallback=`http://${req.headers.host}`;
      const allowedOrigins=[config.publicOrigin,...(config.additionalOrigins || [])].filter(Boolean);
      const origin=config.publicOrigin
        ? allowedOrigins.find(value=>value===req.headers.origin) || allowedOrigins.find(value=>new URL(value).host===req.headers.host) || config.publicOrigin
        : new URL(fallback).origin;
      // Only explicitly configured origins are accepted behind TLS tunnels. Never trust arbitrary forwarded headers.
      if (config.publicOrigin && req.headers.origin && !allowedOrigins.includes(req.headers.origin) && !['GET','HEAD'].includes(req.method)) return json(res,403,{error:'CrossOriginRequest'});
      const secureCookie=origin.startsWith('https:') || config.cookieSecure && (!config.publicOrigin || origin===config.publicOrigin);
      if (!['GET','HEAD','POST'].includes(req.method)) return json(res,405,{error:'MethodNotAllowed'});
      if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) return json(res,400,{error:'InvalidPath'});
      const url=new URL(req.url,origin), path=url.pathname;
      if(portal&&await portal.handle(req,res,{path,url,origin,secureCookie,session:cookie(req)}))return;
      if (path==='/_nest/health') return json(res,200,{ok:true,dingtalkConfigured:!!config.dingtalk,storage:'durable-files'});
      if (path==='/' && req.method==='GET' && !req.headers.rsc && req.headers['sec-fetch-dest']!=='iframe') {
        let session=cookie(req);
        if (!store.session(session)) { session=store.newSession();res.setHeader('set-cookie',`nest_session=${session}; Path=/; Max-Age=7776000; HttpOnly; SameSite=Lax${secureCookie?'; Secure':''}`); }
        res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; object-src 'none'"}); return res.end(assets['index.html']);
      }
      const asset=path.match(/^\/_nest\/(shell\.js|shell\.css|bridge\.js)$/)?.[1];
      if (asset && req.method==='GET') { res.writeHead(200,{'content-type':asset.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8','cache-control':'no-cache'}); return res.end(assets[asset]); }
      if (path.startsWith('/_nest/')) {
        const match=path.match(/^\/_nest\/submissions\/([0-9a-f-]{36})$/);
        if (!match || !uuid.test(match[1]) || req.method!=='GET') return json(res,404,{error:'NotFound'});
        const session=cookie(req); if (!store.session(session)) return json(res,401,{error:'SessionRequired'});
        const value=store.status(match[1],session);
        return value ? json(res,200,{...value,dingtalkConfigured:!!config.dingtalk,resultUrl:value.resultId ? `${config.upstreamOrigin}/zh/r/${value.resultId}`:null}) : json(res,404,{error:'NotFound'});
      }
      const isSubmit=path==='/api/results' && req.method==='POST';
      // Every modifying request needs an actual same-origin browser context and a service session.
      if (req.method==='POST') {
        if (req.headers.origin !== origin || !store.session(cookie(req))) return json(res,403,{error:'SameOriginSessionRequired'});
        if (!isSubmit) return json(res,405,{error:'OnlyOriginalAssessmentSubmissionSupported'});
      }
      // Direct entry into the original route receives a session, then reloads once.
      if (req.method==='GET' && /^(?:\/zh)?\/(test|test-120|results|r\/)/.test(path) && !store.session(cookie(req))) {
        const session=store.newSession();res.writeHead(307,{'location':req.url,'set-cookie':`nest_session=${session}; Path=/; Max-Age=7776000; HttpOnly; SameSite=Lax${secureCookie?'; Secure':''}`,'cache-control':'no-store'});return res.end();
      }
      const target=new URL(config.upstreamOrigin+req.url);
      if (target.origin !== config.upstreamOrigin) return json(res,400,{error:'InvalidTarget'});
      const headers=requestHeaders(req,config,origin);
      let payload,submissionId,claim,context={};
      if (isSubmit) {
        submissionId=req.headers['x-nesting-submission-id'];
        if (!uuid.test(submissionId || '')) return json(res,400,{error:'SubmissionIdRequired'});
        if (!req.headers['content-type']?.startsWith('application/json')) return json(res,415,{error:'JsonRequired'});
        payload=await body(req);
        let input;try { input=JSON.parse(payload); } catch { return json(res,400,{error:'InvalidJson'}); }
        // Identity excludes finishedAt, which the original site refreshes on a retry.
        // Answers are forwarded without modification, never scored or persisted here.
        const hash=createHash('sha256').update(JSON.stringify({answers:input.answers,locale:input.locale,startedAt:input.startedAt})).digest('hex');
        if(portal)context=portal.submission(req.headers['x-nesting-visit'],cookie(req),submissionId);
        claim=store.begin(submissionId,cookie(req),hash,Date.now(),context);
        if (claim.conflict) return json(res,409,{error:'SubmissionIdentityConflict'});
        if (claim.uncertain) return json(res,409,{error:'UpstreamOutcomeUnknown'});
        if (claim.replay) { res.writeHead(claim.replay.http_status,{'content-type':'application/json','cache-control':'no-store'});return res.end(claim.replay.response_json); }
        if (claim.busy) {
          if (inFlight.has(submissionId)) await inFlight.get(submissionId);
          const row=store.getSubmission(submissionId);
          if (['accepted','captured'].includes(row.state)) { res.writeHead(row.http_status,{'content-type':'application/json','cache-control':'no-store'});return res.end(row.response_json); }
          return json(res,409,{error:'SubmissionInProgress'});
        }
      }
      const reportMatch=path.match(/^\/zh\/r\/([A-Za-z0-9_-]+)\/?$/);
      if(portal&&reportMatch){try{portal.report(req,cookie(req),reportMatch[1]);}catch(e){if(e instanceof PortalError)return portal.invalid(res);throw e;}}
      let release;
      if (isSubmit) inFlight.set(submissionId,new Promise(resolve=>{ release=resolve; }));
      try {
        const upstream=await fetcher(target,{method:req.method,headers,...(payload?{body:payload}:{}),redirect:'manual',signal:AbortSignal.timeout(30000)});
        if (isSubmit) {
          const bytes=await upstream.arrayBuffer(), responseBody=Buffer.from(bytes);
          if (upstream.ok) {
            let response;try { response=JSON.parse(responseBody); } catch {}
            if (!validResultId(response?.id)) { store.reject(submissionId,claim.token,true,'InvalidUpstreamResult'); return json(res,502,{error:'InvalidUpstreamResult'}); }
            store.accept(submissionId,claim.token,response.id,responseBody.toString('utf8'),upstream.status);
            if(portal)portal.cookie(res,'nest_report_visit',req.headers['x-nesting-visit'],secureCookie,3600);
            void worker.tick();
          } else store.reject(submissionId,claim.token,false,`UpstreamHttp${upstream.status}`,parseUpstreamRejection(responseBody,upstream.status));
          copyHeaders(upstream,res,config,origin);res.setHeader('cache-control','no-store');res.writeHead(upstream.status);return res.end(responseBody);
        }
        copyHeaders(upstream,res,config,origin);
        if(portal&&reportMatch)res.setHeader('cache-control','no-store');
        const type=upstream.headers.get('content-type') || '';
        if (/text\/html|text\/x-component|javascript|text\/css/.test(type) && upstream.status===200 && req.method!=='HEAD') {
          let text=await upstream.text();
          text=text.replaceAll(config.upstreamOrigin,origin);
          if (type.includes('text/html')) {
            // A head script catches fetch before the original application hydrates.
            text=text.replace(/<head([^>]*)>/i,'<head$1><script src="/_nest/bridge.js"></script>');
            res.setHeader('cache-control','no-store');res.setHeader('content-security-policy',"frame-ancestors 'self'");
          }
          res.writeHead(upstream.status);return res.end(text);
        }
        res.writeHead(upstream.status);
        if (upstream.body && req.method!=='HEAD') res.end(Buffer.from(await upstream.arrayBuffer()));else res.end();
      } catch(e) {
        if (isSubmit) store.reject(submissionId,claim.token,true,'UpstreamOutcomeUnknown');
        if (!res.headersSent) json(res,502,{error:'UpstreamUnavailable'});else res.destroy();
      } finally { release?.();if(submissionId)inFlight.delete(submissionId); }
    } catch(e) {
      if(e instanceof PortalError||e instanceof AuthError||e instanceof RegistrationError){
        if(req.url?.startsWith('/auth/')){res.writeHead(303,{location:'/?login='+encodeURIComponent(e.message),'cache-control':'no-store','referrer-policy':'no-referrer'});res.end();return;}
        return json(res,e.status,{error:e.message});
      }
      console.error('RequestFailed',e.status || 'InternalError');
      if (!res.headersSent) json(res,e.status || 500,{error:e.status===413?'BodyTooLarge':'ServicePersistenceError'});else res.destroy();
    }
  });
  server.requestTimeout=40000;server.headersTimeout=15000;
  return server;
}
