import {randomUUID} from 'node:crypto';
import {existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {atomicJson,readJson,seal,unseal} from './secure-files.mjs';
import {DingtalkClient} from './dingtalk.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export class RegistrationError extends Error {constructor(code,status=409){super(code);this.status=status;}}
export class Registrations {
  constructor(store,config,{fetcher=fetch,dingClient}={}) {
    this.store=store;this.config=config;this.ding=dingClient??(config.dingtalk?new DingtalkClient(config.dingtalk,{fetcher}):null);this.running=new Map();
  }
  path(id){if(!uuid.test(id||''))throw new RegistrationError('InvalidRegistrationId',400);return join(this.store.directory,'invitations',id+'.json');}
  get(id){return readJson(this.path(id));}
  put(row){return atomicJson(this.path(row.id),row);}
  all(){const dir=join(this.store.directory,'invitations');return existsSync(dir)?readdirSync(dir).filter(n=>n.endsWith('.json')).map(n=>readJson(join(dir,n))):[];}
  create(contact,owner,id=randomUUID()) {
    const existing=this.get(id);
    if(existing){if(existing.owner!==owner||!existing.contact_cipher||JSON.stringify(unseal(this.store.key,existing.contact_cipher,'contact'))!==JSON.stringify(contact))throw new RegistrationError('RegistrationConflict');return existing;}
    // Distinct registrations retain distinct timestamps even within the same millisecond.
    const now=this.all().reduce((latest,row)=>Math.max(latest,row.createdAt+1),Date.now());
    return this.put({id,createdAt:now,expiresAt:now+72*3600000,owner,contact_cipher:seal(this.store.key,contact,'contact'),registration:{state:'pending',client_token:id,attempts:0,next_attempt_at:0}});
  }
  ensure(id) {
    const inv=this.get(id);if(!inv)throw new RegistrationError('InvitationInvalid',410);
    // Invitations issued before the two-stage rollout acquire the same durable registration job.
    if(!inv.registration&&inv.contact_cipher)this.put({...inv,registration:{state:'pending',client_token:inv.id,attempts:0,next_attempt_at:0}});
    return this.get(id);
  }
  response(id,owner,origin) {
    const inv=this.get(id);if(!inv||inv.owner!==owner)throw new RegistrationError('RegistrationNotFound',404);
    if(inv.expiresAt<=Date.now()||!inv.contact_cipher||inv.closedAt||inv.completedAt)throw new RegistrationError('InvitationExpired',410);
    if(inv.registration?.state!=='synced')return {id,state:inv.registration?.state||'pending',attempts:inv.registration?.attempts||0,nextAttemptAt:inv.registration?.next_attempt_at||0};
    const token=seal(this.store.key,{id:inv.id,expiresAt:inv.expiresAt,...unseal(this.store.key,inv.contact_cipher,'contact')},'invite');
    return {id,state:'synced',url:origin+'/i#'+token,expiresAt:inv.expiresAt};
  }
  async process(id) {
    if(this.running.has(id))return this.running.get(id);
    const run=this.perform(id).finally(()=>this.running.delete(id));this.running.set(id,run);return run;
  }
  async perform(id) {
    let inv=this.ensure(id),task=inv.registration;
    if(!task||task.state==='synced'||task.next_attempt_at>Date.now())return inv;
    try {
      if(!this.ding)throw new Error('DingTalkNotConfigured');
      const settings=this.config.dingtalk;
      if(task.target_base&&(task.target_base!==settings.baseId||task.target_sheet!==settings.sheetId))throw new Error('DingTalkTargetChanged');
      if(!task.fields_cipher) {
        const contact=unseal(this.store.key,inv.contact_cipher,'contact');
        const fields=await this.ding.prepareRegistration(contact);
        const priorIds=this.ding.registrationBaseline?await this.ding.registrationBaseline(contact):null;
        inv=this.get(id);task={...inv.registration,...(priorIds?{prior_ids_cipher:seal(this.store.key,priorIds,'registration-recovery')}:{}),target_base:settings.baseId,target_sheet:settings.sheetId,fields_cipher:seal(this.store.key,JSON.stringify(fields),'registration')};
        this.put({...inv,registration:task});
      }
      const excluded=task.prior_ids_cipher?[...unseal(this.store.key,task.prior_ids_cipher,'registration-recovery'),...this.all().filter(other=>other.id!==id&&other.registration?.remote_id&&other.registration.target_base===task.target_base&&other.registration.target_sheet===task.target_sheet).map(other=>other.registration.remote_id)]:[];
      const remoteId=await this.ding.insert({...task,excluded_record_ids:excluded,fields_json:unseal(this.store.key,task.fields_cipher,'registration')});
      if(typeof remoteId!=='string'||!remoteId)throw new Error('InvalidInsertResponse');
      inv=this.get(id);const {fields_cipher,prior_ids_cipher,...receipt}=inv.registration;
      this.put({...inv,registration:{...receipt,state:'synced',remote_id:remoteId,synced_at:Date.now(),last_error:null}});
    }catch(e) {
      inv=this.get(id);task=inv.registration;
      const code=/^[A-Za-z0-9_.-]{1,100}$/.test(e?.message||'')?e.message:'RegistrationFailed';
      const delay=Math.min(this.config.retryMaxMs,this.config.retryBaseMs*2**Math.min(task.attempts,10));
      this.put({...inv,registration:{...task,state:'retrying',attempts:task.attempts+1,last_error:code,next_attempt_at:Date.now()+delay}});
    }
    return this.get(id);
  }
  async tick() {
    if(!this.config.portalEnabled)return;
    const next=this.all().find(inv=>inv.contact_cipher&&(!inv.registration?inv.expiresAt>Date.now():inv.registration.state!=='synced'&&inv.registration.next_attempt_at<=Date.now()));
    if(next)await this.process(next.id);
  }
}
