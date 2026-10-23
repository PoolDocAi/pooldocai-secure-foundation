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

console.log('Worker outbound-network and signed-webhook boundary checks passed.');
