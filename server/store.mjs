import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, openSync, fsyncSync, closeSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { dimensions } from './config.mjs';
import { randomUUID, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// One process owns this directory (enforced by proper-lockfile at startup).
// Every acknowledged mutation is atomically renamed and fsynced before returning.
export class Store {
  constructor(directory) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.tasks = join(directory, 'tasks'); mkdirSync(this.tasks, { mode: 0o700, recursive: true });
    const keyPath = join(directory, 'session.key');
    if (!existsSync(keyPath)) { const fd = openSync(keyPath,'wx',0o600); try { writeFileSync(fd,randomBytes(32)); fsyncSync(fd); } finally { closeSync(fd); } }
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error('InvalidSessionKey');
    // Fail closed for corrupt persisted tasks: never silently discard them.
    for (const name of readdirSync(this.tasks)) {
      if (/^[0-9a-f-]{36}\.json\.[0-9a-f-]{36}\.tmp$/.test(name)) rmSync(join(this.tasks,name));
      if (name.endsWith('.json')) { const r = JSON.parse(readFileSync(join(this.tasks,name),'utf8')); if (!uuid.test(r.id) || `${r.id}.json` !== name) throw new Error('InvalidTaskFile'); }
    }
  }
  sign(id) { return createHmac('sha256',this.key).update(id).digest('hex'); }
  session(value) {
    if (typeof value !== 'string') return false;
    const parts=value.split('.');if(parts.length!==2)return false;
    const [id,signature] = parts;
    return uuid.test(id) && /^[a-f0-9]{64}$/.test(signature || '') && timingSafeEqual(Buffer.from(signature),Buffer.from(this.sign(id)));
  }
  newSession() { const id = randomUUID(); return `${id}.${this.sign(id)}`; }
  path(id) { if (!uuid.test(id)) throw new Error('InvalidSubmissionId'); return join(this.tasks,`${id}.json`); }
  getSubmission(id) { const path = this.path(id); return existsSync(path) ? JSON.parse(readFileSync(path,'utf8')) : null; }
  write(row) {
    const path = this.path(row.id), tmp = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(tmp,'wx',0o600);
    try { writeFileSync(fd,JSON.stringify(row)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp,path);
    // Linux durable rename, including on Docker named volumes.
    const dir = openSync(this.tasks,'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
    return row;
  }
  all() { return readdirSync(this.tasks).filter(n => n.endsWith('.json')).map(n => JSON.parse(readFileSync(join(this.tasks,n),'utf8'))); }
  begin(id, session, hash, now = Date.now()) {
    let row = this.getSubmission(id);
    if (row && (row.session_id !== session || row.request_hash !== hash)) return { conflict: true };
    if (row && ['accepted','captured'].includes(row.state)) return { replay: row };
    if (row && row.state === 'submitting' && row.lease_until > now) return { busy: true };
    if (row && ['submitting','uncertain'].includes(row.state)) {
      this.write({ ...row, state: 'uncertain', last_error: 'UpstreamOutcomeUnknown', updated_at: now }); return { uncertain: true };
    }
    const token = randomUUID();
    row = { ...row, id,session_id:session,request_hash:hash,state:'submitting',created_at:row?.created_at ?? now,updated_at:now,
      lease_token:token,lease_until:now+60000,attempts:0,next_attempt_at:0,last_error:null,upstream_rejection:null };
    this.write(row); return { token };
  }
  accept(id, token, upstreamId, body, status) {
    const row = this.getSubmission(id);
    if (row?.lease_token !== token || row.state !== 'submitting') throw new Error('SubmissionLeaseLost');
    this.write({ ...row,state:'accepted',upstream_rejection:null,upstream_id:upstreamId,response_json:body,http_status:status,updated_at:Date.now(),lease_token:null,lease_until:0 });
  }
  reject(id, token, uncertain, error, rejection=null) {
    const row = this.getSubmission(id);
    if (row?.lease_token === token) this.write({ ...row,state:uncertain?'uncertain':'rejected',last_error:error,upstream_rejection:rejection,updated_at:Date.now(),lease_token:null,lease_until:0 });
  }
  claim(table, now = Date.now()) {
    const candidates = this.all().filter(r => table === 'submissions' ? r.state === 'accepted' : r.state === 'captured' && r.delivery?.state !== 'synced');
    for (const row of candidates.sort((a,b) => a.created_at-b.created_at)) {
      const task = table === 'submissions' ? row : row.delivery;
      if (task.next_attempt_at > now || task.lease_until > now) continue;
      const token = randomUUID();
      if (table === 'submissions') return this.write({ ...row,lease_token:token,lease_until:now+60000 });
      this.write({ ...row,delivery:{ ...task,lease_token:token,lease_until:now+60000 } });
      return { ...task,id:row.id,result_id:row.id,lease_token:token };
    }
    return null;
  }
  capture(claimed, report) {
    const row = this.getSubmission(claimed.id);
    if (row?.lease_token !== claimed.lease_token) throw new Error('CaptureLeaseLost');
    const now = Date.now();
    this.write({ ...row,state:'captured',updated_at:now,last_error:null,lease_token:null,lease_until:0,
      pending_result:{ ...report,created_at:now,updated_at:now },
      delivery:{ state:'pending',client_token:randomUUID(),attempts:0,next_attempt_at:0,lease_until:0 } });
    return row.id;
  }
  result(id) { return this.getSubmission(id)?.pending_result; }
  enrichResult(claimed, report) {
    const row = this.getSubmission(claimed.id);
    if (row.delivery.lease_token !== claimed.lease_token) throw new Error('DeliveryLeaseLost');
    if (row.delivery.fields_json) throw new Error('LegacySnapshotNeedsReview');
    if (row.pending_result.result_url !== report.result_url || Object.keys(dimensions).some(key => row.pending_result[key] !== report[key])) throw new Error('ReportChanged');
    const result = { ...row.pending_result, personality_type: report.personality_type, description: report.description, source_hash: report.source_hash };
    this.write({ ...row, pending_result: result });
    return result;
  }
  bindTarget(claimed, settings, fields) {
    const row = this.getSubmission(claimed.id);
    if (row.delivery.lease_token !== claimed.lease_token) throw new Error('DeliveryLeaseLost');
    if (!row.delivery.target_base) this.write({ ...row,delivery:{ ...row.delivery,target_base:settings.baseId,target_sheet:settings.sheetId,fields_json:JSON.stringify(fields) } });
    return { ...this.getSubmission(row.id).delivery,id:row.id,result_id:row.id };
  }
  failed(table, claimed, code, delay) {
    const row = this.getSubmission(claimed.id), task = table === 'submissions' ? row : row.delivery;
    if (task.lease_token !== claimed.lease_token) return;
    const updated = { ...task,attempts:task.attempts+1,last_error:code,next_attempt_at:Date.now()+delay,lease_token:null,lease_until:0 };
    this.write(table === 'submissions' ? updated : { ...row,delivery:{ ...updated,state:'retrying' } });
  }
  delivered(claimed, remoteId) {
    const row = this.getSubmission(claimed.id);
    if (row.delivery.lease_token !== claimed.lease_token) return;
    // Keep minimal deduplication receipts; scores and the write payload are removed after success.
    const { fields_json, ...receipt } = row.delivery;
    delete row.pending_result;
    this.write({ ...row,delivery:{ ...receipt,state:'synced',remote_id:remoteId,synced_at:Date.now(),last_error:null,lease_token:null,lease_until:0 } });
  }
  status(id, session) {
    const row = this.getSubmission(id);
    if (!row || row.session_id !== session) return null;
    const expired=row.state==='submitting'&&row.lease_until<=Date.now();
    return { rejectionCode:row.state==='rejected'?row.upstream_rejection?.code ?? null:null,
      rejectionReason:row.state==='rejected'?row.upstream_rejection?.reason ?? null:null,
      upstreamStatus:row.state==='rejected'?row.upstream_rejection?.status ?? null:null,
      submission:expired?'uncertain':row.state,saved:row.state === 'captured',resultId:row.upstream_id ?? null,
      sync:row.delivery?.state ?? null,attempts:row.delivery?.attempts ?? row.attempts,
      lastError:expired?'UpstreamOutcomeUnknown':row.delivery?.last_error ?? row.last_error,nextAttemptAt:row.delivery?.next_attempt_at ?? row.next_attempt_at };
  }
  close() {}
}
