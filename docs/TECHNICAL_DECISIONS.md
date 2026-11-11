# Technical Decisions (ADR log)

Each entry: context → decision → consequences. Decisions marked **D** are deliberate deviations
from the PRD's *suggested* stack; the PRD's functional requirements are still honoured.

---

## ADR-001 (D) — Document pipeline implemented in TypeScript, not Python

**Context.** PRD §9 suggests Python + `python-docx`, `PyMuPDF`, `openpyxl`, `python-pptx`.
MASTER_PROMPT §1/§5 requires deterministic, fidelity-preserving DOCX assembly, and §9 of the
master prompt forbids letting an LLM write raw DOCX internals.

**Decision.** Implement template parsing, source extraction, DOCX assembly and orchestration in
TypeScript inside `apps/api` + `packages/docx-engine`. ZIP handling via `fflate`, XML via
`fast-xml-parser` (preserveOrder mode), PDF text via `pdfjs-dist`, DOCX→HTML via `mammoth`.

**Why.** (1) Byte-level control of `word/document.xml` is required anyway; `python-docx`
re-serialises parts and can drop unknown elements — the exact failure mode the PRD forbids.
(2) One runtime ⇒ one Docker base image, one dependency auditor, one CI matrix, and the
generation code (which needs the DB and generated HTTP calls) does not cross a process boundary.
(3) OCR stays an *optional external* capability (Tesseract CLI or an HTTP OCR provider), which
matches FR-04's "OCR requires OCR capability" wording.

**Consequences / limits.** No Python-native spreadsheet/PPTX extraction in MVP (PRD marks
XLSX/CSV/PPTX/JPG/PNG as *extensible, later increments*). OCR requires a configured binary or
endpoint; text-based PDFs work out of the box. When XLSX/PPTX support is added, a small Node
adapter (`exceljs`, `jszip` + XML) keeps the single-runtime property.

---

## ADR-002 — PostgreSQL + Drizzle ORM, no Supabase dependency

**Context.** FR-01 says "if Supabase is used, implement RLS". The project must be self-hostable
with a modest budget and must be testable locally.

**Decision.** Plain PostgreSQL 16, Drizzle ORM with checked-in SQL migrations
(`apps/api/drizzle`). Sessions are first-party (server-side session table, HttpOnly cookie).
Supabase is supported as a *hosting option* (it provides Postgres), not as a required SDK.

**Consequences.** No vendor lock-in; auth code is ours to audit; RLS is not the primary control,
so every service query carries an explicit `user_id` predicate and cross-tenant tests are part of
CI. Documented in `SECURITY_THREAT_MODEL.md` (T-02). Optional RLS policies are shipped as a
defence-in-depth migration for operators who expose the DB.

---

## ADR-003 — Session cookies instead of JWT

**Decision.** Opaque 256-bit session tokens; SHA-256 hash at rest; `HttpOnly`, `SameSite=Lax`,
`Secure` (when `COOKIE_SECURE`), 30-day sliding expiry with renewal at >50% age.

**Why.** Immediate revocability (logout, delete account), no key management for the browser, no
token in JS-readable storage (FR-12 forbids credentials in web storage; the same hygiene applies
to session material).

---

## ADR-004 — DB-backed job queue (no Redis in MVP)

**Decision.** `processing_jobs` table + in-process worker loop with `FOR UPDATE SKIP LOCKED`,
`attempts`, `max_attempts`, exponential backoff, and boot-time recovery.

**Why.** The PRD allows "a documented database-backed alternative". This removes a required
service from Docker Compose and keeps job state transactionally consistent with document state.

**Consequences.** Throughput is bounded by one worker loop per API instance; horizontal scaling
is safe (SKIP LOCKED) but requires raising `WORKER_CONCURRENCY`. Redis/BullMQ can be added behind
the same `JobQueue` interface if needed.

---

## ADR-005 — AES-256-GCM envelope per credential with AAD binding

**Decision.** `CREDENTIAL_ENCRYPTION_KEY` (32 bytes, base64/hex) from env. Each credential row
stores `{ iv, tag, ciphertext, keyVersion }`, AAD = `userId|credentialId`. No plaintext is ever
returned by the API; responses expose `keyLast4` and a SHA-256 fingerprint prefix.

**Why.** FR-12 / MASTER_PROMPT §4. AAD binding prevents an attacker with DB write access from
moving ciphertext between users. `keyVersion` enables rotation (re-encrypt on read is *not*
automatic: rotation is documented, and `scripts/rotate-credential-key.ts` performs it).

---

## ADR-006 — Structured output per provider, with a strict validation gate

**Decision.** Each adapter returns text; the *caller* parses and validates with Zod. Structured
mode uses `response_format: json_schema` (OpenAI-compatible), tool-use (Anthropic), or
`responseMimeType` + `responseSchema` (Gemini), but a validation failure is never silently
accepted: up to `AI_STRUCTURED_REPAIR_ATTEMPTS` repair attempts with the validation error fed
back, then the job fails with an actionable error.

**Why.** Provider "JSON mode" guarantees vary; FR-08 requires validating structured model output
before saving.

---

## ADR-007 — Evidence mapping is hybrid (lexical retrieval + AI refinement)

**Decision.** Section→evidence retrieval first runs deterministic BM25-ish scoring over chunks
(vocabulary overlap with heading text, section purpose, and user instructions), takes top-k, then
optionally an AI step re-ranks and writes `section_purpose`, `content_plan`, and per-fact
relevance. Without an AI provider configured, the lexical result is kept and the UI explicitly
says "mapping produced without AI".

**Why.** FR-06 requires mapping for every section, and the app must be usable up to the
generation step before a provider is configured (and be testable in CI without network). It also
bounds context/cost per section (FR-08).

---

## ADR-008 — Facts are extracted with provenance-first heuristics, then AI enrichment

**Decision.** Every extracted chunk stores document, page/sheet/slide, char offsets and a short
context window. "Fact candidates" are sentence-level units with a detected category
(date, number/measure, name/organisation, money, percent, quantity) plus deterministic
conflict detection: same normalised subject key with differing values ⇒ **conflict record**, never
auto-resolved. AI enrichment may add `subject/predicate/value` but must reference an existing
`chunk_id`; unknown chunk ids are dropped.

**Why.** FR-05 requires location metadata and conflict detection; FR-07/"never fabricate"
requires that the AI cannot introduce evidence. Dropping unknown references is enforced in code.

---

## ADR-009 — DOCX assembly via placeholder + anchor insertion, never full rebuild

**Decision.** Two supported insertion strategies per section, chosen during outline review:
1. `placeholder` — replace `{{section_key}}` tokens (or user-picked placeholder text) inside
   existing runs, preserving the run's formatting.
2. `after_heading` — insert new paragraphs immediately after the section's heading paragraph,
   cloning that paragraph's `w:pPr` (style, numbering, spacing) and the first run's `w:rPr`.

Tables in the template are filled through `{{key}}` placeholders in cells; new rows are *not*
created in MVP (documented limitation) unless the user supplies a repeated-rows placeholder.

**Why.** FR-10/MASTER_PROMPT §6. Nothing outside the injected region changes, so styles,
headers, footers, page setup, images, and section breaks survive by construction.

---

## ADR-010 — Web app stack: React 19 + Vite + Tailwind v4 + small custom UI kit

**Decision.** Vite SPA with a hand-rolled component kit (tokens in `index.css`, accessible
primitives) instead of shadcn/ui CLI. TanStack Query for server state, React Router for routes.

**Why.** shadcn/ui is a generator that copies code in; a small kit achieves the same visual
language (neutral surfaces, single indigo/violet accent) with predictable dependency licences
and no Radix tree to audit. Accessibility is handled with native semantics + focus-visible rings.

---

## ADR-011 — PDF conversion: local LibreOffice or remote converter, never simulated

**Decision.** `LIBREOFFICE_BIN` spawns `soffice` locally (bundled in the API Docker image);
alternatively `CONVERTER_URL` posts the DOCX to a converter service. If neither is configured the
export fails with `PDF_CONVERTER_NOT_CONFIGURED`, and the UI explains how to enable it.

**Why.** MASTER_PROMPT / FR-10. Never emit a fake or blank PDF.

---

## ADR-012 — Prompt-injection handling

**Decision.** System instructions live in the `system` role only. Extracted document text is
wrapped in explicit delimiters (`<source_document untrusted="true">…</source_document>`) with a
standing instruction that content inside is *data*, never instructions. Output is validated
against schemas; any output containing a forbidden pattern (e.g. "ignore previous instructions",
attempts to output new headings) is rejected/regenerated once, then flagged.

**Why.** PRD §12 and MASTER_PROMPT §5.

---

## ADR-013 — Heuristic-first, provider-optional generation path

**Decision.** With no provider configured the product still works end-to-end up to mapping, and
generation returns an explicit `NO_PROVIDER_CONFIGURED` error (never a stub draft).
Mapping/fact enrichment simply operate in deterministic mode. A `dev-offline` provider adapter
exists **only when `ENABLE_DEV_PROVIDER=true`** and is labelled in the UI; it is used by the
E2E/mocked test suites so the pipeline can be tested without external network.

**Why.** CI must not need network access or a paid key; but we must not ship a fake "AI" button
that pretends to be production inference.

---

## ADR-014 — Licensing

AGPL-3.0 as proposed by the PRD. Dependency licences verified: all runtime dependencies are
MIT / Apache-2.0 / BSD / ISC / MPL-2.0 (pdfjs-dist) — compatible with AGPL-3.0 aggregation and
distribution. LibreOffice (MPL-2.0) is invoked as a separate process, not linked.
Final licence choice remains the maintainer's decision (see `docs/DEPENDENCY_LICENSES.md`).
