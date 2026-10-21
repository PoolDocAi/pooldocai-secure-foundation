import http from 'node:http';
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
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) { const p = ip.split('.').map(Number); return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || p[0] >= 224; }
  if (net.isIPv6(ip)) { const s = ip.toLowerCase(); return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80:') || s.startsWith('::ffff:127.'); }
  return true;
}
async function safeUrl(raw) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('Only public http/https webpages are supported.');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (['localhost', 'localhost.localdomain'].includes(host) || host.endsWith('.local')) throw new Error('Private/local webpage addresses are blocked.');
  const records = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some(x => isPrivateAddress(x.address))) throw new Error('Webpage host resolves to a private or restricted address and was blocked.');
  return u;
}
async function fetchWebpage(raw) {
  let url = await safeUrl(raw);
  for (let hop = 0; hop <= 3; hop++) {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'PoolDocAI-DocumentFetcher/1.0' } });
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.get('location'); if (!location || hop === 3) throw new Error('Webpage redirect limit reached.');
      url = await safeUrl(new URL(location, url).toString()); continue;
    }
    if (!response.ok) throw new Error(`Webpage returned HTTP ${response.status}.`);
    const type = response.headers.get('content-type') || '';
    if (!type.includes('text/html') && !type.includes('text/plain') && !type.includes('application/xhtml+xml')) throw new Error('Webpage must return HTML or plain text.');
    const buf = Buffer.from(await response.arrayBuffer()); if (buf.length > MAX_BYTES) throw new Error('Webpage exceeds the 25 MB extraction limit.');
    if (type.includes('text/plain')) return { text: buf.toString('utf8'), title: url.hostname, sourceUrl: url.toString() };
    const $ = cheerio.load(buf.toString('utf8')); const title = $('title').first().text().trim() || url.hostname;
    $('script,style,noscript,svg,nav,footer,header,form,iframe,button').remove();
    const text = $('main').text() || $('article').text() || $('body').text();
    return { text: text.replace(/\s+/g, ' ').trim(), title, sourceUrl: url.toString() };
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
  const data = await response.json(); return (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('\n').trim();
}
async function extractFile(buffer, filename, contentType) {
  const ext = filename.toLowerCase().split('.').pop();
  if (['txt','md','csv','json','xml','log'].includes(ext) || contentType.startsWith('text/')) return { text: buffer.toString('utf8'), title: filename };
  if (ext === 'pdf' || contentType === 'application/pdf') {
    let text = '';
    try { const result = await pdfParse(buffer); text = result.text || ''; } catch { /* scanned PDF OCR fallback below */ }
    if (text.replace(/\s/g, '').length < 80) text = await geminiExtract(buffer, 'application/pdf', 'Extract all readable text from this PDF, preserving headings, tables, safety warnings, numbered procedures, model numbers, units, and page breaks when possible. Return extracted text only.');
    return { text, title: filename };
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
    const text = await geminiExtract(image, mime, 'Read and transcribe all visible text from this image. Preserve headings, model/serial labels, error codes, units, tables and safety warnings. If no text is visible, describe the equipment and visible labels briefly. Do not infer hidden text.');
    return { text, title: filename };
  }
  throw new Error('Unsupported file type. Upload JPEG, PNG, HEIC/HEIF, WebP, TIFF, BMP, GIF, PDF, DOC, DOCX, TXT, Markdown, CSV, JSON, XML, or HTML.');
}

function classifyEquipment(title, text) {
  const sample = `${title || ''} ${String(text || '').slice(0, 12000)}`.toLowerCase();
  const brands = [['pentair', /\bpentair\b/], ['hayward', /\bhayward\b/], ['jandy/fluidra', /\bjandy\b|\bfluidra\b/], ['raypak', /\braypak\b/]];
  const categories = [['heater', /\bheater\b|\bheat pump\b|\bignition lockout\b/], ['pump', /\bpump\b|\bpriming\b|\bvariable[- ]speed\b/], ['filter', /\bfilter\b|\bbackwash\b/], ['salt system', /\bsalt cell\b|\bsalt system\b|\baquarite\b/], ['automation', /\bautomation\b|\bcontroller\b/], ['cleaner', /\bpool cleaner\b|\brobotic cleaner\b/], ['water chemistry', /\balkalinity\b|\bcalcium hardness\b|\bchlorine\b|\bcya\b|\bsaturation index\b/]];
  return { manufacturer: brands.find(([,re])=>re.test(sample))?.[0] || null, category: categories.find(([,re])=>re.test(sample))?.[0] || null };
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
async function processManual(manualId) {
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
    const chunks = chunkText(raw);
    const equipmentTags = classifyEquipment(manual.title || extracted.title, raw);
    await db.from('company_manual_chunks').delete().eq('manual_id', manual.id).eq('company_id', manual.company_id);
    const rows = chunks.map((content, i) => ({ company_id: manual.company_id, manual_id: manual.id, chunk_index: i, title: String(extracted.title || manual.title).slice(0, 250), source_url: extracted.sourceUrl || manual.source_url || null, page_number: null, content_text: content, content_redacted: scrub(content).slice(0, 1200) }));
    for (let i=0; i<rows.length; i+=100) { const { error: chunkError } = await db.from('company_manual_chunks').insert(rows.slice(i,i+100)); if (chunkError) throw new Error(`Could not index document chunks (${chunkError.code}).`); }
    const { error: updateError } = await db.from('company_manuals').update({ title: manual.title || extracted.title || 'Company document', manufacturer_normalized: equipmentTags.manufacturer, equipment_category: equipmentTags.category, extracted_char_count: raw.length, chunk_count: rows.length, extraction_status: 'ready', extraction_error: null, processed_at: new Date().toISOString() }).eq('id', manual.id);
    if (updateError) throw new Error('Document was extracted but its status could not be saved.');
    const queued = await queueManualForLearning({ ...manual, shared_learning_opt_in: Boolean(manual.shared_learning_opt_in) }, rows.map(r=>r.content_text));
    return { manualId: manual.id, status: 'ready', chunks: rows.length, manufacturer: equipmentTags.manufacturer, equipmentCategory: equipmentTags.category, extractedCharacters: raw.length, queuedForLearningReview: queued, referenceEnabled: manual.reference_enabled !== false, sharedLearningOptIn: Boolean(manual.shared_learning_opt_in) };
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
  const title = String(body.title || safe.hostname).slice(0,250);
  const { data, error } = await db.from('company_manuals').insert({ company_id: companyId, uploaded_by: body.userId || null, title, storage_path: `${companyId}/web-${crypto.randomUUID()}.html`, content_type: 'text/html', file_size: 0, document_type: body.documentType || 'other', source_url: safe.toString(), original_filename: safe.hostname, reference_enabled: true, shared_learning_opt_in: body.sharedLearningOptIn === true, learning_consent_updated_at: body.sharedLearningOptIn === true ? new Date().toISOString() : null, extraction_status: 'queued' }).select('*').single();
  if (error) throw new Error(`Could not register webpage (${error.code}).`);
  const { data: job, error: queueError } = await db.rpc('pooldocai_enqueue_document_job', { p_manual_id: data.id, p_requested_by: body.userId || null, p_force: false });
  if (queueError || !job) throw new Error('Webpage was registered but could not be queued for extraction.');
  return { manualId: data.id, status: 'queued', job, referenceEnabled: true, sharedLearningOptIn: Boolean(body.sharedLearningOptIn) };
}
const server = http.createServer(async (req,res) => {
  if (req.method === 'GET' && req.url === '/health') return json(res,200,{ok:true,service:'pooldocai-document-worker'});
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
        await processManual(job.manual_id);
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
server.listen(PORT, '0.0.0.0', () => console.log(`PoolDocAI document worker listening on ${PORT}; durable queue polling enabled`));
