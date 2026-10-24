// Executable regression tests for knowledge-first economics and grounding safety.
// Run: node website/tests/knowledge-first-routing.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'supabase/functions/clever-handler/index.ts'), 'utf8');
const spec = fs.readFileSync(path.join(root, 'docs/approved-pricing-and-entitlements-2026-10-24.md'), 'utf8');

// Exercise exactly the production routing helpers, stripping only TS types for Node vm.
// This guards make/model equality and Search suppression without running a live API.
const begin = source.indexOf('function normalizedEquipmentReference(');
const end = source.indexOf('function boundedPositiveLimit(', begin);
assert.ok(begin > 0 && end > begin, 'knowledge routing helpers must exist in the Edge handler');
const helperSource = source.slice(begin, end)
  .replace('(value: unknown)', '(value)')
  .replace('(row: AnyRecord, brand: string, model: string)', '(row, brand, model)')
  .replace('(rows: AnyRecord[], brand: string, model: string)', '(rows, brand, model)')
  .replace(/\): string \{/g, ') {')
  .replace(/\): boolean \{/g, ') {');
const context = {
  getProcedureText: row => String(row.procedure_text ?? row.content_text ?? ''),
};
vm.createContext(context);
vm.runInContext(helperSource, context);
const eligible = context.preferVerifiedInternalOnly;
const matches = context.referenceMatchesEquipment;
assert.equal(typeof eligible, 'function');
assert.equal(typeof matches, 'function');
const lesson = {
  shared_learning_source: true, brand: 'Pentair', model_family: 'IntelliFlo VSF',
  procedure_text: 'Verified technician outcome for the exact model, reviewed with supporting manufacturer evidence. '.repeat(3),
};
assert.equal(eligible([lesson], 'PENTAIR', 'Intelliflo VSF'), true,
  'confirmed exact approved lesson should avoid first-pass paid search');
assert.equal(eligible([lesson], 'Hayward', 'Intelliflo VSF'), false,
  'brand mismatch must retain search');
assert.equal(eligible([lesson], 'Pentair', 'IntelliFlo VS'), false,
  'model family substring must not silently match a different model');
assert.equal(eligible([lesson], 'Pentair', ''), false,
  'unknown model must not suppress source research');
assert.equal(eligible([lesson], '', 'IntelliFlo VSF'), false,
  'unknown make must not suppress source research');
assert.equal(eligible([{ ...lesson, shared_learning_source: false }], 'Pentair', 'IntelliFlo VSF'), false,
  'unapproved cases cannot suppress search');
assert.equal(eligible([{ ...lesson, procedure_text: 'Short guess' }], 'Pentair', 'IntelliFlo VSF'), false,
  'low-information lesson cannot suppress search');
assert.equal(eligible([{ ...lesson, model_family: 'Another pump' }], 'Pentair', 'IntelliFlo VSF'), false,
  'irrelevant approved lesson cannot suppress search');
assert.equal(matches({ brand: 'Raypak', model_family: '406A' }, 'Pentair', 'IntelliFlo VSF'), false);
assert.equal(matches({ brand: 'Pentair', model_family: 'IntelliFlo VSF' }, 'Pentair', 'IntelliFlo VSF'), true);
assert.equal(matches({ brand: 'Pentair', model_family: 'VS' }, 'Pentair', 'VSF'), false);
assert.equal(matches({ brand: '', model_family: '' }, 'Pentair', 'VSF'), true,
  'metadata-only generic results remain available for clarification, not Search avoidance');

// Verify full handler wiring and fail-closed fallback have not been bypassed.
assert.match(source, /kbRows = kbRows\.filter\(\(row\) => referenceMatchesEquipment\(row, brand, model\)\)/);
assert.match(source, /const firstPassInternalOnly = preferVerifiedInternalOnly\(kbRows, brand, model\)/);
assert.match(source, /if \(!firstPassInternalOnly\) \{\s*groundingReservationId = await reserveGroundingBudget/);
assert.match(source, /tools: firstPassInternalOnly \? \[\] : \[\{ type: "google_search" \}\]/);
assert.match(source, /const shouldRunFallbackSearch = needsSourceGroundedAnswer/);
assert.match(source, /tools: \[\{ type: "google_search" \}\]/);
assert.match(source, /if \(needsSourceGroundedAnswer && !sourceVerifiedAnswer\)/);
assert.match(source, /event_type: "diagnostic_source_route"/);
assert.match(source, /final_source: sourceMode/);
assert.doesNotMatch(source, /technician_verified: true,\s*approved_for_learning: false,\s*client_job_id/,
  'saving an unresolved job must not falsely attest a successful technician repair');
assert.match(source, /source_ids: \[data\.id\], technician_verified: row\.technician_verified/,
  'the diagnostic learning record inherits genuine job outcome status');
assert.match(source, /caseRow\?\.case_learning_opt_in === true/,
  'case-level consent must remain mandatory for authenticated shared learning');
assert.match(source, /pooldocai_approve_learning_case/,
  'shared lesson approval remains platform controlled and transactional');
assert.match(source, /if \(row\.technician_verified\) \{/,
  'unresolved and unverified field jobs stay outside the shared review queue');
assert.match(source, /code: "VERIFIED_REPAIR_REQUIRED"/,
  'unresolved technician lessons cannot pass shared-knowledge approval');
assert.match(source, /caseRow\?\.technician_verified !== true/,
  'the review endpoint rechecks a confirmed technician repair before approval');

assert.match(spec, /\$39 \| 1 \| 50/);
assert.match(spec, /\$75 \| 2 \| 150/);
assert.match(spec, /\+25/);
assert.ok(spec.includes('+$19 per added active seat per month'));
assert.match(spec, /subscription prices are not automatically reduced as internal diagnostic costs fall/i);
console.log('PASS: verified exact-source, web-fallback, consent, telemetry, and retained-pricing invariants.');
