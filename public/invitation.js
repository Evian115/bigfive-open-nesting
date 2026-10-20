(()=>{
 const host=document.getElementById('guest'),state=document.getElementById('invite-state');let frame,visit='',completed=false,timer,closing=false;
 const errors={InvitationExpired:'测评链接已超过有效期，请联系人事重新获取。',InvitationCompleted:'本次测评已完成，链接已失效。',InvitationInUse:'该测评正在另一浏览器中进行，请返回原浏览器继续。',InvitationAlreadySubmitted:'本次提交正在处理中，请勿重复提交。'};
 function fail(code){clearInterval(timer);frame?.remove();state.hidden=false;state.textContent=errors[code]||'测评链接无效或暂时无法验证，请稍后重试或联系人事。';}
 async function api(action,body={}){const response=await fetch('/_nest/invitations/'+action,{method:'POST',headers:{'content-type':'application/json',...(visit?{'x-nesting-visit':visit}:{})},body:JSON.stringify(body),cache:'no-store'});const data=await response.json();if(!response.ok)throw new Error(data.error);return data;}
 async function status(){try{const value=await api('status');if(value.completed){completed=true;window.__nestCompleted=true;clearInterval(timer);}}catch(e){if(['InvitationExpired','InvitationCompleted','InvitationInUse'].includes(e.message))fail(e.message);}}
 window.addEventListener('message',event=>{
  if(event.origin!==location.origin||!frame||event.source!==frame.contentWindow||event.data?.source!=='nest-bridge')return;
  const msg=event.data;
  if(msg.type==='start')void api('activate').catch(e=>fail(e.message));
  if(msg.type==='accepted'){completed=true;window.__nestCompleted=true;clearInterval(timer);}
  if(msg.type==='retake-blocked')fail('InvitationCompleted');
  if(msg.type==='error'&&['InvitationCompleted','InvitationExpired','InvitationRequired','InvitationInUse','InvitationAlreadySubmitted'].includes(msg.code))fail(msg.code);
 });
 window.addEventListener('pagehide',()=>{if(completed&&visit&&!closing){closing=true;navigator.sendBeacon('/_nest/invitations/close',new Blob([JSON.stringify({visit})],{type:'application/json'}));}});
 window.addEventListener('pageshow',event=>{if(event.persisted&&completed)fail('InvitationCompleted');});
 (async()=>{
  let token=location.hash.slice(1);const key='nest_invitation_token';
  try{if(token){sessionStorage.setItem(key,token);history.replaceState(null,'','/i');}else token=sessionStorage.getItem(key);}catch{}
  if(!token)return fail('InvitationInvalid');
  try{const result=await api('open',{token});visit=result.visit;window.__nestVisit=visit;window.__nestInvitationId=result.invitationId;state.hidden=true;frame=document.createElement('iframe');frame.id='assessment';frame.title='原站大五人格测评';frame.sandbox='allow-scripts allow-same-origin allow-forms allow-downloads allow-popups';frame.referrerPolicy='no-referrer';frame.src='/zh';host.appendChild(frame);timer=setInterval(status,5000);}catch(e){fail(e.message);}
 })();
})();
