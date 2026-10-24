const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');

console.log('--- TASK-003: LOGO CONCEPTS, DESIGN TOKENS, & OPTION C HYBRID REGRESSION SUITE ---');

// 1. Verify 3 Original Logo SVG Concepts
console.log('\n[Test 1] Verifying 3 Original Logo SVG Concepts (L1, L2, L3)...');
const logoFiles = [
  'website/assets/logos/logo-concept-l1.svg',
  'website/assets/logos/logo-concept-l2.svg',
  'website/assets/logos/logo-concept-l3.svg'
];

for (const rel of logoFiles) {
  const full = path.join(repoRoot, rel);
  assert.ok(fs.existsSync(full), `File ${rel} must exist`);
  const svg = fs.readFileSync(full, 'utf8');
  assert.match(svg, /<svg\b[^>]*viewBox="0 0 512 512"/, `${rel} must have 512x512 viewBox`);
  assert.match(svg, /<\/svg>/, `${rel} must be well-formed SVG`);
  assert.ok(svg.length > 500, `${rel} must have meaningful SVG graphics`);
  console.log(`  PASS: ${rel} verified as valid 512x512 vector graphic.`);
}

// 2. Verify Design Tokens CSS
console.log('\n[Test 2] Verifying Option C Design Tokens in website/css/design-tokens.css...');
const tokensPath = path.join(repoRoot, 'website/css/design-tokens.css');
assert.ok(fs.existsSync(tokensPath), 'design-tokens.css must exist');
const tokensCss = fs.readFileSync(tokensPath, 'utf8');

assert.match(tokensCss, /--pooldoc-tech-bg:\s*#030712;/, 'Tech dark background token must be defined');
assert.match(tokensCss, /--pooldoc-tech-surface:\s*#0b1329;/, 'Tech surface card token must be defined');
assert.match(tokensCss, /--pooldoc-market-bg:\s*#ffffff;/, 'Marketing light background token must be defined');
assert.match(tokensCss, /--pooldoc-min-touch-target:\s*44px;/, '44px touch target accessibility token must be defined');
assert.match(tokensCss, /input\[type="text"\][\s\S]*?font-size:\s*16px !important;/, 'Mobile input zoom prevention rule must be present');
console.log('  PASS: Semantic design tokens and mobile touch standards verified in design-tokens.css.');

// 3. Verify Design Review Board
console.log('\n[Test 3] Verifying Design Review Board in website/design-preview.html...');
const previewPath = path.join(repoRoot, 'website/design-preview.html');
assert.ok(fs.existsSync(previewPath), 'design-preview.html must exist');
const previewHtml = fs.readFileSync(previewPath, 'utf8');

assert.match(previewHtml, /Concept L1/, 'L1 must be featured on review board');
assert.match(previewHtml, /Concept L2/, 'L2 must be featured on review board');
assert.match(previewHtml, /Concept L3/, 'L3 must be featured on review board');
assert.match(previewHtml, /Multi-Scale Legibility Matrix/, 'Scale matrix table must be present');
assert.match(previewHtml, /Option C Design Token Architecture/, 'Design token specification must be present');
console.log('  PASS: Design preview board contains all 3 concepts, multi-scale matrix, and token architecture.');

// 4. Verify Canonical App Identity Preserved Pending Owner Selection
console.log('\n[Test 4] Verifying Canonical App Identity Preserved in Production Routes...');
const demoHtml = fs.readFileSync(path.join(repoRoot, 'website/demo.html'), 'utf8');
const indexHtml = fs.readFileSync(path.join(repoRoot, 'website/index.html'), 'utf8');

assert.match(demoHtml, /PoolDoc<span class="text-sky-600">AI<\/span>/, 'demo.html must preserve canonical styled logo');
assert.match(indexHtml, /PoolDoc<span class="text-sky-600">AI<\/span>/, 'index.html must preserve canonical styled logo');
assert.doesNotMatch(demoHtml, /logo-concept-l[123]\.svg/, 'demo.html must NOT replace canonical brand until owner selection');
assert.doesNotMatch(indexHtml, /logo-concept-l[123]\.svg/, 'index.html must NOT replace canonical brand until owner selection');
console.log('  PASS: Canonical app identity strictly preserved across public routes pending owner decision.');

// 5. Verify Mobile Touch Target Ergonomics
console.log('\n[Test 5] Verifying Mobile Touch Target Ergonomics (>=44x44px)...');
assert.match(demoHtml, /id="closeHomeownerWidgetBtn"[^>]*min-h-\[44px\]/, 'Widget close button must have min-h-[44px]');
assert.match(demoHtml, /demo-widget-starter-chip min-h-\[44px\]/, 'Widget starter chips must have min-h-[44px]');
assert.match(demoHtml, /demo-starter-chip min-h-\[44px\]/, 'Tech starter chips must have min-h-[44px]');

const appHtml = fs.readFileSync(path.join(repoRoot, 'website/app.html'), 'utf8');
assert.match(appHtml, /id="integratedNotesSave"[^>]*min-h-\[44px\]/, 'Field notes save button must have min-h-[44px]');
console.log('  PASS: Mobile touch targets comply with 44px ergonomic standards.');

console.log('\n====================================================================');
console.log('ALL TASK-003 DESIGN TOKENS & LOGO CONCEPT TESTS PASSED!');
console.log('====================================================================');
