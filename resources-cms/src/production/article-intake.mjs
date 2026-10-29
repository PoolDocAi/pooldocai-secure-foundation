import { createHash, randomUUID } from 'node:crypto';
import { inflateRawSync, crc32 } from 'node:zlib';
import markedBundle from '../generated/marked.cjs';
const { marked } = markedBundle;
import { normalizeArticleCommand } from './validation.mjs';

export const MAX_ARTICLE_FILE = 1024 * 1024;
const reject = (message) => { throw Object.assign(new Error(message), { status: 422 }); };
const escape = value => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const articleChecksum = article => createHash('sha256').update(JSON.stringify(article)).digest('hex');

// Read only the main document part. Never load relationships, images, macros,
// external URLs or embedded objects. ZIP/expansion limits precede extraction.
export function docxText(bytes) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) reject('Invalid DOCX archive');
  const count = bytes.readUInt16LE(end + 10), offset = bytes.readUInt32LE(end + 16);
  if (!count || count > 500 || count !== bytes.readUInt16LE(end + 8) || offset + bytes.readUInt32LE(end + 12) !== end) reject('Unsupported DOCX archive');
  let pos = offset, total = 0, document;
  const names = new Set();
  for (let n = 0; n < count; n++) {
    if (pos + 46 > end || bytes.readUInt32LE(pos) !== 0x02014b50) reject('Invalid DOCX directory');
    const flags = bytes.readUInt16LE(pos + 8), method = bytes.readUInt16LE(pos + 10);
    const size = bytes.readUInt32LE(pos + 24), packed = bytes.readUInt32LE(pos + 20), local = bytes.readUInt32LE(pos + 42);
    const length = bytes.readUInt16LE(pos + 28), next = pos + 46 + length + bytes.readUInt16LE(pos + 30) + bytes.readUInt16LE(pos + 32);
    if (next > end || local + 30 > offset || size > 2_000_000 || (total += size) > 8_000_000 || (flags & 1) || ![0, 8].includes(method)) reject('DOCX size, encryption or compression rejected');
    const name = bytes.subarray(pos + 46, pos + 46 + length).toString('utf8');
    if (names.has(name) || /(?:^|\/)\.\.(?:\/|$)|\\|^\//.test(name) || /vbaProject|embeddings\//i.test(name)) reject('Unsupported DOCX content');
    names.add(name);
    if (name === 'word/document.xml') {
      if (bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 8) !== method || bytes.readUInt16LE(local + 6) !== flags) reject('Invalid DOCX entry');
      const nameLength = bytes.readUInt16LE(local + 26), start = local + 30 + nameLength + bytes.readUInt16LE(local + 28);
      if (bytes.subarray(local + 30, local + 30 + nameLength).toString('utf8') !== name || start + packed > offset) reject('Invalid DOCX bounds');
      try { document = method === 8 ? inflateRawSync(bytes.subarray(start, start + packed), { maxOutputLength: 2_000_000 }) : bytes.subarray(start, start + packed); }
      catch { reject('DOCX extraction rejected'); }
      if (document.length !== size || crc32(document) !== bytes.readUInt32LE(pos + 16)) reject('Invalid DOCX expanded size or checksum');
    }
    pos = next;
  }
  if (pos !== end || !document || !names.has('[Content_Types].xml')) reject('DOCX main document is missing');
  let xml;
  try { xml = new TextDecoder('utf-8', { fatal: true }).decode(document); } catch { reject('Invalid DOCX text encoding'); }
  if (/<!DOCTYPE|<!ENTITY|<w:(?:altChunk|object|instrText)\b/i.test(xml) || !/<w:document\b/.test(xml) || !/<\/w:document>/.test(xml)) reject('Unsupported DOCX fields or embedded content');
  const decode = text => text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
    if (entity[0] !== '#') return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[entity.toLowerCase()];
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2),16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  });
  return [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)].map(p => [...p[1].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:(tab|br)\b[^>]*\/?\s*>/g)].map(t => t[2] ? (t[2] === 'tab' ? '\t' : '\n') : decode(t[1])).join('')).join('\n\n');
}

export function parseArticleFile({ name, base64, categoryId }) {
  if (typeof name !== 'string' || name.length > 200 || typeof base64 !== 'string' || base64.length > Math.ceil(MAX_ARTICLE_FILE / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) reject('Invalid article file');
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length > MAX_ARTICLE_FILE) reject('Article files must be between 1 byte and 1 MB');
  const extension = name.split('.').pop().toLowerCase();
  if (!['docx','md','txt','json'].includes(extension)) reject('Only DOCX, MD, TXT and approved structured JSON are supported; PDFs are disabled');
  let text;
  try { text = extension === 'docx' ? docxText(bytes) : new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); }
  catch (e) { if (e.status) throw e; reject('Invalid article file encoding'); }
  if (text.includes('\0') || text.length > 200_000) reject('Article text is too large or contains binary data');
  let article;
  if (extension === 'json') {
    let input;
    try { input = JSON.parse(text); } catch { reject('Invalid structured article JSON'); }
    // Source-approved collection imports retain their separate checksum/allowlist
    // route. Uploaded JSON cannot manufacture source provenance or approval.
    if (input?.format !== 'pooldocai-resource-v1' || !input.article || Object.keys(input).some(k => !['format','article'].includes(k))) reject('Use the approved pooldocai-resource-v1 article structure');
    article = input.article;
  } else {
    if (!text.trim()) reject('Article text is empty');
    const title = text.split(/\r?\n/).find(line => line.trim())?.replace(/^#+\s*/, '').trim().slice(0,180);
    const stem = title.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,105).replace(/-$/,'') || 'article';
    article = {title, slug:`${stem}-${randomUUID().slice(0,8)}`, categoryId, tagIds:[], sources:[], summary:'', seo:{}, body:extension === 'md' ? marked.parse(text, {async:false}) : text.split(/\r?\n\s*\r?\n/).map(p=>`<p>${escape(p).replace(/\r?\n/g,'<br>')}</p>`).join('')};
  }
  const normalized = normalizeArticleCommand('create', article);
  return { article:normalized, source:{format:'pooldocai-upload-v1',sha256:createHash('sha256').update(bytes).digest('hex'),type:extension,bytes:bytes.length}, notices:extension==='docx'?['DOCX imports plain paragraph text only. Verify headings, tables, citations and image rights against the original before publication.']:[] };
}
