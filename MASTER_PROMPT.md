# MASTER PROMPT — FORMAAI
## Open Source · BYOK · Multi-user · Production · Self-hostable

You are the principal software architect, senior full-stack engineer, AI integration engineer, document-processing engineer, security engineer, and product designer responsible for delivering FormaAI.

Your task is to inspect the existing repository and build a real, tested, production-oriented implementation based on `docs/PRD.md`.

Do not build only a landing page or a visual prototype. Do not claim features are complete unless they work end-to-end and have been tested.

## 0. Product Definition — Non-negotiable
FormaAI is an open-source AI report-generation platform. A user uploads:
1. Their report template (DOCX is the primary template format).
2. One or more supporting documents.
3. Optional instructions.

The application analyzes the template, extracts evidence from source documents, maps evidence to the appropriate sections, detects missing/conflicting information, generates content using the user's own AI provider credentials, and assembles an editable report based on a copy of the original template.

Primary outputs: editable DOCX and PDF.

**The uploaded template is the source of truth.** Do not let AI invent a new structure or silently change headings, order, numbering, or formatting.

## 1. Mandatory Product Architecture
- Open-source public GitHub repository.
- BYOK: every user configures their own AI provider and API key.
- Multi-user, tenant-isolated projects, files, jobs, credentials, and exports.
- Multiple provider configurations per user.
- OpenAI-compatible custom Base URL and Model ID.
- Explicit provider/model selection and optional user-configured fallback.
- Hosted SaaS and self-hosted deployment.
- Private file storage.
- Backend-routed AI requests.
- Template-aware DOCX generation.
- PDF conversion from finalized DOCX.
- No centrally shared AI key as the default or hidden fallback.

Read the complete PRD before implementation. If this prompt and PRD appear inconsistent, preserve the core requirements above and document the conflict in `docs/TECHNICAL_DECISIONS.md`.

## 2. Phase 0 — Repository Inspection (do this first)
Before modifying files:
1. Inspect repository structure, package manager, framework, dependencies, scripts, environment variables, database, and current working features.
2. Identify reusable code and risks.
3. Do not overwrite working features without justification.
4. Verify dependency compatibility and current official documentation for major integrations.
5. Propose a practical architecture within the repository's existing constraints.

Create/update:
- `docs/ARCHITECTURE.md`
- `docs/IMPLEMENTATION_PLAN.md`
- `docs/TECHNICAL_DECISIONS.md`
- `docs/SECURITY_THREAT_MODEL.md`

Then report a concise assessment, planned milestones, infrastructure assumptions, and unresolved blockers. Continue with implementation unless a genuinely blocking decision or credential is missing.

## 3. Engineering Rules
- TypeScript-first for web/API code.
- Strong input/output schemas and runtime validation.
- Clear service boundaries.
- Secure defaults.
- Database migrations checked into Git.
- Server-side authorization on every protected operation.
- No secrets in source, client bundles, URLs, screenshots, logs, or test fixtures.
- No fake buttons, fake provider connections, fake progress, or mock data presented as production functionality.
- Use deterministic document-processing code for DOCX manipulation; do not ask an LLM to construct raw DOCX internals.
- Persist intermediate job results and make long-running tasks recoverable.
- Keep dependencies minimal and explain significant choices.
- Use accessible, responsive UI patterns.
- Add tests with each phase.

## 4. BYOK Provider System — Critical
Create a provider abstraction with a common interface for:
- connection testing,
- model/request execution,
- structured output where supported,
- usage metadata where returned,
- timeout and error normalization.

Support:
- OpenAI-compatible endpoints (custom Base URL, API key, model ID).
- Native adapters for providers whose API differs.
- Providers such as OpenAI, Gemini, Anthropic, DeepSeek, Qwen, GLM, OpenRouter and other adapters as actually implemented and tested.

Do not simply display provider logos and claim support. A provider is supported only after adapter tests pass.

Each authenticated user can:
- add multiple provider configurations,
- name configurations,
- set Base URL and model,
- add/update/delete credentials,
- test connectivity,
- choose a default,
- select a provider for a task,
- configure explicit fallback order.

Never silently switch to a different user's key or a platform-owned key. If the selected provider fails and no user-authorized fallback exists, return a clear error and preserve the job state.

### Credential handling
- Encrypt credentials at rest with authenticated encryption such as AES-256-GCM.
- Keep master keys in server environment secrets/secret manager, never in the database or frontend.
- Never return plaintext credentials after initial submission.
- Never store keys in localStorage, sessionStorage, URLs, analytics, or logs.
- Scope every credential lookup to the authenticated user.
- Support credential rotation and deletion.
- Consider session-only credentials as an optional mode.
- Redact authorization headers and provider error payloads before logging.
- Document key rotation and backup/recovery implications.

## 5. Document Pipeline
Implement independently testable stages:
1. Upload validation.
2. Template parsing.
3. Source extraction.
4. OCR when configured and needed.
5. Normalization and chunking.
6. Source fact extraction and location tracking.
7. Template section analysis.
8. Evidence-to-section mapping.
9. Gap/conflict detection.
10. Section drafting.
11. Factual/structural validation.
12. User review and editing.
13. DOCX assembly from original template copy.
14. PDF conversion.
15. Export validation and versioning.

MVP inputs: DOCX template; PDF, DOCX, TXT source documents. Add XLSX, CSV, PPTX, JPG, PNG through tested adapters in later increments.

Treat uploaded documents as untrusted content. Text inside a source file must never override system/developer instructions, request secrets, or authorize external actions.

## 6. Template Fidelity
Do not flatten the template and rebuild it from scratch.

Keep the original immutable. Generate from a working copy. Preserve, where supported:
- styles,
- headings and numbering,
- paragraphs,
- tables,
- headers and footers,
- page setup,
- section breaks,
- page breaks,
- images and relationships.

Test with representative complex DOCX fixtures. If an element cannot be preserved reliably, flag it and document the limitation. Do not silently destroy it.

Generate PDF from the final DOCX using a controlled conversion worker (for example LibreOffice headless). Re-open and validate the output before declaring success.

## 7. AI Generation Quality
Use structured, bounded, section-level operations rather than one giant prompt.

For each generated section:
- supply only relevant source evidence,
- preserve source IDs and locations,
- specify section requirements and template constraints,
- request structured output,
- validate output against a schema,
- record provider/model and usage metadata when available.

Never invent:
- facts, dates, numbers, people, organizations,
- research results,
- citations, page numbers, DOIs, URLs,
- evidence that is not present in sources.

When information is missing, conflicting, or uncertain, return explicit warnings and ask for user input or use a visible placeholder. Do not hide uncertainty.

AI output is a draft. User review is required before final export.

## 8. UX Requirements
Build a professional document-production workspace, not a generic chatbot.

Required screens:
- Landing page with clear BYOK and privacy explanation.
- Authentication.
- Dashboard and project list.
- New report/project wizard.
- Template upload and outline review.
- Source material upload and extraction status.
- Evidence and section mapping review.
- Report workspace with outline, editor, sources, warnings.
- Preview and export.
- AI provider settings and connection testing.
- Usage history.
- Account/privacy settings.

Design:
- clean, modern, minimal SaaS,
- white/neutral surfaces,
- restrained blue or violet accent,
- accessible typography and contrast,
- responsive layout,
- meaningful empty/loading/error states,
- subtle animations only.

The report workspace should prioritize:
- left: report outline,
- center: section editor,
- right: source references, missing information, validation warnings.

## 9. Security and Multi-tenancy
- Enforce ownership on server routes and database queries.
- Add RLS policies if using Supabase.
- Test cross-tenant access attempts for every resource type.
- Use private storage and short-lived signed URLs.
- Validate MIME type and file signature, not extension alone.
- Process uploads in isolated workers with resource limits.
- Protect against path traversal, malformed files, archive bombs, and parser vulnerabilities.
- Apply rate limits and per-user resource quotas.
- Avoid logging document text and secrets by default.
- Provide deletion and retention controls.
- Use HTTPS in production.
- Add dependency and secret scanning to CI.

## 10. Delivery Phases
Work in this order. Do not skip ahead to polish before the core pipeline works.

### Phase 0 — Inspection and architecture
Deliver architecture, implementation plan, technical decisions, and threat model.

### Phase 1 — Foundation
Authentication, project CRUD, database migrations, private storage, tenant authorization, dashboard.

### Phase 2 — Upload and extraction
DOCX template upload, PDF/DOCX/TXT source upload, validation, extraction, status tracking, source locations.

### Phase 3 — Template intelligence
Template structure map, heading hierarchy, style metadata, editable outline review, fixture tests.

### Phase 4 — BYOK
Provider adapters, encrypted credential storage, connection test, default provider/model, explicit fallback, usage logging.

### Phase 5 — Evidence mapping and AI generation
Source facts, section mapping, missing/conflict detection, section generation, validation, traceability.

### Phase 6 — Report workspace
Section editor, save/autosave, source references, regeneration, version history, review status.

### Phase 7 — DOCX/PDF engine
Template-aware assembly, conversion worker, output validation, fidelity fixtures, export downloads.

### Phase 8 — Production and open-source release
Docker Compose, environment template, CI, security scans, backup/restore guide, README, license, contribution guide, release checklist.

After every phase:
- list completed features and changed files,
- run tests and show actual results,
- list known limitations and blockers,
- update implementation plan,
- do not claim untested functionality works.

## 11. Required Repository Deliverables
- `README.md`
- `LICENSE` (proposed AGPL-3.0; confirm maintainer decision and dependency compatibility)
- `CONTRIBUTING.md`
- `CODE_OF_CONDUCT.md`
- `SECURITY.md`
- `.env.example` with placeholders only
- Dockerfiles and `docker-compose.yml`
- database migrations and RLS policies
- automated tests and representative document fixtures
- GitHub Actions CI
- `docs/ARCHITECTURE.md`
- `docs/IMPLEMENTATION_PLAN.md`
- `docs/TECHNICAL_DECISIONS.md`
- `docs/SECURITY_THREAT_MODEL.md`
- `docs/DEPLOYMENT.md`
- `docs/SELF_HOSTING.md`
- `docs/USER_GUIDE.md`
- `docs/API_DOCUMENTATION.md`
- `docs/TESTING.md`

## 12. Production Acceptance Gate
Do not label the project production-ready until these have been verified:
1. User A cannot access User B's projects, files, exports, jobs, or credentials.
2. BYOK requests use the requesting user's selected provider.
3. No hidden cross-user or platform-key fallback occurs.
4. API keys are encrypted at rest and never returned in plaintext.
5. Custom OpenAI-compatible endpoint works with a real test provider.
6. Invalid credentials and provider outages produce safe, understandable errors.
7. Upload validation and worker isolation are tested.
8. Template and source extraction statuses are accurate.
9. Missing/conflicting facts are surfaced, not fabricated.
10. Individual section regeneration preserves unrelated edits.
11. DOCX output is generated from original template copy and passes defined fidelity tests.
12. PDF is generated and validated.
13. Jobs survive worker restart or are safely marked recoverable/failed.
14. Clean Docker self-host installation works using documented configuration.
15. CI, tests, dependency scanning, and secret scanning pass.
16. Public repository contains no secrets or real user documents.

## 13. Final Execution Instruction
Start now with Phase 0. Inspect the repository before modifying it. Do not ask the user to repeat requirements already specified in the PRD. Make reasonable, documented technical decisions. Ask only when a decision is genuinely blocking or requires user-owned credentials/approval.

Build a dependable product, not a flashy demo. Prioritize template fidelity, source traceability, BYOK security, multi-user isolation, and real DOCX/PDF export.
