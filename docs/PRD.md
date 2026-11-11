# FormaAI — Final Product Requirements Document
**Version:** 1.0.0  
**Status:** Development baseline  
**Product:** Open-source, BYOK, template-driven AI report generation platform

## 1. Product Summary
FormaAI helps a user turn a supplied report template and one or more source documents into an editable report that follows the supplied template.

The user provides:
1. A report template (DOCX is the primary supported template format).
2. Supporting materials (initially PDF, DOCX, and TXT; other formats are extensible).
3. Optional instructions such as language, tone, audience, report type, and constraints.

FormaAI analyzes the template, extracts and organizes source information, maps evidence to required sections, identifies missing or conflicting information, drafts content section by section, and populates a copy of the original template. The user reviews and approves the result before export.

**Non-negotiable product principle:** the uploaded template is the authority for report structure and formatting. AI must not invent a different structure.

## 2. Product Goals
- Produce accurate, editable reports from user-owned templates and source materials.
- Preserve template structure and formatting as faithfully as technically possible.
- Make generated claims traceable to uploaded sources.
- Never silently invent missing facts, numbers, dates, names, citations, or results.
- Let each user connect and pay for their own AI provider through BYOK.
- Publish the core application as a public open-source GitHub project.
- Support both hosted SaaS and self-hosted deployment.
- Be production-oriented: secure multi-user isolation, recoverable jobs, testing, monitoring, and documented deployment.

## 3. Non-Goals for MVP
- Fully autonomous submission or publication of reports.
- Guaranteed pixel-perfect fidelity for every possible Word feature.
- Training or fine-tuning foundation models.
- Providing centrally funded AI inference.
- Supporting every office format on day one.
- Replacing human review for academic, legal, financial, or official reports.

## 4. Target Users and Use Cases
- Students preparing practical, activity, internship, research, or academic reports.
- Student organizations preparing event and accountability reports.
- Lecturers, researchers, and administrative staff.
- Teams preparing business, operational, and project reports.

Typical workflow: upload template → upload evidence → review detected structure → review extracted facts → map facts to sections → generate draft → edit and validate → export DOCX/PDF.

## 5. Product Modes and Business Model
### Hosted SaaS
- The project owner operates the application infrastructure.
- Each user configures their own provider credentials (BYOK).
- User documents, projects, and provider credentials are isolated.
- AI usage is charged by the chosen provider to the user, not silently subsidized by FormaAI.

### Self-hosted
- Operators deploy the application using documented environment variables and Docker Compose.
- The installation uses the operator's own database, storage, and encryption secrets.
- Each end user can still configure their own AI provider credentials.
- Self-hosted deployments must not depend on the original maintainer's API keys or infrastructure.

## 6. User Roles
- **Unauthenticated visitor:** can view public landing and documentation.
- **Authenticated user:** manages only their own projects, documents, provider credentials, drafts, and exports.
- **Instance operator/admin:** manages deployment-level configuration, service health, retention settings, and operational logs. Admin access must not automatically expose user document contents or raw API credentials.

## 7. Functional Requirements

### FR-01 — Authentication and User Isolation
- Support secure sign-up, sign-in, sign-out, and session renewal.
- Every user-owned record must have an owner identifier.
- Enforce authorization on the server for every project, document, credential, job, and export operation.
- If Supabase is used, implement and test Row Level Security (RLS).
- Never rely only on frontend filtering for access control.

### FR-02 — Project Management
- Create, rename, archive, restore, and delete report projects.
- Store project title, report type, language, instructions, status, and timestamps.
- Show recent projects and processing states.
- Persist progress so users can resume after leaving the application.
- Deletion must follow a documented retention policy and remove associated private artifacts as configured.

### FR-03 — Template Upload and Analysis
MVP template format: DOCX. PDF may be accepted as a visual/reference-only template in a later increment; do not promise editable structure extraction from PDF until implemented and tested.

Analyze, where technically possible:
- Document title and metadata.
- Heading hierarchy and numbering.
- Paragraph styles and text formatting.
- Tables and nested tables.
- Headers and footers.
- Page size, margins, orientation, and section breaks.
- Page breaks and existing images.
- Placeholder text and empty fields.

Produce a structured Template Structure Map containing stable section IDs, heading text, hierarchy, order, required/optional status (user-confirmable), and insertion strategy. Show the detected outline to the user and allow correction before generation.

Do not flatten the DOCX to plain text and rebuild the whole document. Keep the original uploaded template immutable and create a working copy for generation.

### FR-04 — Source Material Upload and Extraction
MVP source formats:
- PDF (text-based; scanned PDF requires OCR capability).
- DOCX.
- TXT.

Extensible formats:
- XLSX, CSV, PPTX, JPG, PNG.

Requirements:
- Multiple files per project.
- Validate extension, MIME type, file signature, size, and page limits.
- Store files in private storage.
- Extract text and tables when supported.
- Preserve filename, page/slide/sheet/paragraph location where possible.
- Track extraction status and errors.
- Never mark failed or partial extraction as complete.
- Treat uploaded documents as untrusted data, not as instructions to the AI system.

### FR-05 — Source Intelligence and Traceability
Extract facts into structured records. Important facts should retain:
- Fact text/value.
- Source document ID and filename.
- Page/slide/sheet or location.
- Extraction method.
- Confidence or review status, if supported.
- Relevant surrounding context.

Detect duplicate, inconsistent, and potentially conflicting facts. Do not resolve conflicts silently. Present competing values and their source locations for user review.

### FR-06 — Template-to-Source Mapping
For each template section, produce:
- Section purpose and requirements.
- Relevant source facts.
- Source references.
- Information gaps.
- Potential conflicts.
- Suggested content plan.

Users must be able to inspect and correct mappings. The system must not force unrelated source content into a section merely to make it appear complete.

### FR-07 — Missing Information Detection
Before generation, identify:
- Required sections with insufficient evidence.
- Missing dates, names, figures, or other required fields.
- Conflicting values across sources.
- Unsupported requested claims.
- Missing references or source material.

Offer actions:
- Upload more evidence.
- Enter information manually.
- Leave a clearly marked placeholder.
- Generate a draft with an explicit warning.

Never fabricate information to fill a gap.

### FR-08 — AI Generation (BYOK)
Generation is section-based, not one unbounded request for the entire report.
- Generate all eligible sections.
- Generate or regenerate one selected section.
- Respect language, tone, audience, length, and user instructions.
- Use only relevant evidence for each section to control context and cost.
- Preserve source references for factual claims where practical.
- Distinguish extracted facts from AI-written transitions or explanations.
- Validate structured model outputs before saving.
- Preserve user edits; regeneration must not overwrite unsaved edits without confirmation.

### FR-09 — User Editing and Review
- Provide section navigation and an editor.
- Show source references and warnings beside relevant content.
- Support save/autosave with visible save state.
- Support section regeneration with user instructions.
- Provide draft, needs-review, validated, and final states.
- Require explicit user review/approval before final export.
- Maintain version history for generated drafts and exports.

### FR-10 — Document Assembly and Export
- Assemble into a copy of the original DOCX template.
- Preserve existing styles, paragraph formatting, tables, headers, footers, page settings, images, and section breaks where supported.
- Insert generated content into mapped locations using deterministic document-processing code, not an LLM writing raw DOCX internals.
- Do not overwrite the original template.
- Export editable DOCX.
- Generate PDF from the finalized DOCX using a reliable conversion engine such as LibreOffice in a controlled worker/container.
- Report unsupported Word elements or fidelity warnings.
- Re-open and validate generated files before marking export successful.

### FR-11 — AI Provider Configuration (BYOK)
Each user can add multiple provider configurations:
- Display name.
- Provider type/adapter.
- Base URL.
- API key.
- Model ID.
- Optional request settings supported by the adapter.
- Connection test status.
- Default provider/model.
- Optional user-selected fallback order.

Support:
- OpenAI-compatible endpoints (custom Base URL + model ID).
- Native provider adapters when required by provider-specific API behavior.
- Providers such as OpenAI, Gemini, Anthropic, DeepSeek, Qwen, GLM, OpenRouter, and other compatible services, subject to adapter implementation and provider terms.

Do not claim every provider works merely because it is listed. Test each adapter. Never silently route a user's request through another user's key or a platform-owned key. Fallback must be explicit and visible to the user.

### FR-12 — Credential Security
- Encrypt API keys at rest using authenticated encryption (e.g. AES-256-GCM).
- Keep master encryption keys outside the database in deployment secrets/secret manager.
- Never return plaintext keys after initial submission.
- Never expose credentials to browser storage, client bundles, URLs, analytics, or logs.
- Scope credentials to the authenticated user.
- Support update and deletion.
- Consider session-only credentials for users who do not want persistent storage.
- Document key rotation and recovery implications.
- Apply least-privilege access to database and storage.

### FR-13 — Usage and Provider Transparency
Track, when returned by the provider:
- User and provider configuration ID.
- Model.
- Operation type.
- Input/output tokens.
- Request duration and status.
- Estimated cost only when pricing data is known and current.

Clearly state that provider billing is between the user and their selected provider. Do not fabricate token counts or prices.

### FR-14 — Background Processing
- Long extraction, OCR, generation, and conversion tasks run asynchronously.
- Show job state and progress.
- Persist job status and stage.
- Retry only safe/idempotent operations.
- Support cancellation where practical.
- Prevent duplicate jobs and duplicate exports.
- Recover or mark interrupted jobs after worker restart.
- Do not lose completed stage outputs.

### FR-15 — Auditability and Error Handling
- Use structured logs with correlation/job IDs.
- Redact secrets and document contents by default.
- Show actionable user-facing errors.
- Keep operational logs separate from user content.
- Record meaningful status changes and export events.
- Avoid exposing stack traces or infrastructure secrets to end users.

## 8. AI Pipeline
1. Upload and validate files.
2. Extract template structure.
3. Extract source text/tables/OCR.
4. Normalize and index extracted content.
5. Build source fact records with locations.
6. Analyze section requirements.
7. Map evidence to sections.
8. Detect gaps and conflicts.
9. Generate section drafts using the user's selected provider.
10. Validate factual support and structure.
11. User review and edits.
12. Assemble DOCX from original template copy.
13. Convert final DOCX to PDF.
14. Validate files and store versioned outputs.

Each stage must have structured inputs/outputs, persisted status, bounded retries, and independent tests.

## 9. Recommended Architecture
Use a modular monorepo unless repository inspection shows a strong reason otherwise.

Suggested components:
- `apps/web`: React + TypeScript frontend.
- `apps/api`: authenticated backend API.
- `services/document-worker`: extraction, DOCX manipulation, PDF conversion, OCR orchestration.
- `packages/ai-providers`: provider adapters and common interface.
- `packages/shared`: schemas, types, validation, constants.
- `supabase/migrations`: database schema and RLS policies.
- `docs`: architecture, threat model, deployment, testing, user guide.

Suggested technologies (agent must verify compatibility before choosing):
- Frontend: React, TypeScript, Vite or Next.js, Tailwind CSS, shadcn/ui.
- Backend: Node.js + TypeScript (Fastify or NestJS).
- Database/Auth: PostgreSQL and optionally Supabase.
- Private storage: Supabase Storage or S3-compatible object storage.
- Document processing: Python, python-docx, PyMuPDF/pdfplumber, openpyxl, python-pptx.
- OCR: optional Tesseract or a configurable OCR provider.
- Queue: Redis + BullMQ, or a documented database-backed alternative.
- PDF conversion: LibreOffice headless in an isolated worker/container.

Do not add infrastructure that cannot be deployed or maintained within the project's realistic budget. Provide a simple local Docker Compose path.

## 10. Data Model (minimum logical entities)
- `users`
- `projects`
- `templates`
- `source_documents`
- `extracted_chunks` or `source_facts`
- `template_sections`
- `section_mappings`
- `report_sections`
- `report_versions`
- `provider_credentials`
- `ai_usage_events`
- `processing_jobs`

All user-owned rows must be tenant-scoped. Define foreign keys, indexes, cascade behavior, retention, and RLS/authorization tests. Do not store large document blobs directly in ordinary relational rows.

## 11. Main Screens
1. Landing page: clear value proposition, workflow, privacy/BYOK explanation, GitHub link.
2. Authentication.
3. Dashboard: projects, statuses, create report.
4. New project wizard.
5. Template upload and structure review.
6. Source material upload and extraction status.
7. Evidence/mapping review.
8. Report workspace: outline, editor, sources, warnings.
9. Preview and export.
10. AI provider settings.
11. Usage history.
12. Account and privacy settings.

Design direction: clean professional SaaS, neutral/white base, restrained blue or violet accent, accessible contrast, responsive layout, no generic chatbot-first design.

## 12. Security, Privacy, and Abuse Controls
- Enforce authorization server-side on every request.
- Use private object storage and short-lived signed URLs.
- Validate uploads by file signature and process in sandboxed workers.
- Apply file size, page count, and processing-time limits.
- Defend against path traversal, archive bombs, malformed files, and parser vulnerabilities.
- Treat document text as untrusted prompt-injection content.
- Keep system instructions separate from extracted content.
- Do not allow source documents to override application policies or reveal secrets.
- Apply rate limits and per-user quotas for resource-intensive operations.
- Provide deletion and retention controls.
- Use HTTPS in production.
- Keep secrets out of Git and CI logs.
- Run dependency and secret scanning in CI.

## 13. Open Source and Licensing
- Publish the application source in a public GitHub repository.
- Include README, LICENSE, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, `.env.example`, Docker files, migrations, tests, and deployment documentation.
- Proposed license: AGPL-3.0, subject to maintainer's final legal/licensing decision.
- Review every dependency's license and attribution requirements.
- Do not copy provider SDK code or third-party assets without permission.
- Do not include user documents, real API keys, production data, or private environment files.
- Clearly distinguish open-source self-hosted functionality from any optional hosted service.

## 14. MVP Scope and Delivery Order
### MVP 1 — Foundation
Authentication, project CRUD, private upload, DOCX template upload, PDF/DOCX/TXT source upload, database migrations, authorization tests.

### MVP 2 — Document Intelligence
Template outline extraction, source extraction, tables where practical, source location metadata, extraction status, template outline review.

### MVP 3 — BYOK and AI Mapping
Provider settings, secure credential handling, connection test, structured AI adapter, source-to-section mapping, missing information and conflict warnings.

### MVP 4 — Report Workspace
Section generation, editing, regeneration, source references, autosave/versioning, review status.

### MVP 5 — Document Output
Template-aware DOCX assembly, PDF conversion, output validation, download, fidelity tests.

### MVP 6 — Production and Open Source Release
Docker Compose, deployment guide, CI, security checks, observability, backup/restore guidance, public repository hygiene.

## 15. Acceptance Criteria
The MVP is accepted only when:
1. A user can create an account and project.
2. User A cannot access User B's projects, documents, jobs, exports, or credentials.
3. A DOCX template can be uploaded and its major heading structure reviewed.
4. Multiple source files can be uploaded and extracted with visible status.
5. Important extracted facts retain source location metadata where available.
6. The system maps evidence to appropriate template sections.
7. Missing and conflicting information is shown rather than silently invented.
8. A user can configure and test their own AI provider.
9. Report generation uses the requesting user's configured provider.
10. Provider failure does not silently use another user's or platform's key.
11. Users can edit and regenerate individual sections without losing other edits.
12. The generated DOCX is based on the original template and passes defined structural/fidelity tests.
13. PDF is generated from the finalized DOCX and validated.
14. Failed jobs can be diagnosed and safely retried.
15. A clean self-hosted installation can be started using documented setup instructions.
16. CI, automated tests, dependency checks, and secret scanning pass.
17. No secrets or private user documents are present in the public repository.

## 16. Success Metrics
- Successful document extraction rate by format.
- Template structure detection accuracy.
- Percentage of generated factual claims with traceable evidence.
- Missing/conflicting information detection rate.
- DOCX structural fidelity test pass rate.
- Export success rate.
- Average time and provider token usage per report.
- User correction rate per generated section.
- Cross-tenant security test pass rate.

## 17. Product Definition of Done
A feature is not complete because its UI exists. It is complete only when the backend behavior, authorization, persistence, error states, tests, and documentation are implemented and verified.

FormaAI must be described as production-ready only after the relevant acceptance tests have actually passed.
