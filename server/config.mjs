import { resolve } from 'node:path';
export const dimensions = { openness: 'O', conscientiousness: 'C', extraversion: 'E', agreeableness: 'A', neuroticism: 'N' };
export const defaultFields = { openness: '开放性', conscientiousness: '尽责性', extraversion: '外向性', agreeableness: '宜人性', neuroticism: '神经质', personality_type: '人格类型', description: '描述', result_url: '链接', created_at: '写入时间', updated_at: '更新时间' };
export function config(env = process.env) {
  const number = (key, fallback, min = 1) => {
    const value = Number(env[key] || fallback);
    if (!Number.isSafeInteger(value) || value < min) throw new Error(`Invalid configuration: ${key}`);
    return value;
  };
  const upstream = new URL(env.UPSTREAM_ORIGIN || 'https://bigfivepersonality.me');
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) throw new Error('Invalid UPSTREAM_ORIGIN');
  const origin = env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN) : null;
  if (origin && (!['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password)) throw new Error('Invalid PUBLIC_ORIGIN');
  const additionalOrigins=(env.ADDITIONAL_ORIGINS || '').split(',').map(value=>value.trim()).filter(Boolean).map(value=>{
    const url=new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.pathname!=='/' || url.search || url.hash || url.username || url.password) throw new Error('Invalid ADDITIONAL_ORIGINS');
    return url.origin;
  });
  if (additionalOrigins.length && !origin) throw new Error('ADDITIONAL_ORIGINS requires PUBLIC_ORIGIN');
  const dingNames = ['DINGTALK_APP_KEY', 'DINGTALK_APP_SECRET', 'DINGTALK_BASE_ID', 'DINGTALK_SHEET_ID_OR_NAME', 'DINGTALK_OPERATOR_ID'];
  const ding = dingNames.map(name => env[name]?.trim() || '');
  if (ding.some(Boolean) && ding.some(x => !x)) throw new Error(`Missing configuration: ${dingNames.filter((_, i) => !ding[i]).join(', ')}`);
  const overrides = JSON.parse(env.DINGTALK_FIELD_MAP || '{}');
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides) || Object.entries(overrides).some(([k,v]) => !(k in defaultFields) || typeof v !== 'string' || !v)) throw new Error('Invalid DINGTALK_FIELD_MAP');
  const fields = { ...defaultFields, ...overrides };
  if (new Set(Object.values(fields)).size !== Object.keys(defaultFields).length) throw new Error('Duplicate DingTalk field names');
  return {
    host: env.HOST || '127.0.0.1', port: number('PORT', 8082, 0), publicOrigin: origin?.origin, additionalOrigins,
    upstreamOrigin: upstream.origin, stateDirectory: resolve(env.STATE_DIRECTORY || './data'),
    cookieSecure: env.COOKIE_SECURE === 'true' || origin?.protocol === 'https:',
    retryBaseMs: number('RETRY_BASE_MS', 10000), retryMaxMs: number('RETRY_MAX_MS', 300000), workerIntervalMs: number('WORKER_INTERVAL_MS', 2000),
    dingtalk: ding.every(Boolean) ? { appKey: ding[0], appSecret: ding[1], baseId: ding[2], sheetId: ding[3], operatorId: ding[4], fields } : null,
  };
}
