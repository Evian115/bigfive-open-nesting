import { extractReport } from './report.mjs';
import { dingFields, DingtalkClient } from './dingtalk.mjs';
import {Registrations} from './registrations.mjs';
export class Worker {
  constructor(store, config, { fetcher=fetch, dingClient } = {}) {
    this.store=store; this.config=config; this.fetcher=fetcher;
    this.ding=dingClient ?? (config.dingtalk ? new DingtalkClient(config.dingtalk,{fetcher}) : null);
    this.registrations=new Registrations(store,config,{fetcher,dingClient:this.ding});
  }
  delay(attempt) { return Math.min(this.config.retryMaxMs,this.config.retryBaseMs * 2 ** Math.min(attempt,10)); }
  start() { this.timer=setInterval(() => this.tick(),this.config.workerIntervalMs); this.timer.unref(); void this.tick(); }
  async tick() {
    if (this.running) return this.running;
    this.running=this.process().catch(() => console.error('WorkerStatePersistenceFailed')).finally(() => { this.running=null; });
    return this.running;
  }
  async readReport(id) {
    const response=await this.fetcher(`${this.config.upstreamOrigin}/zh/r/${id}`,{redirect:'manual',headers:{accept:'text/html'},signal:AbortSignal.timeout(20000)});
    if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) throw new Error(`ReportHttp${response.status}`);
    const html=await response.text();
    if (html.length > 8*1024*1024) throw new Error('ReportTooLarge');
    return extractReport(html,id,this.config.upstreamOrigin);
  }
  async process() {
    await this.registrations.tick();
    const capture=this.store.claim('submissions');
    if (capture) {
      try {
        this.store.capture(capture,await this.readReport(capture.upstream_id));
      } catch(e) { this.store.failed('submissions',capture,safeCode(e,'ReportFetchFailed'),this.delay(capture.attempts)); }
    }
    if (!this.ding) return;
    let delivery=this.store.claim('outbox');
    if (delivery) {
      try {
        if (delivery.target_base && (delivery.target_base !== this.config.dingtalk.baseId || delivery.target_sheet !== this.config.dingtalk.sheetId)) throw new Error('DingTalkTargetChanged');
        const submission=this.store.getSubmission(delivery.id),assessmentOnly=!!submission.invitation_id;
        if(assessmentOnly){const inv=await this.registrations.process(submission.invitation_id);if(inv.registration?.state!=='synced')throw new Error('RegistrationPending');}
        let result=this.store.result(delivery.result_id);
        if (!result.personality_type || !result.description) {
          if (delivery.fields_json) throw new Error('LegacySnapshotNeedsReview');
          result=this.store.enrichResult(delivery,await this.readReport(this.store.getSubmission(delivery.id).upstream_id));
        }
        // Serialize only before the first attempt; retries reuse the durable payload verbatim.
        if (!delivery.fields_json) {
          const fields=this.ding.prepareFields ? await this.ding.prepareFields(result,{assessmentOnly}) : dingFields(result,this.config.dingtalk.fields,undefined,{assessmentOnly});
          const target=assessmentOnly?await this.ding.findLatest(result):null;
          delivery=this.store.bindTarget(delivery,this.config.dingtalk,fields,target?{operation:'update',record_id:target.id,registration_created_at:target.createdAt}:{});
        }
        if(assessmentOnly&&delivery.operation!=='update'){const target=await this.ding.findLatest(result);delivery=this.store.bindUpdateRecord(delivery,target);}
        const id=delivery.operation==='update'?await this.ding.update(delivery):await this.ding.insert(delivery);
        this.store.delivered(delivery,id);
      } catch(e) { this.store.failed('outbox',delivery,safeCode(e,'DeliveryFailed'),this.delay(delivery.attempts)); }
    }
  }
  async stop() { clearInterval(this.timer); if (this.running) await this.running; }
}
export const safeCode = (e,fallback) => /^[A-Za-z0-9_.-]{1,100}$/.test(e?.message || '') ? e.message : fallback;
