# Implementation Plan

Status legend: `[x] done & tested`, `[~] done, limited`, `[ ] not implemented`.

Repository state at Phase 0: **empty project** (only `README.md`, `MASTER_PROMPT.md`,
`docs/PRD.md`). No package manager config, no code, no git history. Environment: Node 25.2.1,
npm 11.6.2, Python 3.10, git 2.50, Docker CLI present (daemon availability varies).

---

## Phase 0 — Inspection & architecture
- [x] Repository audit (empty scaffold, no reusable code, no conflicting configuration).
- [x] `docs/ARCHITECTURE.md`, `docs/TECHNICAL_DECISIONS.md`, `docs/IMPLEMENTATION_PLAN.md`,
      `docs/SECURITY_THREAT_MODEL.md`.
- [x] Stack decision: npm workspaces monorepo, Fastify 5 + Drizzle + PostgreSQL, React 19 + Vite,
      deterministic DOCX engine, LibreOffice for PDF (ADR-001…ADR-014).

## Phase 1 — Foundation
- [x] npm workspaces: `apps/api`, `apps/web`, `packages/shared`, `packages/docx-engine`,
      `packages/ai-providers`.
- [x] Env config with Zod validation (`apps/api/src/config.ts`) + `.env.example`.
- [x] PostgreSQL schema + migrations (Drizzle) for all required entities.
- [x] Auth: sign-up, sign-in, sign-out, session renewal, password change, account deletion.
- [x] Authorization: `AuthContext` threaded through every service; 404 for non-owned rows.
- [x] Private storage adapter (local fs + optional S3), quota accounting.
- [x] Project CRUD: create, rename, archive, restore, delete (cascade + storage purge).
- [x] Dashboard UI, auth screens, project list with statuses.
- [x] Tests: auth, isolation, project lifecycle.

## Phase 2 — Upload & extraction
- [x] Upload validation: extension + MIME + magic bytes + size + page/entry caps + zip-bomb guard.
- [x] DOCX template upload (immutable original + checksum).
- [x] Source upload: PDF (pdfjs-dist), DOCX (mammoth), TXT; OCR hook (Tesseract CLI / HTTP).
- [x] Extraction records with page/paragraph locations, status, error, duration.
- [x] Job queue + worker loop + boot recovery + cancel + retry.
- [x] UI: source upload list with live extraction status.
- [x] Tests: validation, extraction of fixtures, job recovery.

## Phase 3 — Template intelligence
- [x] DOCX structure map: heading hierarchy (style + outline level + numbering), styles,
      tables, headers/footers, page setup, images, section breaks, placeholders.
- [x] Stable section IDs, order, level, required flag (user-confirmable), insertion strategy.
- [x] Editable outline review UI (rename, reorder, toggle required, choose strategy/placeholder).
- [x] Fixture tests incl. a complex template (nested tables, headers, images, section breaks).

## Phase 4 — BYOK
- [x] `packages/ai-providers`: OpenAI-compatible, Anthropic, Gemini adapters + connection test.
- [x] AES-256-GCM credential vault, write-only API, `keyLast4`/fingerprint display, rotate key script.
- [x] Multiple configurations per user, default provider, explicit fallback order, session-only keys.
- [x] Usage events (tokens, duration, status, model) — no fabricated cost.
- [x] UI: provider settings, test connection, usage history.
- [x] Tests: adapters against a local mock HTTP provider, credential security, fallback.

## Phase 5 — Evidence mapping & generation
- [x] Chunking with provenance, fact candidates + categories + conflict detection.
- [x] Hybrid retrieval (lexical BM25-like) + AI-assisted mapping & gap detection.
- [x] Section generation with per-section evidence, schema-validated output, citation refs.
- [x] Fact-support validation: numbers/dates in drafts must appear in evidence → warning otherwise.
- [x] UI: evidence/mapping review, missing info & conflicts panel.
- [x] Tests: retrieval, gap/conflict detection, generation with mocked provider, no-invention guard.

## Phase 6 — Report workspace
- [x] Three-pane workspace: outline / editor / sources+warnings.
- [x] Autosave (debounced) with visible save state, optimistic-concurrency guard.
- [x] Regenerate single section with instructions; preserve other sections' edits.
- [x] Section status: draft → needs_review → validated → final; review progress.
- [x] Version history (snapshot on export + manual checkpoint + restore).

## Phase 7 — DOCX/PDF engine
- [x] Deterministic assembly from a copy of the original template (placeholders + anchor insert).
- [x] Fidelity report (headings, tables, images, styles, headers/footers) + warnings.
- [x] PDF conversion via LibreOffice (local bin or remote converter), validation of output.
      — verified end-to-end **inside the Docker image**: a real 1-page PDF (15.6 KB, `%PDF-1.6`)
      with extractable text was produced by LibreOffice 7.4.7 from a generated report.
      The dev host has no LibreOffice, so outside Docker PDF export refuses with
      `PDF_CONVERTER_NOT_CONFIGURED` (DOCX export is unaffected).
- [x] Export rows: kind, version, checksum, size, status; download with ownership check.
- [x] Tests: fidelity fixtures, placeholder replacement, escape safety, export validation.
      `apps/api/test/pdf.test.ts` covers `assertPdf` and the pdf.js buffer-detach regression.
- [x] `scripts/check-tenancy.mjs` static guard over `apps/api/src` (runs in CI).
- [x] `scripts/smoke-e2e.mjs` — black-box end-to-end check against a *running* deployment
      (sign-up → template → sources → mapping → generation → DOCX + PDF export).

## Phase 8 — Production & open source
- [x] `apps/web` SPA: landing, auth, dashboard, new-project, 3-pane workspace, providers,
      usage, account/privacy. Component-tested against a mocked `fetch`; verified end-to-end
      through the running API + Vite proxy.
- [x] Docker Compose (postgres, api with LibreOffice, web/nginx), multi-stage Dockerfiles.
      — both images build and the full stack was brought up and smoke-tested end-to-end.
- [x] CI: install, typecheck, tests, build, `npm audit`, gitleaks.
- [x] Docs: README, DEPLOYMENT, SELF_HOSTING, API_DOCUMENTATION, TESTING, USER_GUIDE,
      CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, LICENSE (AGPL-3.0), `.env.example`,
      DEPENDENCY_LICENSES.
- [x] Backup/restore + retention guidance (`docs/DEPLOYMENT.md` §5).
- [x] `fixtures/generate-fixtures.mjs` public fixture generator (`npm run fixtures`).
      — generates real, openable DOCX/PDF/TXT samples (verified: valid ZIP and
      `%PDF-` bytes).

> Items still unticked above are the remaining Phase 8 work. They are tracked here
> deliberately rather than pre-ticked, so the plan matches what actually exists.

## Bugs found and fixed by Docker verification

Bringing the real container stack up surfaced problems that only appear outside the
test harness. Both are fixed and covered by regression tests:

1. **`@formaai/shared` resolved to TypeScript source.** `exports` pointed at
   `./src/index.ts`, so the production API crashed at boot with
   `ERR_MODULE_NOT_FOUND`. Fixed by pointing `exports` at `./dist`, and both
   `shared` and `docx-engine` now exclude `*.test.ts` from their build output.
2. **pdf.js detached the buffer it validated.** `validatePdf` passed the caller's
   `Uint8Array` straight to pdf.js, which transfers it; the subsequent storage
   write then threw `Cannot perform Construct on a detached ArrayBuffer`, so every
   PDF export failed. Fixed by validating a copy. Regression test:
   `apps/api/test/pdf.test.ts` (verified to fail when the fix is reverted).

---

## Known limitations (documented, not hidden)
1. PDF **templates** are not supported as editable templates (MVP: DOCX only, per PRD §7 FR-03).
2. New table rows are not generated; tables are filled through `{{placeholders}}` only.
3. Footnotes/endnotes, tracked changes, content controls (`w:sdt`), and SmartArt are not edited
   (content controls are handled for placeholder text only).
4. XLSX/CSV/PPTX/images are not extracted in MVP (declared extensible in PRD; adapters pending).
5. OCR requires an external engine (`TESSERACT_BIN` or `OCR_ENDPOINT`).
6. Jobs run in-process; horizontal scale is safe (SKIP LOCKED) but per-instance concurrency is
   configured, not auto-tuned.

## Blocker policy
No blocker required user credentials: the BYOK design means tests use a local mock provider
server. A real provider end-to-end test can be run by the maintainer with
`npm run test:provider-live` and a real key in env (opt-in, never in CI).
