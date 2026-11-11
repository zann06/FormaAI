# FormaAI — Architecture

Status: implemented architecture (see `docs/IMPLEMENTATION_PLAN.md` for phase status).

## 1. System Overview

FormaAI is a monorepo containing a React SPA, a Fastify HTTP API, and three shared
TypeScript packages. Document parsing, DOCX assembly (deterministic XML-level editing),
and PDF conversion all run inside the API process on the server; long-running work runs in a
persistent database-backed job queue.

```
┌───────────────────────────┐
│  apps/web (React + Vite)  │  SPA, talks only to /api/*
└─────────────┬─────────────┘
              │ HTTPS, HttpOnly cookie session
┌─────────────▼─────────────────────────────────────────────┐
│  apps/api (Fastify 5)                                     │
│  routes: auth, projects, documents, template, ai-config,  │
│          pipeline, sections, exports, usage, health       │
│  services: auth, storage, jobs, extraction, template,     │
│            mapping, generation, assembly, export          │
└───────┬───────────────┬───────────────┬───────────────────┘
        │               │               │
        │ SQL           │ private files │ provider HTTPS
┌───────▼──────┐ ┌──────▼───────┐ ┌─────▼──────────────┐
│ PostgreSQL   │ │ local volume │ │ OpenAI-compatible  │
│ (Drizzle)    │ │ or S3 bucket  │ │ / Anthropic /      │
│              │ │              │ │ Gemini adapters    │
└──────────────┘ └──────────────┘ └────────────────────┘
                       │
              ┌────────▼─────────┐
              │ LibreOffice      │  DOCX → PDF (soffice --headless)
              │ (worker/container│  also available via remote
              │  or remote URL)  │  converter HTTP endpoint
              └──────────────────┘
```

## 2. Deliberate deviations from the PRD's *suggested* stack

The PRD (§9) suggests a Python `services/document-worker`. We implemented the document
pipeline in TypeScript instead. Reasons, recorded in `docs/TECHNICAL_DECISIONS.md`:

* **Deterministic DOCX assembly requires byte-level XML control.** The template is never
  flattened: we unzip the original `.docx`, edit `word/document.xml` (w:p / w:tbl) while
  reusing the template's own paragraph/run styles, and re-zip the *copy*. That guarantees every
  untouched part (headers, footers, styles, numbering, images, relationships, section
  properties) is preserved bit-for-bit because we never rewrite it.
* One runtime, one package manager, one CI matrix, one dependency audit surface.
* Parsing is delegated to battle-tested libraries (`pdfjs-dist` for PDF text+positions,
  `mammoth` for DOCX→HTML, `fflate` for ZIP with size guards), not custom parsers.

The PRD explicitly requires verifying technology compatibility before choosing (§9), and
MASTER_PROMPT requires documenting the conflict — done.

## 3. Repository layout

```
apps/
  api/                Fastify API + pipeline + job worker
    src/
      config.ts       Zod-validated environment
      server.ts       app factory (used by tests too)
      index.ts        process entry: migrate → listen → worker
      db/             drizzle schema, migrations, client
      lib/            crypto (AES-256-GCM), password hashing, redaction, errors
      plugins/        auth (session cookie), rate limit, security headers
      services/       feature services (one folder per domain concern)
        upload/       validation (magic bytes), storage (local/S3)
        extraction/   pdf, docx, txt, ocr adapters
        template/     DOCX structure analysis
        facts/        chunking + heuristic fact candidates + location metadata
        mapping/      lexical retrieval + AI mapping, gaps/conflicts
        generation/   section drafting + fact-support validation
        assembly/     DOCX working-copy writer (zip-preserving)
        export/       PDF conversion + output validation + versions
        jobs/         queue, worker loop, recovery
        ai/           providers: OpenAI-compatible, Anthropic, Gemini
      routes/         HTTP endpoints (thin: validate → authorize → service)
    test/             vitest integration tests (real Postgres, real HTTP)
  web/                React 19 + Vite + Tailwind SPA
packages/
  shared/             Zod schemas, constants, shared types, pure helpers
  docx-engine/        DOCX parse/assemble primitives (no DB, no HTTP)
  ai-providers/       provider adapter interface + implementations
fixtures/             representative DOCX templates and sources + generators
```

## 4. Tenancy and authorization model

* Every user-owned table has a `user_id` (or `owner_id`) column with an index.
* **All data access goes through `apps/api/src/services`**, which *require* an
  `AuthContext { userId }` and always include `eq(table.userId, ctx.userId)` in the SQL
  predicate. There is no "fetch by id then check" pattern: the predicate is part of the query.
* Route handlers call `requireUser(request)` which throws `UnauthorizedError` (401) unless the
  session cookie resolves to a valid session row. Session tokens are 256-bit random, stored as
  SHA-256 hashes, and sent only as `HttpOnly; SameSite=Lax; Secure` cookies.
* Cross-tenant tests exist for projects, documents, template, sections, jobs, exports, and
  provider credentials; they assert **404** (not 403, to avoid resource enumeration).
* Optional Postgres RLS is provided as defence-in-depth (`SELECT ... WHERE user_id =
  current_setting('app.user_id')`) but is **not** the primary control; the API runs as a single
  application role and enforces predicates in SQL. See `docs/SECURITY_THREAT_MODEL.md`.

## 5. Storage

`StorageAdapter` interface with two implementations:

* `LocalStorage` — files stored under `STORAGE_DIR/<userId>/<projectId>/<uuid>-<safeName>`;
  the path segment is always a generated UUID; the user-supplied filename is never used as a
  path. Files are never served by the web server directly; the API streams them after an
  ownership check (`GET /api/documents/:id/file`).
* `S3Storage` — optional (any S3-compatible endpoint), objects keyed the same way, always
  private; downloads are proxied through the API so no bucket policy is ever public.

Per-user storage quota and per-file size limits are enforced before writing.

## 6. Processing pipeline (persisted stages)

```
upload → validate(magic bytes, size, pages) → extract (pdf|docx|txt|ocr) → chunks
       → fact candidates (with source location) → template structure map
       → AI/heuristic section mapping → gaps & conflicts → section drafts
       → user review/edits → version snapshot → DOCX assembly → PDF → validated exports
```

Each stage is a separate function with typed input/output, its own tests, and persisted
results (`documents.extraction_*`, `template_sections`, `section_mappings`, `report_sections`,
`report_versions`, `processing_jobs`). Jobs are rows in `processing_jobs` with
`status`, `stage`, `progress`, `attempts`, `error`. The worker claims jobs with
`UPDATE ... SET status='running' WHERE id = (SELECT id ... FOR UPDATE SKIP LOCKED)` so multiple
API instances can share the queue. On boot, jobs still `running` from a previous process are
marked `queued` again (recoverable) or `failed` after `JOB_MAX_ATTEMPTS`.

## 7. AI layer (BYOK)

`packages/ai-providers` exposes:

```ts
interface ProviderAdapter {
  complete(req: CompletionRequest): Promise<CompletionResult>;
  testConnection(cfg): Promise<{ ok: boolean; message: string; models?: string[] }>;
  generateStructured<T>(req, schema): Promise<StructuredResult<T>>;
}
```

* `openai-compatible` — `POST {baseUrl}/chat/completions`; supports `json_schema` /
  `json_object` response formats, custom headers, temperature/max tokens. Works with OpenAI,
  DeepSeek, Qwen (DashScope compatible mode), GLM (Zhipu), OpenRouter, Groq, Together,
  LM Studio, Ollama (OpenAI mode), vLLM, and any other OpenAI-compatible server.
* `anthropic` — `POST /v1/messages` with `x-api-key` + `anthropic-version`, tool-based
  structured output.
* `gemini` — `POST /v1beta/models/{model}:generateContent` with `x-goog-api-key`,
  `responseMimeType: application/json` + schema.

Credentials: AES-256-GCM with a 32-byte key from `CREDENTIAL_ENCRYPTION_KEY` (base64/hex),
random 12-byte IV per record, auth tag stored, AAD = `userId:credentialId` so ciphertexts
cannot be replayed across rows or users. Plaintext keys exist only in the request that
submits them and in worker memory during a provider call. API responses expose
`keyLast4` + fingerprint only. A per-user "session-only" option is supported: the key is stored
encrypted with `expiresAt = now + sessionTtl` and purged by the worker.

Fallback is **explicit**: a job records `provider_credential_id`; if it fails, and the user
configured `fallbackCredentialId`, the next attempt uses it and the change is recorded in the
job's `stage_events` and surfaced in the UI. There is no server-wide key.

## 8. Fidelity strategy for DOCX

1. The uploaded template file is stored once and never modified
   (`template_files.is_original`, `checksum`). A new "working copy" is created per assembly run.
2. `packages/docx-engine` unzips the copy, parses `word/document.xml` with `fast-xml-parser`
   (preserveOrder), and performs **surgical** edits:
   * placeholder replacement inside runs (`{{section_key}}`) using the template's own run
     properties (splitting runs so surrounding formatting is untouched);
   * optional insertion of new paragraphs **cloned from a template paragraph** (`w:pPr` and
     `w:rPr` copied) right after the anchor heading, with `w:pStyle` inherited;
   * optional table cell fill by `{{key}}` placeholders using the existing cell paragraph style.
3. Everything else in the package (styles.xml, numbering.xml, headers, footers, media,
   relationships, section properties) is copied unchanged.
4. Limits are declared: content controls (`w:sdt`) containing placeholders are handled by
   placeholder text replacement inside them; footnotes/endnotes are not edited; tracked changes
   are left as-is.
5. After writing, the DOCX is re-opened, ZIP integrity is checked, `word/document.xml` is
   re-parsed, and a structural fidelity report compares heading count, table count, image
   count, style IDs, header/footer parts against the original template. Mismatches become
   non-fatal warnings recorded on the export row.

## 9. PDF conversion

`soffice --headless --convert-to pdf` executed with a per-conversion user profile directory,
a hard timeout, and `PATH` restricted to the binary. Configured via `LIBREOFFICE_BIN`
(local Docker image in `Dockerfile.api`) or `CONVERTER_URL` (remote converter service, e.g. a
pinned `libreoffice` container exposing a small HTTP API). Without either, PDF export fails
with an actionable error instead of silently producing a fake file.

## 10. Observability & errors

* Structured logs (pino) with `requestId`/`jobId` correlation; log redaction list includes
  `authorization`, `cookie`, `apiKey`, `*_key` patterns).
* No document text in logs by default (`LOG_DOCUMENT_CONTENT=false`).
* Errors are normalised to `{ code, message }` with a user-facing message and a separate
  internal log entry; stack traces never leave the server (`NODE_ENV=production`).

## 11. Configuration

All configuration is environment variables validated by Zod at boot (`apps/api/src/config.ts`).
See `.env.example`. Nothing sensitive is compiled into the web bundle: the SPA only knows
`VITE_API_BASE_URL`.
