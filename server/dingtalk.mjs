import { defaultFields, dimensions } from './config.mjs';
export class DeliveryError extends Error {
  constructor(code) { super(/^[A-Za-z0-9_.-]{1,100}$/.test(code) ? code : 'DingTalkRequestFailed'); }
}
export function dingFields(result, map = defaultFields, schema) {
  if (typeof result.personality_type !== 'string' || !result.personality_type.trim()) throw new DeliveryError('MissingPersonalityType');
  if (typeof result.description !== 'string' || !result.description.trim()) throw new DeliveryError('MissingDescription');
  const metadata = (name, fallback) => {
    if (!schema) return fallback;
    const matches=schema.filter(field => field.name===name || field.id===name);
    if (matches.length!==1) throw new DeliveryError('DingTalkFieldMissingOrAmbiguous');
    return matches[0];
  };
  return Object.fromEntries(Object.entries(map).filter(([key])=>!['visitor_name','visitor_phone'].includes(key)||result[key]!==undefined).map(([key,name]) => {
    let value=result[key];
    if (key in dimensions) {
      if (!Number.isInteger(value) || value<0 || value>100) throw new DeliveryError('InvalidScore');
      const field=metadata(name,{type:'number',property:{formatter:'PERCENT'}});
      if (field.type!=='number') throw new DeliveryError('DingTalkScoreFieldTypeChanged');
      if (field.property?.formatter==='PERCENT') value/=100;
    } else if (key==='description') {
      const field=metadata(name,{type:'richText'});
      if (!['text','richText'].includes(field.type)) throw new DeliveryError('DingTalkDescriptionFieldTypeChanged');
      if (field.type==='richText') value={markdown:value};
    } else if (key==='visitor_name' || key==='visitor_phone') {
      if(typeof value!=='string'||!value.trim())throw new DeliveryError('MissingVisitorContact');
      const field=metadata(name,{type:key==='visitor_name'?'text':'telephone'});
      if(field.type!==(key==='visitor_name'?'text':'telephone'))throw new DeliveryError('DingTalkContactFieldTypeChanged');
    } else if (key==='result_url') value={text:'查看原站报告',link:value};
    return [name,value];
  }));
}
// DingTalk appends a final LF when serializing rich text. Preserve internal whitespace.
const normalizedMarkdown = value => typeof value==='string' ? value.replace(/\r\n/g,'\n').replace(/\n+$/,'') : null;
export class DingtalkClient {
  constructor(settings, { fetcher = fetch, origin = 'https://api.dingtalk.com' } = {}) { this.settings=settings; this.fetcher=fetcher; this.origin=origin; }
  async json(url, body, signal, authenticated = true, method = 'POST') {
    const headers = { 'content-type':'application/json' };
    if (authenticated) headers['x-acs-dingtalk-access-token'] = await this.accessToken(signal);
    let response;
    try { response = await this.fetcher(url,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])}); }
    catch { throw new DeliveryError('NetworkOrTimeout'); }
    let data; try { data = await response.json(); } catch { throw new DeliveryError('InvalidResponse'); }
    if (!response.ok || data?.code || data?.errcode) throw new DeliveryError(response.status === 401 ? 'Unauthorized' : typeof data?.code === 'string' ? data.code : `Http${response.status}`);
    if (!data || typeof data !== 'object') throw new DeliveryError('InvalidResponse');
    return data;
  }
  async accessToken(signal) {
    if (this.token?.expires > Date.now()) return this.token.value;
    const data = await this.json(`${this.origin}/v1.0/oauth2/accessToken`,{appKey:this.settings.appKey,appSecret:this.settings.appSecret},signal,false);
    if (typeof data.accessToken !== 'string' || !data.accessToken || !Number.isFinite(data.expireIn) || data.expireIn <= 0) throw new DeliveryError('InvalidTokenResponse');
    this.token={value:data.accessToken,expires:Date.now()+data.expireIn*900}; return this.token.value;
  }
  async prepareFields(result) {
    const signal=AbortSignal.timeout(15000);
    const url=new URL(`${this.origin}/v1.0/notable/bases/${encodeURIComponent(this.settings.baseId)}/sheets/${encodeURIComponent(this.settings.sheetId)}/fields`);
    url.searchParams.set('operatorId',this.settings.operatorId);
    let data;
    for (let attempt=0;attempt<2;attempt++) {
      try { data=await this.json(url,undefined,signal,true,'GET'); break; }
      catch(e) {
        if (!attempt && ['Unauthorized','InvalidAuthentication','InvalidAccessToken','AccessToken.Expired'].includes(e.message)) { this.token=null; continue; }
        throw e;
      }
    }
    if (!Array.isArray(data?.value)) throw new DeliveryError('InvalidFieldSchemaResponse');
    return dingFields(result,this.settings.fields,data.value);
  }
  async recover(url, expected, signal) {
    url = new URL(url); url.pathname += '/list'; url.searchParams.delete('clientToken');
    const matches = new Set(), seen = new Set(); let nextToken;
    do {
      const page = await this.json(url,{maxResults:100,fieldIdOrNames:Object.keys(expected),...(nextToken ? {nextToken} : {})},signal);
      if (!Array.isArray(page.records)) throw new DeliveryError('InvalidListResponse');
      for (const row of page.records) {
        const equals = Object.entries(expected).every(([name,value]) => {
          const actual=row.fields?.[name];
          if (value && typeof value==='object') {
            if (typeof value.link==='string') return actual?.link===value.link;
            if (name===(this.settings.fields?.description ?? defaultFields.description) && typeof value.markdown==='string') return normalizedMarkdown(actual?.markdown)===normalizedMarkdown(value.markdown);
            return false;
          }
          if (typeof value==='string') return (name===(this.settings.fields?.personality_type ?? defaultFields.personality_type) ? (typeof actual==='string'?actual:actual?.name) : actual)===value;
          return typeof value==='number' && (typeof actual==='number' || typeof actual==='string' && actual.trim()!=='') && Number(actual)===value;
        });
        if (equals && typeof row.id === 'string' && row.id) matches.add(row.id);
      }
      if (!page.hasMore) break;
      if (typeof page.nextToken !== 'string' || !page.nextToken || seen.has(page.nextToken)) throw new DeliveryError('InvalidPagination');
      nextToken=page.nextToken; seen.add(nextToken);
    } while (true);
    if (matches.size !== 1) throw new DeliveryError(matches.size ? 'DuplicateRecordAmbiguous' : 'DuplicateRecordNotFound');
    return [...matches][0];
  }
  async insert(task) {
    const signal = AbortSignal.timeout(45000);
    const url = new URL(`${this.origin}/v1.0/notable/bases/${encodeURIComponent(task.target_base)}/sheets/${encodeURIComponent(task.target_sheet)}/records`);
    const rawToken=task.client_token;
    // DingTalk requires a canonical UUID; normalize older persisted 32-hex tokens deterministically.
    const clientToken=/^[0-9a-f]{32}$/i.test(rawToken) ? rawToken.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,'$1-$2-$3-$4-$5') : rawToken;
    url.searchParams.set('operatorId',this.settings.operatorId); url.searchParams.set('clientToken',clientToken);
    const fields = JSON.parse(task.fields_json);
    for (let attempt=0;attempt<2;attempt++) {
      try {
        const data = await this.json(url,{records:[{fields}]},signal);
        if (!Array.isArray(data.value) || data.value.length !== 1 || typeof data.value[0]?.id !== 'string' || !data.value[0].id) throw new DeliveryError('InvalidInsertResponse');
        return data.value[0].id;
      } catch (e) {
        if (e.message === 'invalidRequest.duplicateClientToken') return this.recover(url,fields,signal);
        if (!attempt && ['Unauthorized','InvalidAuthentication','InvalidAccessToken','AccessToken.Expired'].includes(e.message)) { this.token=null; continue; }
        throw e;
      }
    }
  }
}
