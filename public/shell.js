(() => {
  const frame=document.getElementById('assessment'),loadError=document.getElementById('load-error');
  let active=null,timer=null,checking=false,loaded=false;
  const read=()=>{try{return JSON.parse(localStorage.getItem('nest_active_submission'));}catch{return null;}};
  const save=value=>{try{localStorage.setItem('nest_active_submission',JSON.stringify(value));}catch{}};
  async function poll() {
    if (!active || checking) return;checking=true;const queried=active;
    try {
      const response=await fetch(`/_nest/submissions/${queried}`,{cache:'no-store',signal:AbortSignal.timeout(10000)});
      if(active!==queried || !response.ok)return;
      const state=await response.json();
      if(active!==queried)return;
      if(state.submission==='rejected'||state.sync==='synced') {
        // Keep terminal receipts on the server, without restoring a finished test on reopen.
        active=null;save(null);clearInterval(timer);timer=null;
      }
    } catch { /* Background status checks resume on the next interval. */ }
    finally {checking=false;}
  }
  function track(id) { active=id;save(id);clearInterval(timer);timer=setInterval(poll,3000);void poll(); }
  window.addEventListener('message',event=>{
    if (event.origin!==location.origin || event.source!==frame.contentWindow || event.data?.source!=='nest-bridge') return;
    const message=event.data;
    if(message.type==='ready'){loaded=true;loadError.hidden=true;}
    if(message.type==='start'){active=null;save(null);clearInterval(timer);timer=null;}
    if(message.type==='submit' && /^[0-9a-f-]{36}$/.test(message.id)) track(message.id);
    if(message.type==='error'&&active&&(!message.id||message.id===active))void poll();
  });
  frame.addEventListener('load',()=>{frame.contentWindow.postMessage({source:'nest-host'},location.origin);});
  setTimeout(()=>{if(!loaded)loadError.hidden=false;},45000);
  const previous=read();if(typeof previous==='string'&&/^[0-9a-f-]{36}$/.test(previous))track(previous);
})();
