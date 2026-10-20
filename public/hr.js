(()=>{
 const node=id=>document.getElementById(id);let csrf='',timer,pendingId='',pendingKnown=false;
 const pointer='nest_hr_registration';
 try{pendingId=sessionStorage.getItem(pointer)||'';}catch{}
 const remember=id=>{pendingId=id;try{if(id)sessionStorage.setItem(pointer,id);else sessionStorage.removeItem(pointer);}catch{}};
 const show=id=>{for(const key of ['loading','login','registration','issued'])node(key).hidden=key!==id;node('message').hidden=true;};
 const message=text=>{node('message').textContent=text;node('message').hidden=false;};
 const busy=value=>{for(const id of ['create','name','phone'])node(id).disabled=value;node('create').textContent=value?'正在写入钉钉，确认后生成链接…':'生成专属测评链接 →';};
 async function request(url,options={}){const response=await fetch(url,{cache:'no-store',...options,headers:{'content-type':'application/json','x-nesting-csrf':csrf,...options.headers}});const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error||'RequestFailed'),{status:response.status});return value;}
 function accept(invitation){
  pendingKnown=true;
  if(invitation.state!=='synced'){busy(true);message(invitation.state==='retrying'?'登记信息已保存，钉钉写入暂时失败，后台正在自动重试。确认写入后会显示链接。':'正在将姓名、电话和写入时间保存到钉钉，请稍候…');schedule();return;}
  remember('');pendingKnown=false;clearTimeout(timer);busy(false);show('issued');node('invite-url').value=invitation.url;
  node('expiry').textContent='有效期至 '+new Date(invitation.expiresAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+'（北京时间）。完成后当前结果页可继续查看，关闭或刷新后入口失效。';
 }
 function schedule(){clearTimeout(timer);if(pendingId)timer=setTimeout(()=>void poll(),3000);}
 async function poll(){if(!pendingId)return;try{accept(await request('/_nest/hr/invitations/'+pendingId));}catch(e){if(e.status===401||e.status===403){clearTimeout(timer);show('login');node('account').hidden=true;message('请重新登录后继续查看登记结果。');}else if(e.status===404||e.status===410){pendingKnown=false;busy(false);if(e.status===410){remember('');message('原测评链接已失效，请重新登记。');}else message('登记尚未确认，请核对姓名和电话后再次点击生成；系统会继续使用同一次登记，避免重复写入。');}else{busy(true);message('暂时无法确认钉钉写入状态，正在重试查询，请勿重复登记。');schedule();}}}
 async function load(){try{const user=await request('/_nest/hr/session');if(user.authenticated){csrf=user.csrf;node('account-name').textContent=user.name;node('account').hidden=false;show('registration');if(pendingId){busy(true);await poll();}}else{show('login');node('account').hidden=true;if(!user.configured){node('login-link').setAttribute('aria-disabled','true');message('企业登录暂未就绪，请联系管理员完成配置。');}}}catch{show('login');message('暂时无法核验企业身份，请稍后刷新重试。');}}
 node('registration').addEventListener('submit',async event=>{
  event.preventDefault();if(pendingKnown&&pendingId)return void poll();
  const name=node('name').value.trim(),phone=node('phone').value.replace(/[\s-]/g,'').replace(/^\+86/,'');
  if(!name)return message('请填写来访者姓名。');if(!/^1[3-9]\d{9}$/.test(phone))return message('请填写正确的中国大陆 11 位手机号。');
  if(!pendingId)remember(crypto.randomUUID());busy(true);
  try{accept(await request('/_nest/hr/invitations',{method:'POST',body:JSON.stringify({id:pendingId,name,phone})}));}
  catch(e){if(e.status===401||e.status===403){busy(false);await load();message('登录已失效或企业身份未通过核验，请重新登录。');}else if(e.status===400||e.status===409){remember('');busy(false);message(e.message==='InvalidPhone'?'手机号格式不正确。':'登记未完成，请重新填写后提交。');}else{message('登记请求尚未确认，正在查询处理结果，请勿重复登记。');schedule();}}
 });
 node('copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(node('invite-url').value);node('copy').textContent='已复制完整链接 ✓';}catch{node('invite-url').select();message('请复制选中的完整链接。');}});
 node('another').addEventListener('click',()=>{node('registration').reset();node('invite-url').value='';node('copy').textContent='复制完整链接 ↗';show('registration');node('name').focus();});
 node('logout').addEventListener('click',async()=>{try{await request('/_nest/hr/logout',{method:'POST',body:'{}'});location.replace('/');}catch{message('退出失败，请稍后重试。');}});
 const loginError=new URLSearchParams(location.search).get('login');
 void load().then(()=>{if(loginError)message(loginError==='NotCompanyMember'?'该账号未通过本企业成员核验，请使用本企业钉钉账号。':loginError==='LoginNotConfigured'?'企业登录暂未就绪，请联系管理员完成配置。':'登录未完成，请重新授权。');});
})();
