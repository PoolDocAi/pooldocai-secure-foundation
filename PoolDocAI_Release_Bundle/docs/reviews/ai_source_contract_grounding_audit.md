# POOLDOCAI TASK-011 PART-1: AUDIT OF AI SOURCE CONTRACT, SCHEMA DISCREPANCY & GROUNDING VERIFICATION

**Date:** October 25, 2026  
**Module:** `supabase/functions/clever-handler/index.ts`  
**Related Issues:** Issue #15, Issue #16 (P0 Launch Gate: Critical AI source contract), PR #14  
**Author:** Antigravity (Sole Core Executor)  
**Status:** COMPLETE & RECONCILED  

---

## 1. Executive Summary & Historical Discrepancy

In accordance with owner binding directives in Issue #16 and TASK-011 Part-1, this audit documents the architectural discrepancy between Gemini structured response generation and downstream citation verification in the production Edge Function `supabase/functions/clever-handler/index.ts`.

### The Historical Discrepancy
Historically:
1. **Model Generation Schema (`DIAGNOSTIC_RESPONSE_FORMAT`)**: Earlier iterations of the structured response format defined fields such as `step_instructions` (or `message` for water quality plans), but omitted `source_id`, `source_title`, `page_number`, or `revision` from the declared schema properties and required fields.
2. **Downstream Verifier Logic (`verifyInternalCitation`)**: The downstream verifier expected fields `structured.step`, `source_id`, and `source_title`. Because Gemini conformed strictly to the declared schema emitting `step_instructions` (and omitting `step` and `source_id`), the verifier evaluated `instructionText` as empty or failed the cited source lookup (`citedSourceId = ""`).
3. **Consequence**: Every single internal manual candidate failed citation verification (`verified: false`), even when Supabase hybrid search retrieved 100% authoritative manufacturer manuals. This forced the system into expensive, high-latency Google Search grounding fallbacks (`shouldRunFallbackSearch = true`) on every turn, or failed closed into generic degraded mode.

---

## 2. Code Paths & Line-by-Line Schema-Verifier Mapping

In `supabase/functions/clever-handler/index.ts`:

### A. Gemini Generation Schema Declaration
- **File Path:** `supabase/functions/clever-handler/index.ts`
- **Lines:** 433–458 (`const DIAGNOSTIC_RESPONSE_FORMAT`)
- **Exact Schema Properties:**
  - `response_type`: Enum `["triage", "step", "model_selection", "escalate", "water_quality_plan"]`
  - `message`: Used for `water_quality_plan` complete treatment guidance.
  - `step_title`: Short title for the single next step.
  - `step_instructions`: Exactly one diagnostic action or observation.
  - `safety_warning`: Essential warning for that action.
  - `follow_up_question`: Focused inquiry on action outcome.
  - `choices`: Array of auto-reply objects (`label`, `prompt`, `action`).
  - `model_suggestions`: Candidates for model identification.
  - `source_label`: Enum `["internal_manual", "manufacturer_web", "generic_triage", "catalog"]`
  - `source_id`: String (UUID or Evidence ID of retrieved KB match chunk).
  - `source_title`: Title of cited internal document or lesson.
  - `page_number`: Exact page number or section reference.
  - `revision`: Revision code of cited manual (e.g., `"Rev P"`).
  - `requires_technician`: Boolean flag.
- **Required Fields:** `["response_type", "message", "step_title", "step_instructions", "safety_warning", "follow_up_question", "choices", "model_suggestions", "source_label", "source_id", "source_title", "page_number", "requires_technician"]`

### B. Response Parser & Renderers
- **Lines 280–302 (`type StructuredDiagnostic`)**: Reconciled TypeScript definition accommodating `step_instructions` (modern schema) alongside `step` (legacy fallback), plus camelCase/snake_case aliases (`source_id` / `sourceId`, `page_number` / `pageNumber`, `revision` / `sourceRevision`).
- **Lines 304–314 (`parseStructuredDiagnostic`)**: Strips markdown code-fences and parses JSON into `StructuredDiagnostic`.
- **Lines 412–431 (`renderStructuredDiagnostic`)**: Formats structured output for user display using `data.step_instructions` for steps and `data.message` for water quality plans.

### C. Downstream Citation Verifier
- **Lines 1351–1510 (`verifyInternalCitation`)**:
  - **Instruction Text Extraction (Lines 1373–1376)**: Reads `structured.step_instructions` with legacy fallback to `structured.step`.
  - **Emergency Hazard Stop (Line 1384)**: Evaluates `isCriticalPoolHazardText(instructionText)`. Critical hazards cannot be verified as diagnostic steps.
  - **Conjunction Check 1 — Mandatory Server-Confirmed Cited Source ID (Lines 1386–1393)**: Non-empty `source_id` matching `row.id === citedSourceId`. Matches active status, publication status, and technician verification.
  - **Conjunction Check 2 — Equipment Make, Model, Page & Revision (Lines 1410–1470)**:
    - Make & Model: `desiredBrand === rowBrand` and `desiredModel === rowModel`.
    - Page: `citedPage` must fall within `[page_start, page_end]` or match `page_number`. Non-numeric or out-of-range pages fail verification.
    - Revision: `citedRevision && rowRevision && citedRevision !== rowRevision` fails.
  - **Conjunction Check 3 — Substantive Procedure Text & Symptom Match (Lines 1475–1485)**: Length >= 80 chars, symptom matches procedure context.
  - **Conjunction Check 4 — Quantitative Chemical Dosing Guards (Lines 1487–1492)**: Rejects invented chemical quantities absent from source.
  - **Conjunction Check 5 — Action-Target Corroboration (`hasSubstantiveProcedureEvidence`) (Lines 1494–1506)**: Clause-level verb-object corroboration. Prevents source title/ID laundering of arbitrary or dangerous repair instructions.

### D. User-Visible Citation Binding
- **Lines 3845–3870**: When `internalCitation.verified === true`, `manualSources` is strictly bound to `internalCitation.matchedRow`, ensuring the user-visible citation displays only the exact verified manual chunk, page, and revision.
- **Lines 3915–3930**: When forced Google Search fallback succeeds, `manualSources = [];` is explicitly set, preventing unverified internal chunks from being laundered onto web-grounded responses.
- **Lines 3960–3975**: When neither source verifies, both `manualSources = [];` and `webSources = [];` are cleared, and the system fails closed into explicit uncertainty with technician recommendation.

---

## 3. Homeowner Safe-First vs Technician Diagnostic Boundaries

1. **'Pump Won't Start' Non-Hazard Classification**:
   - Ordinary non-starting pump reports (`"pump won't start"`, `"pump silent"`, `"display dark"`) do NOT trigger an emergency safety stop (`criticalHazard === false`).
   - True hazards (`gas leaks`, `sparks`, `smoke`, `fire`, `electrical shock`, `suction entrapment`) trigger an immediate non-bypassable safety stop (`criticalHazard === true`, `status: "emergency_stop"`).
2. **Mode-Specific First Step**:
   - **Homeowner Mode**: First step must be non-invasive observation (power switches, indicator lights, timer, silent vs humming). No instructions directing homeowners to open electrical panels, touch live wires, or disassemble motors.
   - **Technician Mode**: Allows professional electrical multimeter measurements and component inspection per manufacturer SOP.

---

## 4. Verification & Regression Coverage

The reconciled contract is verified by:
1. `website/tests/task011-part1-ai-source-contract.test.cjs`: Comprehensive specification suite (7 test suites, 100% passing).
2. `website/tests/task005-part3-grounding-and-consent.test.cjs`: Multi-tenant grounding & consent lifecycle suite (7 test suites, 100% passing).
3. `website/tests/task010-part1-form-routing.test.cjs`: Form routing & non-dispatch UI flow suite (6 tests, 100% passing).
4. Full TypeScript bundling via `esbuild`: clean 300.6kb ESM output without warnings or type errors.
