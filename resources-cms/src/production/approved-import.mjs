import { createHash } from 'node:crypto';
import { normalizeArticleCommand } from './validation.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const importDigest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJSON(value)).digest('hex');
export function canonicalJSON(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJSON(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export function importUUID(identity) {
  const bytes = Buffer.from(importDigest(identity).slice(0,32),'hex');
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const hex=bytes.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
const fail = message => { throw Object.assign(new TypeError(message),{status:422}); };

// trustedCatalog is loaded from the private deployment/import package, never
// supplied by the request. A checksum by itself is not editorial approval.
export function validateApprovedImport(value, trustedCatalog) {
  if (!value || value.format !== 'pooldocai-owner-import-v1' || !Array.isArray(trustedCatalog)) fail('Approved import format required');
  if (value.resourceId === '30') fail('Resource 30 is excluded');
  if (!UUID.test(value.articleId || '') || !UUID.test(value.commandId || '')) fail('Stable import identity required');
  const trusted=trustedCatalog.find(item => item.source?.identity === value.source?.identity);
  if (!trusted || canonicalJSON(trusted) !== canonicalJSON(value)) fail('Import does not match the private approved catalog');
  const raw=Buffer.from(value.source.base64 || '', 'base64');
  if (!raw.length || raw.length>2_000_000 || importDigest(raw)!==value.source.sha256) fail('Original source checksum mismatch');
  if (value.commandId !== importUUID(`${value.articleId}:${value.source.identity}:${value.source.sha256}:${value.bodyChecksum}`)) fail('Import command identity mismatch');
  if (value.state!=='draft' || value.publicationAuthorized!==false || value.knowledgeEligible!==false || value.hold!==true) fail('Imports must remain protected drafts');
  if (!Array.isArray(value.history) || !value.history.length || value.history.length>30) fail('Immutable history required');
  let version=0;
  for (const row of value.history) {
    if (!UUID.test(row.id||'') || row.article_id!==value.articleId || row.revision_number!==++version) fail('Invalid historical revision identity');
    const clean=normalizeArticleCommand('create',row.editable);
    if (clean.body!==row.editable.body.replace(/ role="note"/g,'').trim() || row.rendered_html!==row.editable.body) fail('Unsafe imported HTML');
  }
  if (importDigest(value.article.body)!==value.bodyChecksum || canonicalJSON(value.article)!==canonicalJSON(value.history.at(-1).editable)) fail('Approved body checksum mismatch');
  normalizeArticleCommand('create',value.article);
  return structuredClone(value);
}

export function planApprovedImport(value, trustedCatalog, existing=[]) {
  const entry=validateApprovedImport(value,trustedCatalog);
  const collision=existing.find(row=>row.slug===entry.article.slug && row.id!==entry.articleId);
  if(collision) throw Object.assign(new Error('Canonical slug already belongs to another resource'),{status:409});
  const prior=existing.find(row=>row.id===entry.articleId);
  if(prior?.sourceChecksums?.includes(entry.source.sha256)) return {action:'unchanged',articleId:entry.articleId,commandId:entry.commandId};
  return {action:prior?'append-approved-draft':'create-protected-draft',articleId:entry.articleId,commandId:entry.commandId,entry};
}
