const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');

console.log('--- TASK-003: OWNER-APPROVED MICROCOPY & FULL EXPERIENCE INTEGRATION SUITE ---');

// 1. Authenticated Technician Login & Canonical Branding
console.log('\n[Test 1] Verifying Authenticated Tech Login & Canonical Branding...');
const appHtml = fs.readFileSync(path.join(repoRoot, 'website/app.html'), 'utf8');
assert.match(appHtml, /<h1 id="secureLoginTitle">Sign in to PoolDocAI Tech<\/h1>/, 'app.html must use "Sign in to PoolDocAI Tech"');
assert.match(appHtml, /PoolDocAI · Company Workspace/, 'app.html must use canonical casing for company workspace');
assert.match(appHtml, /<button type="submit" id="secureLoginSubmit">Sign in to PoolDocAI Tech<\/button>/, 'Login submit button must read "Sign in to PoolDocAI Tech"');
assert.doesNotMatch(appHtml, /POOLDOC AI · COMPANY WORKSPACE/, 'app.html must not use all-caps POOLDOC AI heading');
assert.doesNotMatch(appHtml, /Sign in to the full troubleshooter/, 'app.html must not use generic "full troubleshooter" heading');

const lrHtml = fs.readFileSync(path.join(repoRoot, 'website/learning-review.html'), 'utf8');
assert.match(lrHtml, /PoolDocAI · Platform Owner Only/, 'learning-review.html must use canonical casing');
console.log('  PASS: Authenticated login and brand headings use canonical PoolDocAI casing and role-specific titles.');

// 2. Technician Message Submission ("Send")
console.log('\n[Test 2] Verifying Message Submission Button ("Send")...');
['website/app.html', 'website/demo.html', 'website/index.html'].forEach(rel => {
  const content = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  assert.match(content, /id="liveDemoSendBtn"[^>]*aria-label="Send message"[^>]*>[\s\S]*?Send &rarr;/, `${rel} send button must have "Send" label and accessible name`);
  assert.match(content, /sendBtn\.textContent = 'Send →';/, `${rel} dynamic reset must set "Send →"`);
  assert.doesNotMatch(content, />Ask PoolDoc &rarr;</, `${rel} must not contain "Ask PoolDoc &rarr;" button text`);
});
console.log('  PASS: Message submission button uses concise "Send" label across all workbench pages.');

// 3. Equipment Identification Progress Text
console.log('\n[Test 3] Verifying Equipment Identification Progress Text...');
['website/app.html', 'website/demo.html', 'website/index.html'].forEach(rel => {
  const content = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  assert.match(content, /status:\s*'Identifying your equipment'/, `${rel} must display "Identifying your equipment"`);
  assert.match(content, /status:\s*'Identifying equipment brand'/, `${rel} must display "Identifying equipment brand"`);
  assert.match(content, /status:\s*'Identifying exact model'/, `${rel} must display "Identifying exact model"`);
  assert.doesNotMatch(content, /status:\s*'Triaging Model'/, `${rel} must not use "Triaging Model" in visible status`);
});
console.log('  PASS: Equipment identification uses direct, professional progress text.');

// 4. Technician Diagnostic Summary vs Job Notes
console.log('\n[Test 4] Verifying Technician Diagnostic Summary & Job Notes...');
['website/app.html', 'website/demo.html', 'website/index.html'].forEach(rel => {
  const content = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  assert.match(content, /📋 Diagnostic Summary/, `${rel} technician workbench must show "Diagnostic Summary"`);
  assert.match(content, /Diagnostic Summary:.*Equipment checks completed in this session are summarized/, `${rel} must describe diagnostic summary for field record`);
  assert.doesNotMatch(content, /📋 Pre-Job Summary Preview/, `${rel} technician surface must not show "Pre-Job Summary Preview"`);
  assert.doesNotMatch(content, /parts\/chemical list for your technician/, `${rel} must not contain consumer dispatch pitch on tech surface`);
});
console.log('  PASS: Tech workbench provides Diagnostic Summary and Job Notes without dispatch pitches.');

// 5. Calm Hazard-Specific Safety Communication
console.log('\n[Test 5] Verifying Calm Hazard-Specific Safety Notices...');
['website/app.html', 'website/demo.html', 'website/index.html'].forEach(rel => {
  const content = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  assert.match(content, /Gas Safety Notice/, `${rel} must support Gas Safety Notice`);
  assert.match(content, /Electrical Safety Notice/, `${rel} must support Electrical Safety Notice`);
  assert.match(content, /Pressure Safety Notice/, `${rel} must support Pressure Safety Notice`);
  assert.doesNotMatch(content, /<strong>Homeowner safety hold:<\/strong>/, `${rel} must not use robotic "Homeowner safety hold" header`);
});
console.log('  PASS: Homeowner safety communications provide calm, hazard-specific guidance.');

// 6. Compact Service Summary Option & Preserved Emergency Stops
console.log('\n[Test 6] Verifying Compact Service Summary Option & Non-Bypassable Emergency Stops...');
['website/app.html', 'website/demo.html', 'website/index.html'].forEach(rel => {
  const content = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  assert.match(content, /Get Help From a Pool Professional/, `${rel} must offer professional help in non-emergency timeout`);
  assert.match(content, /data-followup-label="Prepare a service summary"/, `${rel} must provide "Prepare a service summary" option`);
  assert.match(content, /min-h-\[44px\]/, `${rel} action button must comply with 44px touch target`);
  // Critical non-bypassable safety stop strictly preserved
  assert.match(content, /Non-bypassable safety stop:/, `${rel} must strictly preserve non-bypassable emergency safety stops`);
  assert.match(content, /SAFETY STOP — NO OVERRIDE/, `${rel} must strictly preserve SAFETY STOP — NO OVERRIDE banner`);
});
console.log('  PASS: Compact service summary option implemented and emergency stops strictly preserved.');

// 7. Design Tokens Adoption & Review Board Single Source of Truth
console.log('\n[Test 7] Verifying Design Tokens Adoption & Review Board...');
['website/admin.html', 'website/technician.html', 'website/design-preview.html', 'website/app.html', 'website/demo.html', 'website/index.html'].forEach(rel => {
  const content = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  assert.match(content, /<link rel="stylesheet" href="(?:css\/|\/css\/)design-tokens\.css" \/>/, `${rel} must link design-tokens.css`);
});

const vercelConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'vercel.json'), 'utf8'));
const previewHeader = vercelConfig.headers.find(h => h.source === '/design-preview(.*)');
assert.ok(previewHeader, 'vercel.json must protect /design-preview(.*)');
assert.ok(previewHeader.headers.some(h => h.key === 'X-Robots-Tag' && h.value.includes('noindex')), 'review board must have noindex header');
console.log('  PASS: Design tokens imported across all admin/tech/preview routes and review board isolated.');

// 8. Hero Value Hierarchy (Tech-First Reorganization)
console.log('\n[Test 8] Verifying Tech-First Hero Hierarchy...');
['website/app.html', 'website/demo.html', 'website/index.html'].forEach(rel => {
  const content = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  const techIndex = content.indexOf('Field Technician Diagnostic Copilot');
  const widgetIndex = content.indexOf('Homeowner Intake &amp; Website Widget');
  assert.ok(techIndex !== -1, `${rel} must feature Field Technician Diagnostic Copilot in hero`);
  assert.ok(widgetIndex !== -1, `${rel} must feature Homeowner Intake & Website Widget in hero`);
  assert.ok(techIndex < widgetIndex, `${rel} must lead with Field Technician Diagnostic Copilot before Homeowner Widget`);
});
console.log('  PASS: Homepage hero reflects Tech-First value and availability hierarchy.');


 // 9. Validate the hero card opener structure across shared HTML routes.
 console.log('\n[Test 9] Verifying Hero Card DOM Structure Across Routes...');
 const heroCardOpen = '<div class="p-3.5 rounded-xl bg-slate-950/90 border border-slate-800 space-y-1.5">';
 for (const page of ['index.html','demo.html','how-it-works.html','pricing.html','faq.html','waitlist.html','app.html']) {
   const html = fs.readFileSync(path.join(repoRoot, 'website', page), 'utf8');
   const heroLines = html.split(/\r?\n/);
   for (let i = 1; i < heroLines.length; i++) {
     assert.ok(!(heroLines[i].trim() === heroCardOpen && heroLines[i-1].trim() === heroCardOpen),
       page + ': duplicate consecutive hero-card opening elements create malformed nested layout');
   }
 }
 console.log('  PASS: Shared hero markup has no consecutive duplicate card openings.');

console.log('\n====================================================================');
console.log('ALL TASK-003 OWNER COPY & FULL EXPERIENCE TESTS PASSED!');
console.log('====================================================================');
