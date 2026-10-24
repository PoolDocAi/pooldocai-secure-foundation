const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const worker = fs.readFileSync(path.resolve(__dirname, '../src/server.js'), 'utf8');
function section(start, end) {
  const i = worker.indexOf(start);
  assert.notEqual(i, -1, `missing source anchor: ${start}`);
  const j = worker.indexOf(end, i + start.length);
  assert.notEqual(j, -1, `missing end anchor: ${end}`);
  return worker.slice(i, j);
}

const health = section("if (req.method === 'GET' && req.url === '/health') {", "if (req.method !== 'POST' || req.url !== '/process')");
assert.match(health, /document_processing_jobs/);
assert.match(health, /oldQueued/);
assert.match(health, /stuckProcessing/);
assert.match(health, /return json\(res, healthy \? 200 : 503/);
assert.match(health, /database: 'unavailable'/);
assert.doesNotMatch(health, /company_id|tenant_id|manual_id|filename|last_error/,
  'health response must not reveal tenant, customer or document details');

const addressCheck = section('function isPrivateAddress(ip)', 'async function safeUrl(');
assert.match(addressCheck, /100 && p\[1\] >= 64/);
assert.match(addressCheck, /firstGroup < 0x2000/);
assert.match(addressCheck, /secondGroup <= 0x01ff/);
assert.match(addressCheck, /secondGroup === 0x0db8/);
assert.match(addressCheck, /firstGroup === 0x2002/);
assert.match(addressCheck, /firstGroup === 0x3fff/);

const safeFetch = section('async function safeUrl(', 'async function geminiExtract(');
assert.match(safeFetch, /dns\.lookup\(host, \{ all: true, verbatim: true \}\)/);
assert.match(safeFetch, /records\.some\(record => isPrivateAddress\(record\.address\)\)/);
assert.match(safeFetch, /lookup:\s*\(_hostname, options, callback\)/);
assert.match(safeFetch, /requestPinnedUrl\(target/);
assert.doesNotMatch(section('async function fetchWebpage(', 'async function geminiExtract('), /\bfetch\s*\(/,
  'webpage fetch must connect to the validated IP, not resolve the hostname again');

const webhooks = section('async function finishWebhookDelivery(', 'const server = http.createServer(');
assert.match(webhooks, /pooldocai_claim_service_request_webhook/);
assert.match(webhooks, /pooldocai_finish_service_request_webhook/);
assert.match(webhooks, /safeUrl\(config\.target_url, \{ requireHttps: true \}\)/);
assert.match(webhooks, /x-pooldocai-signature/);
assert.match(webhooks, /requestPinnedUrl\(target/);
assert.match(webhooks, /retryable:\s*!permanentlyBlocked/);
assert.match(worker, /setInterval\(\(\) => \{ void pollWebhookQueue\(\); \}, 5000\)/);

assert.ok(
  worker.includes(".lte('valid_from', rateLookupTime)") &&
  worker.includes(".or(`valid_to.is.null,valid_to.gt.${rateLookupTime}`)"),
  'document-worker token-cost estimates must select the rate effective at the time of use'
);

assert.match(
  worker,
  /storagePath\.startsWith\(expectedPrefix\)/,
  'storage path must be strictly scoped to the manual owning company prefix'
);
assert.match(
  worker,
  /storagePath\.includes\('\.\.'\)/,
  'storage path must reject directory traversal'
);

// --- PART-5 MODEL METADATA EXTRACTION & PERSISTENCE CHECKS ---
assert.ok(
  worker.includes('function extractModel(title, text, brand, category)'),
  'document-worker must implement model extraction'
);
assert.ok(
  worker.includes('model_normalized: manual.model_normalized || equipmentTags.model'),
  'processManual must persist model_normalized to company_manuals'
);
assert.ok(
  worker.includes('model_normalized: manual.model_normalized || null'),
  'queueManualForLearning must persist model_normalized to diagnostic_cases'
);

// Verify extractModel and classifyEquipment behavior directly using eval
const extractModelSection = section('function extractModel(', 'async function queueManualForLearning(');
const evalCode = extractModelSection + '\nreturn { classifyEquipment, extractModel };';
const { classifyEquipment, extractModel } = (new Function(evalCode))();

// Test A: Pentair IntelliFlo VSF
const pentairClass = classifyEquipment('Pentair IntelliFlo VSF Installation Guide', 'Variable speed and flow pump operation manual.');
assert.equal(pentairClass.manufacturer, 'pentair');
assert.equal(pentairClass.category, 'pump');
assert.equal(pentairClass.model, 'intelliflo_vsf');

// Test B: Hayward Universal H-Series
const haywardClass = classifyEquipment('Hayward Universal H-Series Gas Heater', 'Universal H-Series H400FDN pool heater service manual.');
assert.equal(haywardClass.manufacturer, 'hayward');
assert.equal(haywardClass.category, 'heater');
assert.equal(haywardClass.model, 'h_series');

// Test C: Jandy JXi Heater
const jandyClass = classifyEquipment('Jandy JXi Pool & Spa Heater', 'JXi 400 natural gas ignition lockout troubleshooting.');
assert.equal(jandyClass.manufacturer, 'jandy/fluidra');
assert.equal(jandyClass.category, 'heater');
assert.equal(jandyClass.model, 'jxi');

// Test D: Alphanumeric Nameplate Model
const nameplateClass = classifyEquipment('Commercial Filter Manual', 'Model: HP-2000-X high rate sand filter.');
assert.equal(nameplateClass.category, 'filter');
assert.equal(nameplateClass.model, 'hp-2000-x');

console.log('Worker model extraction and nameplate normalization checks passed.');
console.log('Worker outbound-network and signed-webhook boundary checks passed.');
