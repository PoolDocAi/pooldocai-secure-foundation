import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import mammoth from 'mammoth';
import WordExtractor from 'word-extractor';
import * as cheerio from 'cheerio';
import sharp from 'sharp';
import heicConvert from 'heic-convert';

const PORT = Number(process.env.PORT || 8080);
const MAX_BYTES = Math.min(Number(process.env.MAX_DOWNLOAD_BYTES || 25 * 1024 * 1024), 25 * 1024 * 1024);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SECRET = process.env.DOC_WORKER_SECRET;
const REQUIRE_HMAC = String(process.env.DOC_WORKER_REQUIRE_HMAC || 'true').toLowerCase() !== 'false';
const MAX_CLOCK_SKEW_SECONDS = 300;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_OCR_MODEL = process.env.GEMINI_OCR_MODEL || 'gemini-3.8-flash';
const GEMINI_EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';
const EMBEDDING_DIMENSIONS = 768;
function utcMonthStartDate() { const now = new Date(); return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10); }
if (!SUPABASE_URL || !SERVICE_KEY || !SECRET) throw new Error('Startup configuration error: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and DOC_WORKER_SECRET are required.');
if (!/^https:\/\//i.test(SUPABASE_URL)) throw new Error('Startup configuration error: SUPABASE_URL must use HTTPS.');
if (!process.env.GEMINI_API_KEY) console.warn('GEMINI_API_KEY is not configured; image/scanned-document OCR will fail until configured.');
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

function json(res, status, value) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); }
function scrub(text) {
  return String(text || '')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL REDACTED]')
    .replace(/\b(?:\+?1[ .-]?)?(?:\(?\d{3}\)?[ .-]?)\d{3}[ .-]?\d{4}\b/g, '[PHONE REDACTED]')
    .replace(/\b(?:my name is|customer name:|contact:|name:)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/gi, '[NAME REDACTED]')
    .replace(/\b\d{1,6}\s+[\w.'-]+(?:\s+[\w.'-]+){0,5}\s(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|boulevard|blvd|way|circle|cir|highway|hwy)\b[^\n,;]{0,80}/gi, '[ADDRESS REDACTED]')
    .replace(/\b\d{5}(?:-\d{4})?\b/g, '[POSTAL CODE REDACTED]')
    .replace(/\s+/g, ' ').trim();
}
function chunkText(input, size = 1200, overlap = 180) {
  const text = String(input || '').replace(/\r/g, '').replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const out = []; let start = 0;
  while (start < text.length && out.length < 500) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) { const boundary = Math.max(text.lastIndexOf('\n', end), text.lastIndexOf('. ', end), text.lastIndexOf(' ', end)); if (boundary > start + size * .55) end = boundary + 1; }
    const part = text.slice(start, end).trim(); if (part.length >= 30) out.push(part);
    if (end >= text.length) break; start = Math.max(start + 1, end - overlap);
  }
  return out;
}
function chunkPages(pages, size = 1200, overlap = 180) {
  const out = [];
  for (const page of pages || []) {
    const pageNum = Number.isInteger(page.pageNumber) && page.pageNumber > 0 ? page.pageNumber : null;
    for (const content of chunkText(page.text, size, overlap)) out.push({ content, pageNumber: pageNum, pageStart: pageNum, pageEnd: pageNum });
    if (out.length >= 500) break;
  }
  return out.slice(0, 500);
}
async function recordUsageOnce(event) {
  const { error } = await db.from('platform_usage_events').insert(event);
  if (error && error.code !== '23505') {
    // Usage telemetry must never turn a successful document extraction into a failed job.
    // The unique source_event_key index quietly deduplicates a retry of the same job.
    console.warn('Usage metering event could not be stored', { code: error.code, event_type: event.event_type });
  }
}

async function estimateProviderCost(model, inputTokens, outputTokens = 0) {
  const normalizedInput = Math.max(0, Number(inputTokens) || 0);
  const normalizedOutput = Math.max(0, Number(outputTokens) || 0);
  if (!model || (!normalizedInput && !normalizedOutput)) return { estimatedCostUsd: null, costSource: 'not_priced' };
  try {
    const rateLookupTime = new Date().toISOString();
    const { data: rates, error } = await db.from('pooldocai_model_rate_cards')
      .select('input_usd_per_million_tokens,output_usd_per_million_tokens')
      .eq('provider', 'google_gemini').eq('model', model).eq('active', true)
      .lte('valid_from', rateLookupTime)
      .or(`valid_to.is.null,valid_to.gt.${rateLookupTime}`)
      .order('valid_from', { ascending: false }).limit(1);
    const rate = rates?.[0];
    if (error || !rate || rate.input_usd_per_million_tokens == null || rate.output_usd_per_million_tokens == null) {
      return { estimatedCostUsd: null, costSource: 'not_priced' };
    }
    const cost = normalizedInput * Number(rate.input_usd_per_million_tokens) / 1_000_000
      + normalizedOutput * Number(rate.output_usd_per_million_tokens) / 1_000_000;
    return Number.isFinite(cost) ? { estimatedCostUsd: cost, costSource: 'rate_card_estimate' } : { estimatedCostUsd: null, costSource: 'not_priced' };
  } catch {
    return { estimatedCostUsd: null, costSource: 'not_priced' };
  }
}

async function embedDocumentChunks(chunks) {
  if (!GEMINI_KEY || !chunks.length) return [];
  const all = [];
  for (let offset = 0; offset < chunks.length; offset += 32) {
    const batch = chunks.slice(offset, offset + 32);
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_EMBEDDING_MODEL)}:batchEmbedContents?key=${encodeURIComponent(GEMINI_KEY)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(60000),
      body: JSON.stringify({ requests: batch.map(item => ({ model: `models/${GEMINI_EMBEDDING_MODEL}`, content: { parts: [{ text: item.content.slice(0, 8000) }] }, taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: EMBEDDING_DIMENSIONS })) })
    });
    if (!response.ok) throw new Error(`Embedding service returned HTTP ${response.status}.`);
    const data = await response.json();
    const embeddings = Array.isArray(data.embeddings) ? data.embeddings : [];
    if (embeddings.length !== batch.length) throw new Error('Embedding service returned an unexpected vector count.');
    for (const item of embeddings) {
      const values = item?.values;
      if (!Array.isArray(values) || values.length !== EMBEDDING_DIMENSIONS || values.some(v => !Number.isFinite(v))) throw new Error('Embedding service returned an invalid vector.');
      all.push(values);
    }
  }
  return all;
}
function parseOcrPdfPages(text) {
  const raw = String(text || '');
  const marker = /(?:^|\n)\s*(?:={2,}\s*)?PAGE\s+(\d+)\s*(?:={2,})?\s*(?:\n|$)/gim;
  const matches = [...raw.matchAll(marker)];
  if (!matches.length) return [{ pageNumber: null, text: raw.trim() }];
  return matches.map((m, i) => ({ pageNumber: Number(m[1]), text: raw.slice((m.index || 0) + m[0].length, i + 1 < matches.length ? matches[i + 1].index : raw.length).trim() })).filter(p => p.text);
}
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224
      || (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
      || (p[0] === 169 && p[1] === 254)
      || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
      || (p[0] === 192 && (p[1] === 0 || p[1] === 2 || p[1] === 88 || p[1] === 168))
      || (p[0] === 198 && (p[1] === 18 || p[1] === 19 || p[1] === 51))
      || (p[0] === 203 && p[1] === 0 && p[2] === 113);
  }
  if (net.isIPv6(ip)) {
    // Allow only globally routable unicast space. This also blocks IPv4-mapped IPv6,
    // NAT64, loopback, link-local, ULA, multicast, and other special-use ranges even
    // when those ranges are written in compressed hexadecimal form.
    const groups = ip.toLowerCase().split(':');
    const firstGroup = Number.parseInt(groups[0] || '0', 16);
    const secondGroup = Number.parseInt(groups[1] || '0', 16);
    if (!Number.isFinite(firstGroup) || firstGroup < 0x2000 || firstGroup > 0x3fff) return true;
    if (firstGroup === 0x2001 && (secondGroup <= 0x01ff || secondGroup === 0x0db8)) return true;
    if (firstGroup === 0x2002 || firstGroup === 0x3fff) return true;
    return false;
  }
  return true;
}
async function safeUrl(raw, { requireHttps = false } = {}) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only public http/https webpages are supported.');
  if (requireHttps && url.protocol !== 'https:') throw new Error('Webhook destinations must use HTTPS.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || ['localhost', 'localhost.localdomain'].includes(host) || host.endsWith('.local')) throw new Error('Private/local addresses are blocked.');
  const records = net.isIP(host)
    ? [{ address: host, family: net.isIPv4(host) ? 4 : 6 }]
    : await dns.lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some(record => isPrivateAddress(record.address))) throw new Error('Host resolves to a private or restricted address and was blocked.');
  // Pin the specific public address validated above. Do not let a second DNS lookup
  // during the HTTP connection change the destination after validation.
  return { url, address: records[0].address, family: records[0].family || (net.isIPv4(records[0].address) ? 4 : 6) };
}
function requestPinnedUrl(target, { method = 'GET', headers = {}, body = null, timeoutMs = 20000, maxBytes = MAX_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const url = target.url;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const transport = url.protocol === 'https:' ? https : http;
    const requestHeaders = { 'user-agent': 'PoolDocAI-DocumentWorker/1.0', ...headers };
    if (body != null && !Object.keys(requestHeaders).some(key => key.toLowerCase() === 'content-length')) {
      requestHeaders['content-length'] = Buffer.byteLength(body);
    }
    const req = transport.request({
      protocol: url.protocol,
      hostname: host,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method,
      headers: requestHeaders,
      ...(url.protocol === 'https:' ? { servername: host } : {}),
      lookup: (_hostname, options, callback) => {
        if (options?.all) return callback(null, [{ address: target.address, family: target.family }]);
        return callback(null, target.address, target.family);
      }
    }, response => {
      const declared = Number(response.headers['content-length'] || 0);
      if (declared > maxBytes) {
        req.destroy(new Error('Remote response exceeds the configured size limit.'));
        return;
      }
      const chunks = [];
      let total = 0;
      response.on('data', chunk => {
        total += chunk.length;
        if (total > maxBytes) {
          req.destroy(new Error('Remote response exceeds the configured size limit.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        statusCode: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
      response.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Remote request timed out.')));
    req.on('error', reject);
    req.end(body == null ? undefined : body);
  });
}
async function fetchWebpage(raw) {
  let target = await safeUrl(raw);
  for (let hop = 0; hop <= 3; hop++) {
    const response = await requestPinnedUrl(target, { timeoutMs: 20000, maxBytes: MAX_BYTES });
    if ([301,302,303,307,308].includes(response.statusCode)) {
      const location = response.headers.location;
      if (!location || hop === 3) throw new Error('Webpage redirect limit reached.');
      target = await safeUrl(new URL(location, target.url).toString());
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`Webpage returned HTTP ${response.statusCode}.`);
    const type = String(response.headers['content-type'] || '');
    if (!type.includes('text/html') && !type.includes('text/plain') && !type.includes('application/xhtml+xml')) throw new Error('Webpage must return HTML or plain text.');
    const textBody = response.body.toString('utf8');
    if (type.includes('text/plain')) return { text: textBody, title: target.url.hostname, sourceUrl: target.url.toString() };
    const $ = cheerio.load(textBody); const title = $('title').first().text().trim() || target.url.hostname;
    $('script,style,noscript,svg,nav,footer,header,form,iframe,button').remove();
    const text = $('main').text() || $('article').text() || $('body').text();
    return { text: text.replace(/\s+/g, ' ').trim(), title, sourceUrl: target.url.toString() };
  }
  throw new Error('Could not retrieve webpage.');
}
async function geminiExtract(buffer, mimeType, prompt) {
  if (!GEMINI_KEY) throw new Error('This file appears to require OCR, but GEMINI_API_KEY is not configured.');
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_OCR_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(90000),
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: buffer.toString('base64') } }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 8192 } })
  });
  if (!response.ok) throw new Error(`OCR service returned HTTP ${response.status}.`);
  const data = await response.json(); return { text: (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('\n').trim(), usage: data.usageMetadata || null, model: GEMINI_OCR_MODEL };
}
async function extractFile(buffer, filename, contentType) {
  const ext = filename.toLowerCase().split('.').pop();
  if (['txt','md','csv','json','xml','log'].includes(ext) || contentType.startsWith('text/')) return { text: buffer.toString('utf8'), title: filename };
  if (ext === 'pdf' || contentType === 'application/pdf') {
    let text = ''; const pageTexts = []; let usage = null; let model = null;
    try {
      const result = await pdfParse(buffer, { pagerender: async pageData => {
        const content = await pageData.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
        const pageText = (content.items || []).map(item => item.str || '').join(' ').replace(/\s+/g, ' ').trim();
        pageTexts.push(pageText); return pageText;
      }});
      text = result.text || '';
    } catch { /* scanned PDF OCR fallback below */ }
    let pages = pageTexts.map((value, index) => ({ pageNumber: index + 1, text: value })).filter(page => page.text.length > 0);
    if (text.replace(/\s/g, '').length < 80) {
      const ocr = await geminiExtract(buffer, 'application/pdf', 'Extract all readable text from this PDF. Preserve safety warnings, headings, tables, model numbers, units and numbered procedures. You MUST start each page transcription with a standalone marker exactly like === PAGE 1 ===, === PAGE 2 ===, using the actual PDF page number. Do not merge pages. Return extracted text only.');
      text = ocr.text; usage = ocr.usage; model = ocr.model; pages = parseOcrPdfPages(text);
    }
    if (!pages.length) pages = [{ pageNumber: null, text }];
    return { text, title: filename, pages, usage, model };
  }
  if (['docx','docm'].includes(ext) || contentType.includes('wordprocessingml')) {
    const result = await mammoth.extractRawText({ buffer }); return { text: result.value || '', title: filename };
  }
  if (ext === 'doc' || contentType === 'application/msword') {
    const extractor = new WordExtractor(); const doc = await extractor.extract(buffer); return { text: doc.getBody() || '', title: filename };
  }
  if (['html','htm','xhtml'].includes(ext)) {
    const $ = cheerio.load(buffer.toString('utf8')); const title = $('title').first().text().trim() || filename;
    $('script,style,noscript,svg,nav,footer,header,form,iframe').remove(); return { text: ($('main').text() || $('article').text() || $('body').text()).replace(/\s+/g,' ').trim(), title };
  }
  if (['jpg','jpeg','png','webp','tif','tiff','bmp','gif','heic','heif'].includes(ext) || contentType.startsWith('image/')) {
    let image = buffer; let mime = contentType || 'image/jpeg';
    if (['heic','heif'].includes(ext) || /heic|heif/i.test(mime)) {
      image = Buffer.from(await heicConvert({ buffer, format: 'JPEG', quality: 0.9 })); mime = 'image/jpeg';
    } else {
      image = await sharp(buffer, { limitInputPixels: 80_000_000 }).rotate().jpeg({ quality: 88 }).toBuffer(); mime = 'image/jpeg';
    }
    const ocr = await geminiExtract(image, mime, 'Read and transcribe all visible text from this image. Preserve headings, model/serial labels, error codes, units, tables and safety warnings. If no text is visible, describe the equipment and visible labels briefly. Do not infer hidden text.');
    return { text: ocr.text, title: filename, usage: ocr.usage, model: ocr.model };
  }
  throw new Error('Unsupported file type. Upload JPEG, PNG, HEIC/HEIF, WebP, TIFF, BMP, GIF, PDF, DOC, DOCX, TXT, Markdown, CSV, JSON, XML, or HTML.');
}

function classifyEquipment(title, text) {
  const sample = `${title || ''} ${String(text || '').slice(0, 12000)}`.toLowerCase();
  const brands = [['pentair', /\bpentair\b/], ['hayward', /\bhayward\b/], ['jandy/fluidra', /\bjandy\b|\bfluidra\b/], ['raypak', /\braypak\b/]];
  const categories = [['heater', /\bheater\b|\bheat pump\b|\bignition lockout\b/], ['pump', /\bpump\b|\bpriming\b|\bvariable[- ]speed\b/], ['filter', /\bfilter\b|\bbackwash\b/], ['salt system', /\bsalt cell\b|\bsalt system\b|\baquarite\b/], ['automation', /\bautomation\b|\bcontroller\b/], ['cleaner', /\bpool cleaner\b|\brobotic cleaner\b/], ['water chemistry', /\balkalinity\b|\bcalcium hardness\b|\bchlorine\b|\bcya\b|\bsaturation index\b/]];
  const expanded = [...categories, ['HVAC / furnace', /\bfurnace\b|\bair handler\b|\bcompressor\b|\bthermostat\b|\bevaporator\b|\bcondenser\b/], ['plumbing', /\bwater heater\b|\bdrain\b|\btoilet\b|\bwater pressure\b|\bpipe\b|\bsewer\b|\bbackflow\b|\bsump\b/]];
  const genericBrands = ['trane','carrier','lennox','rheem','goodman','navien','rinnai','moen','kohler','zurn'];
  return { manufacturer: brands.find(([,re])=>re.test(sample))?.[0] || genericBrands.find(b=>new RegExp('\\b'+b+'\\b','i').test(sample)) || null, category: expanded.find(([,re])=>re.test(sample))?.[0] || null };
}

async function queueManualForLearning(manual, chunks) {
  if (!manual.shared_learning_opt_in || !chunks.length) return 0;
  const { data: existing = [] } = await db.from('learning_review_queue').select('supporting_source_ids,status').eq('tenant_id', manual.company_id).eq('source_kind', 'company_manual').in('status', ['pending','approved']).limit(5000);
  const already = new Set((existing || []).flatMap(row => row.supporting_source_ids || []));
  const prepared = [];
  for (let i=0; i<chunks.length; i++) {
    const marker = `${manual.id}#chunk-${i}`;
    if (already.has(marker)) continue;
    const lesson = scrub(chunks[i]).slice(0,1900); if (lesson.length < 40) continue;
    prepared.push({ marker, lesson, source_ids: [manual.id, marker] });
  }
  let queued = 0;
  for (let offset=0; offset<prepared.length; offset+=100) {
    const batch = prepared.slice(offset, offset+100);
    const cases = batch.map(item => ({ tenant_id: manual.company_id, case_status: 'resolved', equipment_category: manual.document_type || 'manual', symptom_redacted: `Extracted reference from opted-in company document: ${scrub(manual.title).slice(0,160)}`, source_ids: item.source_ids, technician_verified: false, approved_for_learning: false }));
    const { data: created, error: ce } = await db.from('diagnostic_cases').insert(cases).select('id,source_ids');
    if (ce || !created) { console.error('learning case batch insert failed', ce?.code); continue; }
    const queueRows = created.map(row => ({ case_id: row.id, tenant_id: manual.company_id, source_kind: 'company_manual', proposed_lesson_redacted: batch.find(item => item.marker === (row.source_ids || []).find(x => x.includes('#chunk-')))?.lesson || '', supporting_source_ids: row.source_ids, status: 'pending' })).filter(row => row.proposed_lesson_redacted.length >= 40);
    const { error: qe } = await db.from('learning_review_queue').insert(queueRows);
    if (qe) { console.error('manual learning queue batch insert failed', qe.code); continue; }
    queued += queueRows.length;
  }
  return queued;
}
async function processManual(manualId, processingJobId = null) {
  const { data: manual, error } = await db.from('company_manuals').select('*').eq('id', manualId).maybeSingle();
  if (error || !manual) throw new Error('Company document was not found.');
  await db.from('company_manuals').update({ extraction_status: 'processing', extraction_error: null }).eq('id', manual.id);
  try {
    let extracted;
    if (manual.source_url) extracted = await fetchWebpage(manual.source_url);
    else {
      const { data: file, error: downloadError } = await db.storage.from('company-manuals').download(manual.storage_path);
      if (downloadError || !file) throw new Error('Could not read the private uploaded file.');
      const array = await file.arrayBuffer(); if (array.byteLength > MAX_BYTES) throw new Error('File exceeds the 25 MB extraction limit.');
      extracted = await extractFile(Buffer.from(array), manual.original_filename || manual.title, manual.content_type || 'application/octet-stream');
    }
    const raw = String(extracted.text || '').replace(/\u0000/g, '').trim();
    if (raw.length < 20) throw new Error('No usable text could be extracted. Check that the document is readable and not password-protected.');
    if (raw.length > 1_500_000) throw new Error('Extracted text exceeds the 1.5 million character safety limit. Split the document into smaller files.');
    const pageSource = Array.isArray(extracted.pages) && extracted.pages.length ? extracted.pages : [{ pageNumber: null, text: raw }];
    const chunks = chunkPages(pageSource);
    if (!chunks.length) throw new Error('No usable chunks could be produced from this document.');
    const { data: company } = await db.from('companies').select('industry_key').eq('id', manual.company_id).maybeSingle();
    const industryKey = String(company?.industry_key || manual.industry_key || 'pool');
    const equipmentTags = classifyEquipment(manual.title || extracted.title, raw);
    let embeddings = [];
    let embeddingModel = null;
    try { embeddings = await embedDocumentChunks(chunks); embeddingModel = GEMINI_EMBEDDING_MODEL; }
    catch (embeddingError) { console.warn('Semantic embedding was unavailable; keyword retrieval will remain enabled.', String(embeddingError?.message || '').slice(0,180)); }
    await db.from('company_manual_chunks').delete().eq('manual_id', manual.id).eq('company_id', manual.company_id);
    const rows = chunks.map((chunk, i) => ({ company_id: manual.company_id, manual_id: manual.id, industry_key: industryKey, chunk_index: i, title: String(extracted.title || manual.title).slice(0, 250), source_url: extracted.sourceUrl || manual.source_url || null, page_number: chunk.pageNumber, page_start: chunk.pageStart, page_end: chunk.pageEnd, content_text: chunk.content, content_redacted: scrub(chunk.content).slice(0, 1200), embedding: embeddings[i] ? `[${embeddings[i].join(',')}]` : null, embedding_model: embeddings[i] ? embeddingModel : null, embedded_at: embeddings[i] ? new Date().toISOString() : null }));
    for (let i=0; i<rows.length; i+=20) { const { error: chunkError } = await db.from('company_manual_chunks').insert(rows.slice(i,i+20)); if (chunkError) throw new Error(`Could not index document chunks (${chunkError.code}).`); }
    const { error: updateError } = await db.from('company_manuals').update({ title: manual.title || extracted.title || 'Company document', industry_key: industryKey, manufacturer_normalized: equipmentTags.manufacturer, equipment_category: equipmentTags.category, extracted_char_count: raw.length, chunk_count: rows.length, extraction_status: 'ready', extraction_error: null, processed_at: new Date().toISOString() }).eq('id', manual.id);
    if (updateError) throw new Error('Document was extracted but its status could not be saved.');
    const queued = await queueManualForLearning({ ...manual, shared_learning_opt_in: Boolean(manual.shared_learning_opt_in) }, rows.map(r=>r.content_text));
    const metricKey = processingJobId ? `document-job:${processingJobId}` : `document:${manual.id}:${crypto.randomUUID()}`;
    const ocrInputTokens = Number(extracted.usage?.promptTokenCount || extracted.usage?.prompt_token_count || 0);
    const ocrOutputTokens = Number(extracted.usage?.candidatesTokenCount || extracted.usage?.candidates_token_count || 0);
    const ocrModel = extracted.model || null;
    const ocrCost = await estimateProviderCost(ocrModel, ocrInputTokens, ocrOutputTokens);
    await recordUsageOnce({ company_id: manual.company_id, user_id: manual.uploaded_by || null, event_type: 'document_extraction', units: 1, metric_type: 'document_characters', quantity: raw.length, quantity_unit: 'character', provider: extracted.usage ? 'google_gemini' : null, model: ocrModel, input_tokens: ocrInputTokens || null, output_tokens: ocrOutputTokens || null, estimated_cost_usd: ocrCost.estimatedCostUsd, cost_source: ocrCost.costSource, storage_bytes: Number(manual.file_size || 0), extracted_characters: raw.length, duration_ms: null, source_event_key: metricKey, period_start: utcMonthStartDate(), metadata: { manual_id: manual.id, queue_job_id: processingJobId, chunk_count: rows.length, embedded_chunks: embeddings.length, industry_key: industryKey, source_kind: manual.source_url ? 'webpage' : 'uploaded_file' } });
    if (embeddings.length) {
      // The embedding API does not return token usage in every response shape. Estimate
      // input tokens conservatively from UTF-8 text length, and label the estimate clearly.
      const estimatedEmbeddingInputTokens = chunks.reduce((total, item) => total + Math.max(1, Math.ceil(Buffer.byteLength(item.content, 'utf8') / 4)), 0);
      const embeddingCost = await estimateProviderCost(GEMINI_EMBEDDING_MODEL, estimatedEmbeddingInputTokens, 0);
      await recordUsageOnce({ company_id: manual.company_id, user_id: manual.uploaded_by || null, event_type: 'document_embedding', units: embeddings.length, metric_type: 'embedding_chunks', quantity: embeddings.length, quantity_unit: 'embedded_chunk', provider: 'google_gemini', model: GEMINI_EMBEDDING_MODEL, input_tokens: estimatedEmbeddingInputTokens, output_tokens: null, estimated_cost_usd: embeddingCost.estimatedCostUsd, cost_source: embeddingCost.estimatedCostUsd === null ? 'not_priced' : 'rate_card_estimate', source_event_key: `${metricKey}:embeddings`, period_start: utcMonthStartDate(), metadata: { manual_id: manual.id, queue_job_id: processingJobId, embedded_chunks: embeddings.length, dimension: EMBEDDING_DIMENSIONS, input_token_count_is_estimate: true } });
    }
    return { manualId: manual.id, status: 'ready', chunks: rows.length, embeddedChunks: embeddings.length, manufacturer: equipmentTags.manufacturer, equipmentCategory: equipmentTags.category, industryKey, extractedCharacters: raw.length, queuedForLearningReview: queued, referenceEnabled: manual.reference_enabled !== false, sharedLearningOptIn: Boolean(manual.shared_learning_opt_in) };
  } catch (error) {
    const message = String(error?.message || 'Document processing failed').slice(0,500);
    await db.from('company_manuals').update({ extraction_status: 'failed', extraction_error: message }).eq('id', manual.id);
    throw error;
  }
}
async function createWebManual(body) {
  const companyId = String(body.companyId || ''); const rawUrl = String(body.url || '').trim();
  if (!companyId || !rawUrl) throw new Error('companyId and webpage URL are required.');
  const safe = await safeUrl(rawUrl);
  const title = String(body.title || safe.url.hostname).slice(0,250);
  const { data: companyRow } = await db.from('companies').select('industry_key').eq('id', companyId).maybeSingle();
  const { data, error } = await db.from('company_manuals').insert({ company_id: companyId, industry_key: companyRow?.industry_key || 'pool', uploaded_by: body.userId || null, title, storage_path: `${companyId}/web-${crypto.randomUUID()}.html`, content_type: 'text/html', file_size: 0, document_type: body.documentType || 'other', source_url: safe.url.toString(), original_filename: safe.url.hostname, reference_enabled: true, shared_learning_opt_in: body.sharedLearningOptIn === true, learning_consent_updated_at: body.sharedLearningOptIn === true ? new Date().toISOString() : null, extraction_status: 'queued' }).select('*').single();
  if (error) throw new Error(`Could not register webpage (${error.code}).`);
  const { data: job, error: queueError } = await db.rpc('pooldocai_enqueue_document_job', { p_manual_id: data.id, p_requested_by: body.userId || null, p_force: false });
  if (queueError || !job) throw new Error('Webpage was registered but could not be queued for extraction.');
  return { manualId: data.id, status: 'queued', job, referenceEnabled: true, sharedLearningOptIn: Boolean(body.sharedLearningOptIn) };
}
async function finishWebhookDelivery(delivery, { success, status = null, errorCode = null, retryable = false }) {
  const { error } = await db.rpc('pooldocai_finish_service_request_webhook', {
    p_delivery_id: delivery.id,
    p_success: success,
    p_response_status: status,
    p_error_code: errorCode,
    p_retryable: retryable
  });
  if (error) console.error('Could not finalize service webhook delivery', { deliveryId: delivery.id, code: error.code });
}
async function processOneWebhookDelivery() {
  const { data, error } = await db.rpc('pooldocai_claim_service_request_webhook');
  if (error) {
    if (error.code !== 'PGRST202' && error.code !== '42883') console.error('Service webhook queue claim failed', { code: error.code });
    return false;
  }
  const delivery = Array.isArray(data) ? data[0] : data;
  if (!delivery) return false;
  try {
    const { data: config, error: configError } = await db.from('company_service_webhook_configs')
      .select('enabled,target_url,signing_secret').eq('company_id', delivery.company_id).maybeSingle();
    if (configError || !config || config.enabled !== true || !config.target_url || !config.signing_secret) {
      await finishWebhookDelivery(delivery, { success: false, errorCode: 'webhook_not_configured', retryable: false });
      return true;
    }
    const target = await safeUrl(config.target_url, { requireHttps: true });
    // Redirects are deliberately not followed for outbound callbacks.
    const payload = JSON.stringify({
      id: delivery.id,
      event: delivery.event_type,
      createdAt: delivery.created_at,
      idempotencyKey: delivery.idempotency_key,
      data: delivery.payload
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', config.signing_secret).update(`${timestamp}.${payload}`).digest('hex');
    const response = await requestPinnedUrl(target, {
      method: 'POST',
      timeoutMs: 10000,
      maxBytes: 16384,
      headers: {
        'content-type': 'application/json',
        'x-pooldocai-timestamp': timestamp,
        'x-pooldocai-signature': signature,
        'x-pooldocai-event': String(delivery.event_type || 'service_request.created'),
        'idempotency-key': String(delivery.idempotency_key)
      },
      body: payload
    });
    const status = response.statusCode;
    const success = status >= 200 && status < 300;
    const retryable = status === 408 || status === 425 || status === 429 || status >= 500;
    await finishWebhookDelivery(delivery, {
      success,
      status,
      errorCode: success ? null : `http_${status}`,
      retryable
    });
    return true;
  } catch (err) {
    const message = String(err?.message || '');
    const permanentlyBlocked = /private or restricted|must use HTTPS|localhost|\.local/i.test(message);
    console.warn('Service webhook delivery failed', {
      deliveryId: delivery.id,
      errorCode: permanentlyBlocked ? 'destination_blocked' : 'network_delivery_failed'
    });
    await finishWebhookDelivery(delivery, {
      success: false,
      errorCode: permanentlyBlocked ? 'destination_blocked' : 'network_delivery_failed',
      retryable: !permanentlyBlocked
    });
    return true;
  }
}
let webhookBusy = false;
async function pollWebhookQueue() {
  if (webhookBusy) return;
  webhookBusy = true;
  try {
    await processOneWebhookDelivery();
  } catch (err) {
    console.error('Service webhook polling failed', String(err?.message || 'unknown').slice(0, 160));
  } finally {
    webhookBusy = false;
  }
}
const server = http.createServer(async (req,res) => {
  if (req.method === 'GET' && req.url === '/health') {
    const now = new Date();
    const nowIso = now.toISOString();
    const integerMinutes = (key, fallback) => {
      const value = Number.parseInt(process.env[key] || '', 10);
      return Number.isFinite(value) ? Math.min(Math.max(value, 1), 1440) : fallback;
    };
    const queuedMinutes = integerMinutes('DOC_WORKER_QUEUED_ALERT_MINUTES', 15);
    const stuckMinutes = integerMinutes('DOC_WORKER_STUCK_ALERT_MINUTES', 30);
    const oldQueuedBefore = new Date(now.getTime() - queuedMinutes * 60_000).toISOString();
    const stuckBefore = new Date(now.getTime() - stuckMinutes * 60_000).toISOString();
    const failedSince = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
    try {
      const [queued, oldQueued, processing, stuckProcessing, recentFailed] = await Promise.all([
        db.from('document_processing_jobs').select('id', { count: 'exact', head: true }).eq('status', 'queued'),
        db.from('document_processing_jobs').select('id', { count: 'exact', head: true })
          .eq('status', 'queued').lt('created_at', oldQueuedBefore).lt('available_at', nowIso),
        db.from('document_processing_jobs').select('id', { count: 'exact', head: true }).eq('status', 'processing'),
        db.from('document_processing_jobs').select('id', { count: 'exact', head: true })
          .eq('status', 'processing').lt('updated_at', stuckBefore),
        db.from('document_processing_jobs').select('id', { count: 'exact', head: true })
          .eq('status', 'failed').gte('updated_at', failedSince)
      ]);
      const failedQuery = [queued, oldQueued, processing, stuckProcessing, recentFailed].find(result => result.error);
      if (failedQuery) {
        console.error('Document worker health query failed', { code: failedQuery.error.code });
        return json(res, 503, { ok: false, service: 'pooldocai-document-worker', database: 'unavailable', code: 'QUEUE_HEALTH_QUERY_FAILED' });
      }
      const queue = {
        queued: Number(queued.count || 0),
        oldQueued: Number(oldQueued.count || 0),
        processing: Number(processing.count || 0),
        stuckProcessing: Number(stuckProcessing.count || 0),
        failedLast24Hours: Number(recentFailed.count || 0)
      };
      const healthy = queue.oldQueued === 0 && queue.stuckProcessing === 0;
      return json(res, healthy ? 200 : 503, {
        ok: healthy,
        service: 'pooldocai-document-worker',
        database: 'ok',
        queue,
        thresholdsMinutes: { oldQueued: queuedMinutes, stuckProcessing: stuckMinutes },
        checkedAt: nowIso
      });
    } catch (error) {
      console.error('Document worker health check failed', { reason: String(error?.message || 'unknown').slice(0, 100) });
      return json(res, 503, { ok: false, service: 'pooldocai-document-worker', database: 'unavailable', code: 'QUEUE_HEALTH_CHECK_FAILED' });
    }
  }
  if (req.method !== 'POST' || req.url !== '/process') return json(res,404,{error:'Not found'});
  try {
    let body=''; for await (const part of req) { body += part; if (body.length > 100_000) throw new Error('Request too large.'); }
    if (REQUIRE_HMAC) {
      const timestamp = String(req.headers['x-pooldocai-timestamp'] || '');
      const signature = String(req.headers['x-pooldocai-signature'] || '');
      const seconds = Number(timestamp);
      if (!Number.isFinite(seconds) || Math.abs(Math.floor(Date.now()/1000)-seconds) > MAX_CLOCK_SKEW_SECONDS || !/^[a-f0-9]{64}$/i.test(signature)) return json(res,401,{error:'Unauthorized'});
      const expected = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
      if (!timingSafeEqual(Buffer.from(signature.toLowerCase(),'hex'), Buffer.from(expected,'hex'))) return json(res,401,{error:'Unauthorized'});
    } else if (req.headers['x-pooldocai-worker-secret'] !== SECRET) return json(res,401,{error:'Unauthorized'});
    const payload = JSON.parse(body || '{}');
    if (payload.action === 'create_webpage') return json(res,200,{ok:true,...await createWebManual(payload)});
    if (payload.action !== 'process_manual' || !payload.manualId) return json(res,400,{error:'action=process_manual and manualId are required.'});
    return json(res,200,{ok:true,...await processManual(String(payload.manualId))});
  } catch (error) { return json(res,400,{ok:false,error:String(error?.message || 'Processing failed').slice(0,500)}); }
});
let workerBusy = false;
async function pollQueue() {
  if (workerBusy) return;
  workerBusy = true;
  try {
    for (let i = 0; i < 2; i++) {
      const { data: jobs, error } = await db.rpc('pooldocai_claim_document_job');
      if (error) { console.error('Document queue claim failed', { code: error.code }); break; }
      const job = Array.isArray(jobs) ? jobs[0] : jobs;
      if (!job) break;
      try {
        await processManual(job.manual_id, job.id);
        const { error: finishError } = await db.rpc('pooldocai_finish_document_job', { p_job_id: job.id, p_success: true, p_error: null });
        if (finishError) console.error('Could not finalize document job', { jobId: job.id, code: finishError.code });
      } catch (err) {
        const message = String(err?.message || 'Document processing failed').slice(0, 500);
        console.error('Document job failed', { jobId: job.id, attempt: job.attempts, message });
        const { error: finishError } = await db.rpc('pooldocai_finish_document_job', { p_job_id: job.id, p_success: false, p_error: message });
        if (finishError) console.error('Could not record document job failure', { jobId: job.id, code: finishError.code });
      }
    }
  } catch (err) { console.error('Document queue polling failed', String(err?.message || 'unknown').slice(0, 250)); }
  finally { workerBusy = false; }
}
setInterval(() => { void pollQueue(); }, 2500);
void pollQueue();
setInterval(() => { void pollWebhookQueue(); }, 5000);
void pollWebhookQueue();
server.listen(PORT, '0.0.0.0', () => console.log(`PoolDocAI document worker listening on ${PORT}; durable document and service-webhook queues enabled`));
