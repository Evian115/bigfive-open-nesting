import { createHash } from 'node:crypto';
import { dimensions } from './config.mjs';
export const validResultId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{6,128}$/.test(id);
// Read the JSON strings in Next.js Flight data; never execute upstream scripts.
export function extractReport(html, id, origin) {
  if (!validResultId(id)) throw new Error('InvalidResultId');
  const streams = [];
  for (const match of html.matchAll(/self\.__next_f\.push\((\[[\s\S]*?\])\)<\/script>/g)) {
    try { const entry = JSON.parse(match[1]); if (entry[0] === 1 && typeof entry[1] === 'string') streams.push(entry[1]); } catch {}
  }
  const stream = streams.join('');
  if (!new RegExp(`"resultId":\\s*${JSON.stringify(id)}`).test(stream)) throw new Error('ReportIdentityMissing');
  const found = [];
  for (const match of stream.matchAll(/"scores":\s*\{/g)) {
    const start = match.index + match[0].length - 1;
    let depth = 0, quoted = false, escape = false, end = start;
    for (; end < stream.length; end++) {
      const c = stream[end];
      if (quoted) { if (escape) escape = false; else if (c === '\\') escape = true; else if (c === '"') quoted = false; }
      else if (c === '"') quoted = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) break;
    }
    try {
      const value = JSON.parse(stream.slice(start, end + 1));
      const scores = Object.fromEntries(Object.entries(dimensions).map(([name, code]) => [name, value[code]?.score]));
      if (Object.values(scores).every(v => Number.isInteger(v) && v >= 0 && v <= 100)) found.push(scores);
    } catch {}
  }
  if (!found.length || found.some(v => JSON.stringify(v) !== JSON.stringify(found[0]))) throw new Error('ReportScoresMissingOrAmbiguous');
  // Read the localized title from the original report component's own props.
  // Slugs are evidence of the archetype component, never translated/classified here.
  const types = new Set(), roots = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (!Array.isArray(value) && value.resultId === id && typeof value.archetypeMinor === 'string' && typeof value.title === 'string') {
      const title = value.title.trim();
      if (title && title.length <= 80 && !/[<>\r\n]/.test(title)) types.add(title);
    }
    for (const child of Object.values(value)) visit(child);
  }
  for (const line of stream.split('\n')) {
    const record = line.match(/^[0-9a-f]+:(.*)$/i);
    if (record) { try { const root=JSON.parse(record[1]); roots.push(root); visit(root); } catch {} }
  }
  if (types.size !== 1) throw new Error('ReportPersonalityMissingOrAmbiguous');
  const personalityType=[...types][0], descriptions=new Set();
  function text(value) {
    if(value==null)return '';
    if(typeof value==='string')return value.startsWith('$')?null:value;
    if(typeof value==='number')return String(value);
    if(!Array.isArray(value))return null;
    if(value[0]==='$')return text(value[3]?.children);
    const parts=value.map(text);return parts.includes(null)?null:parts.join('');
  }
  function description(value) {
    if(!value||typeof value!=='object')return;
    if(Array.isArray(value)) {
      for(let i=0;i<value.length;i++) {
        const node=value[i];
        if(!Array.isArray(node)||node[0]!=='$'||node[1]!=='h1'||text(node[3]?.children)?.trim()!==personalityType)continue;
        const paragraphs=[];
        for(let j=i+1;j<value.length;j++) {
          const sibling=value[j];
          if(!Array.isArray(sibling)||sibling[0]!=='$'||sibling[1]!=='p')break;
          const content=text(sibling[3]?.children)?.trim();
          if(!content){paragraphs.length=0;break;}
          paragraphs.push(content);
        }
        const combined=paragraphs.join('\n\n');
        if(paragraphs.length>=2&&combined.length<=8000)descriptions.add(combined);
      }
    }
    for(const child of Object.values(value))description(child);
  }
  for(const root of roots)description(root);
  if(descriptions.size!==1)throw new Error('ReportDescriptionMissingOrAmbiguous');
  return { ...found[0], personality_type: personalityType, description:[...descriptions][0], result_url: `${origin}/zh/r/${id}`, source_hash: createHash('sha256').update(html).digest('hex') };
}
