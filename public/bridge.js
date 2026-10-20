(() => {
  if (window.__nestBridge) return;window.__nestBridge=true;
  const nativeFetch=window.fetch.bind(window), storageKey='nest_submission_identity_v1';
  const post=data=>{if(parent!==window)parent.postMessage({source:'nest-bridge',...data},location.origin);};
  const uuid=()=>{
    const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
    const s=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
  };
  let visit;try{visit=parent!==window?parent.__nestVisit:null;}catch{}
  // Keep each invitation's original draft separate, before the original app hydrates.
  try{
    const invitationId=parent!==window&&parent.__nestInvitationId;
    if(invitationId&&typeof Storage!=='undefined'){
      const keys=new Set(['bf_answers','bf_currentQuestion','bf_scores','bf_completedAt','bf_testStarted','bf_startedAt',storageKey]);
      for(const method of ['getItem','setItem','removeItem']){
        const native=Storage.prototype[method];Storage.prototype[method]=function(key,...args){return native.call(this,this===localStorage&&keys.has(key)?'nest:'+invitationId+':'+key:key,...args);};
      }
    }
  }catch{}
  let memoryIdentity;
  async function identity(body) {
    let input;try{input=JSON.parse(body);}catch{return uuid();}
    const stable=JSON.stringify({answers:input.answers,locale:input.locale,startedAt:input.startedAt});
    const choose=()=>{
      let previous=memoryIdentity;
      try{previous=JSON.parse(localStorage.getItem(storageKey)) || previous;}catch{}
      if(previous?.identity===stable)return previous.id;
      const value={identity:stable,id:uuid()};memoryIdentity=value;
      try{localStorage.setItem(storageKey,JSON.stringify(value));}catch{}
      return value.id;
    };
    return navigator.locks ? navigator.locks.request('nest-submission-identity',choose) : choose();
  }
  window.fetch=async(input,init)=>{
    const request=new Request(input,init);
    const url=new URL(request.url,location.href);
    if (url.origin!==location.origin)return nativeFetch(input,init);
    if(visit&&!url.pathname.startsWith('/_nest/')){
      const headers=new Headers(request.headers);headers.set('x-nesting-visit',visit);
      if(url.pathname!=='/api/results'||request.method!=='POST')return nativeFetch(new Request(request,{headers}));
    }
    if(url.pathname!=='/api/results'||request.method!=='POST')return nativeFetch(input,init);
    const id=await identity(await request.clone().text());post({type:'submit',id});
    const headers=new Headers(request.headers);headers.set('x-nesting-submission-id',id);if(visit)headers.set('x-nesting-visit',visit);
    try {
      const response=await nativeFetch(new Request(request,{headers}));
      if(response.ok){post({type:'accepted',id});}
      if(!response.ok){let code;try{code=(await response.clone().json()).error;}catch{}post({type:'error',id,code,status:response.status});}
      return response;
    } catch(error) {post({type:'error',id,code:'NetworkError'});throw error;}
  };
  const isTestPath=path=>/^\/(?:zh\/)?test\/?$/.test(path);
  const completedKeys=['bf_answers','bf_currentQuestion','bf_scores','bf_completedAt','bf_testStarted','bf_startedAt'];
  function prepareRetest() {
    // Match the original site's resetTest keys, only after a completed draft
    // and an explicit visit/click to start another test. Never discard a draft
    // that has not been submitted, or change answers, scoring or test timing.
    try {
      if(!localStorage.getItem('bf_completedAt'))return;
      for(const key of completedKeys)localStorage.removeItem(key);
      localStorage.removeItem(storageKey);memoryIdentity=undefined;
      post({type:'start'});
    }catch{}
  }
  if(isTestPath(location.pathname))prepareRetest();
  document.addEventListener('click',event=>{
    if(visit&&parent.__nestCompleted&&event.target?.closest?.('a[href],button')){
      const element=event.target.closest('a[href],button');
      if(isTestPath(new URL(element.href||location.href,location.href).pathname)||/再测|重新测试|开始测试/.test(element.textContent||'')){event.preventDefault();event.stopImmediatePropagation();post({type:'retake-blocked'});return;}
    }
    const anchor=event.target?.closest?.('a[href]');if(!anchor)return;
    let target;try{target=new URL(anchor.href,location.href);}catch{return;}
    if(target.origin===location.origin&&isTestPath(target.pathname))prepareRetest();
  },true);
  const ready=()=>post({type:'ready'});
  window.addEventListener('message',event=>{if(event.source===parent&&event.origin===location.origin&&event.data?.source==='nest-host')ready();});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready,{once:true});else ready();
  // A fresh original test clears bf_testStarted; observe that transition without changing answers or timing.
  let lastStarted;try{lastStarted=localStorage.getItem('bf_startedAt');}catch{}
  setInterval(()=>{
    let value;try{value=localStorage.getItem('bf_startedAt');}catch{return;}
    if(value && value!==lastStarted)post({type:'start'});lastStarted=value;
  },1000);
})();
