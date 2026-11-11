# API documentation

FormaAI's HTTP API is JSON over HTTPS, served under `/api`. The web app is a
single-page app served from the same origin and calls this API with
`credentials: 'include'`, so **there is no CORS configuration** — in development
Vite proxies `/api` to the API, in production nginx does.

- **Base URL:** `/api` (same origin as the web app)
- **Auth:** first-party, HTTP-only session cookie. No bearer tokens.
- **Content type:** `application/json` unless noted (`multipart/form-data` for
  uploads, binary for downloads).
- **IDs:** UUID v4 strings.

This document reflects the implemented routes. Every route listed here is
exercised by `scripts/smoke-e2e.mjs` and/or the integration tests in
`apps/api/test/`.

---

## Authentication model

`POST /api/auth/signup` and `POST /api/auth/signin` set an `HttpOnly` session
cookie. Send it on every subsequent request.

Sessions live in the database as hashed tokens, so they survive restarts and work
across API replicas. `GET /api/auth/session` returns the current user, or `401`
when unauthenticated.

**Isolation rule:** a resource that exists but belongs to another user returns
**404**, never 403 — the API does not confirm that someone else's project exists.

---

## Errors

Every error has the same envelope:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "title: Title is required",
    "requestId": "9ae5461c-5694-49b7-8d90-e92a1b697de1",
    "details": null
  }
}
```

Include `requestId` when reporting a problem; it matches the API log line.

| Code | HTTP | Meaning |
| --- | --- | --- |
| `BAD_REQUEST` | 400 | Malformed request |
| `VALIDATION_FAILED` | 422 | Body/params failed schema validation |
| `UNAUTHORIZED` | 401 | No or expired session |
| `FORBIDDEN` | 403 | Authenticated but not permitted (e.g. operator-only) |
| `NOT_FOUND` | 404 | Missing **or not owned by you** |
| `CONFLICT` | 409 | Illegal state transition |
| `PAYLOAD_TOO_LARGE` | 413 | Upload exceeds `MAX_FILE_MB` |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | File signature/MIME not accepted |
| `RATE_LIMITED` | 429 | Temporary rate limit hit |
| `QUOTA_EXCEEDED` | 429 | Daily quota exhausted |
| `PROVIDER_ERROR` | 502 | The user's AI provider failed or returned unusable output |
| `PROVIDER_NOT_CONFIGURED` | 409 | No usable provider credential for this request |
| `PDF_CONVERTER_NOT_CONFIGURED` | 409 | No LibreOffice/`CONVERTER_URL` configured |
| `JOB_CONFLICT` | 409 | Conflicting in-flight job |
| `INTERNAL` | 500 | Unexpected server error |

### File validation

Uploads are validated by **inspecting the bytes**, not by trusting the filename or
the client-supplied MIME type. A `.docx` that is not a real OOXML package is
rejected with `UNSUPPORTED_MEDIA_TYPE`.

---

## Auth

### `POST /api/auth/signup`

Rate limited to 10 requests / 10 min per IP.

```json
{ "email": "user@example.com", "password": "at-least-8-chars" }
```

`201` → `{ "user": { "id": "...", "email": "..." } }` and sets the session cookie.

Returns `409 CONFLICT` if the email is taken, or `403 FORBIDDEN` when
`REGISTRATION_ENABLED=false`.

### `POST /api/auth/signin`

Rate limited to 20 requests / 10 min per IP.

```json
{ "email": "user@example.com", "password": "..." }
```

`200` → `{ "user": ... }` and sets the session cookie. Wrong credentials return
`401 UNAUTHORIZED`; the message does not reveal whether the email exists.

### `POST /api/auth/signout`

Invalidates the current session. `200` → `{ "ok": true }`.

### `GET /api/auth/session`

`200` → `{ "user": { "id", "email", "role", "displayName" },
"fallbackCredentialId": null, "registrationEnabled": true }`, or `401` when signed
out. The web app uses this as its session bootstrap.

### `GET /api/auth/signup-availability`

Public. `200` → `{ "registrationEnabled": true }`. Lets the sign-up UI hide itself
when public registration is closed.

### `GET /api/auth/sessions`

Lists the user's active sessions (device hints, timestamps).

### `DELETE /api/auth/sessions`

Revokes every session for the user, including the current one.

### `PATCH /api/auth/password`

```json
{ "currentPassword": "...", "newPassword": "..." }
```

### `DELETE /api/auth/account`

Deletes the account and its data. Requires the current password.

---

## Provider credentials (BYOK)

The API key is **write-only**: it is encrypted with AES-256-GCM, bound to
`userId|credentialId` as associated data, and never returned. Responses include
only `keyLast4` and `keyFingerprint` so users can tell keys apart.

Provider types: `openai-compatible` (requires `baseUrl`), `anthropic`, `gemini`,
`dev-offline` (only when the server sets `ENABLE_DEV_PROVIDER=true`).

### `GET /api/provider-credentials`

```json
{
  "credentials": [
    { "id": "...", "displayName": "Work key", "providerType": "openai-compatible",
      "baseUrl": "https://api.openai.com/v1", "model": "gpt-4o-mini",
      "keyLast4": "a1b2", "keyFingerprint": "sha256:…", "isDefault": true,
      "createdAt": "..." }
  ],
  "supportedTypes": ["openai-compatible", "anthropic", "gemini"],
  "devProviderEnabled": false
}
```

### `POST /api/provider-credentials`

Rate limited to 30 / 10 min.

```json
{
  "displayName": "Work key",
  "providerType": "openai-compatible",
  "baseUrl": "https://api.openai.com/v1",
  "model": "gpt-4o-mini",
  "apiKey": "sk-...",
  "isDefault": true,
  "requestSettings": { "temperature": 0.2, "maxTokens": 2000 }
}
```

`201` → `{ "credential": { ... } }` (no plaintext key).

### `PATCH /api/provider-credentials/:credentialId`

Update metadata and optionally re-supply `apiKey` to replace the stored secret.

### `DELETE /api/provider-credentials/:credentialId`

`200` → `{ "ok": true }`.

### `POST /api/provider-credentials/:credentialId/test`

Rate limited to 20 / 5 min. Makes one real, minimal request to the provider.

`200` → `{ "result": { "ok": true, "latencyMs": 812, "model": "..." } }`.
On failure, `result.ok` is `false` with a sanitized `error` message — the user's
key is never echoed.

### `POST /api/provider-credentials/fallback`

```json
{ "fallbackCredentialId": "uuid-or-null" }
```

Sets (or clears) a fallback credential **for this user**. Fallback never crosses
accounts: one user's key is never used to serve another user's request.

---

## Projects

### `GET /api/projects?includeArchived=&search=`

`200` → `{ "projects": [ ... ] }`, newest activity first, up to 200.

Each summary carries the project's settings plus readiness flags:

```json
{
  "id": "...", "title": "Q3 Operations Review", "reportType": "quarterly-review",
  "language": "en", "tone": "formal", "audience": "executives",
  "targetLength": "medium", "status": "draft",
  "templateReady": true, "mappingReady": true,
  "documentCount": 1, "sourceCount": 2,
  "archivedAt": null, "lastActivityAt": "...", "createdAt": "...", "updatedAt": "..."
}
```

`documentCount` counts the template; `sourceCount` counts source documents.
Query params: `includeArchived=true`, `search=<title substring>`.

Creating more than the per-user active-project cap returns `429 QUOTA_EXCEEDED`.

### `POST /api/projects`

```json
{
  "title": "Q3 Operations Review",
  "reportType": "quarterly-review",
  "language": "en",
  "tone": "formal",
  "audience": "executives",
  "instructions": "Keep it under 4 pages.",
  "targetLength": "medium"
}
```

`title` is required (1–160 chars). `201` → `{ "project": { ... } }`.

### `GET /api/projects/:projectId`

`200` → `{ "project": { ... } }`.

### `PATCH /api/projects/:projectId`

Any subset of the create fields, plus `status`.

### `POST /api/projects/:projectId/archive` · `POST …/restore`

Lifecycle toggles. `200` → `{ "project": ... }`.

### `DELETE /api/projects/:projectId`

Deletes the project, its documents, exports and stored files.

---

## Documents and the template

Uploads are `multipart/form-data` with a `file` part and a `kind` part
(`template` or `source`). Accepted sources: PDF, DOCX, TXT. OCR is optional and
requires a server-side engine.

### `POST /api/projects/:projectId/documents`

```
file: <binary>
kind: template | source
```

`201` → `{ "document": { "id", "kind", "originalName", "mimeType", "sizeBytes",
"status", "createdAt" }, "jobId": "..." }`

Uploading a `template` enqueues `analyze_template`; a `source` enqueues
`extract_document`. Poll the job (below) to know when it is done. Max size is
`MAX_FILE_MB` (default 25); exceeding it returns `413 PAYLOAD_TOO_LARGE`.

### `GET /api/projects/:projectId/documents`

`200` → `{ "documents": [ ... ] }`.

### `GET /api/projects/:projectId/documents/:documentId/download`

Returns the original bytes with `content-disposition: attachment`.

### `DELETE /api/projects/:projectId/documents/:documentId`

### `POST /api/projects/:projectId/documents/:documentId/reextract`

Re-runs extraction (e.g. after enabling OCR).

### `GET /api/projects/:projectId/template`

```json
{
  "template": { "id": "...", "originalName": "template.docx", "sizeBytes": 20480,
                "status": "ready", "metadata": {...}, "createdAt": "..." },
  "structure": { "headings": [...], "placeholders": [...], "pageSetup": {...} },
  "sections": [ { "id": "...", "text": "Introduction", "level": 1, "order": 0,
                  "excluded": false, "styleId": "Heading1" } ],
  "latestJob": { "id": "...", "status": "succeeded", "stage": "done", "errorMessage": null }
}
```

`structure` also carries `warnings` — e.g. when the template uses manual bold
instead of heading styles, so no sections could be detected.

### `GET /api/projects/:projectId/sections`

`200` → `{ "sections": [ ... ] }` — the editable outline.

### `PATCH /api/projects/:projectId/sections/:sectionId`

Update one outline section. Any subset of:

```json
{ "heading": "Introduction", "required": true,
  "insertionStrategy": "after_heading", "placeholder": "content_introduction",
  "order": 0, "excluded": false, "instructions": "Keep it to one paragraph." }
```

`200` → `{ "section": { ... } }`. `placeholder: null` clears the binding.

### `POST /api/projects/:projectId/sections/reorder`

```json
{ "order": ["uuid", "uuid", "uuid"] }
```

An array of section IDs in the desired order. IDs must belong to this project.
`200` → `{ "ok": true }`.

### `POST /api/projects/:projectId/sections/manual`

Adds a section the analyzer did not detect (for templates without heading styles).

```json
{ "heading": "Appendix", "level": 1, "paragraphIndex": 12 }
```

`heading` is required; `level` defaults to 1, `paragraphIndex` to 0.

### `GET /api/projects/:projectId/sections/:sectionId/detail`

Full detail for one section: template text, mapped evidence, current content,
status, version.

---

## Mapping (evidence → sections)

Mapping is deterministic retrieval first (BM25 over extracted text), with an
optional AI refinement pass. It never invents citations: every match points at a
real passage in a real document.

### `POST /api/projects/:projectId/mapping`

```json
{ "useAi": true, "providerCredentialId": "uuid" }
```

Both optional. `useAi` defaults to `true` (deterministic retrieval first, then an
optional AI refinement pass); set `false` for retrieval only. `202` →
`{ "jobId": "..." }`, job kind `map_evidence`.

### `GET /api/projects/:projectId/mapping`

`200` → `{ "mappings": [...], "gaps": [...], "facts": [...] }`.

Each mapping describes one section and what the sources can support:

```json
{
  "sectionId": "...",
  "sectionKey": "sec2",
  "heading": "Financial Performance",
  "level": 1,
  "purpose": "Report the financial results of the period.",
  "requirements": ["Include the amounts and currency exactly as documented."],
  "evidence": [
    { "chunkId": "...", "documentName": "q3-review.txt", "page": null,
      "paragraphIndex": 2,
      "excerpt": "Revenue for Q3 reached 4.2 million dollars, up 12 percent." }
  ],
  "gaps": ["No dates were found in the sources for this section."],
  "conflicts": [],
  "contentPlan": ["Open with the headline revenue figure."],
  "coverage": "partial",
  "producedBy": "heuristic"
}
```

- `coverage`: `strong` | `partial` | `none`. `none` becomes an explicit
  `[MISSING: …]` marker at generation instead of invented prose.
- `conflicts`: contradictions detected across sources (e.g. two different figures
  for the same fact). They are surfaced to the user, never silently resolved.
- `producedBy`: `heuristic` (deterministic retrieval) or `ai` (refined).

`gaps` is a per-section summary (`sectionId`, `heading`, `required`, `coverage`,
`gaps`, `conflicts`) across non-excluded sections. `facts` lists extracted
factual claims with their source locations.

### `PATCH /api/projects/:projectId/mapping/:sectionId`

Correct a mapping by hand:

```json
{ "evidenceChunkIds": ["uuid"], "gaps": ["..."],
  "contentPlan": ["..."], "purpose": "...", "requirements": ["..."] }
```

`200` → `{ "ok": true }`. Every field is optional.

---

## Generation

### `POST /api/projects/:projectId/generate`

Rate limited to 12 / 10 min.

```json
{ "sectionIds": ["uuid"], "providerCredentialId": "uuid", "regenerateExisting": false }
```

All fields optional; empty body generates every non-excluded section. `202` →
`{ "jobId": "..." }`, job kind `generate_all`.

### `POST /api/projects/:projectId/sections/:sectionId/generate`

Rate limited to 60 / 10 min. One section at a time; a second concurrent request
for the same project returns `409 CONFLICT`.

```json
{ "instructions": "Shorten to two paragraphs.", "keepEdits": true }
```

### `GET /api/projects/:projectId/report`

```json
{
  "outline": [ { "id": "...", "text": "Introduction", "excluded": false, "order": 0 } ],
  "sections": {
    "<sectionId>": { "content": "...", "status": "draft", "revision": 3,
                     "wordCount": 412, "updatedAt": "...", "warnings": [] }
  },
  "versions": [ { "id": "...", "kind": "export", "label": "...", "createdAt": "..." } ]
}
```

`sections` holds the generated bodies and is populated lazily by generation;
`outline` always lists all template sections, including excluded ones.

### `PATCH /api/projects/:projectId/sections/:sectionId/content`

```json
{ "content": "...", "status": "validated", "baseVersion": 3 }
```

Status is one of `draft`, `needs_review`, `validated`, `final`. Sending
`baseVersion` enables optimistic concurrency: if someone else saved in the
meantime you get `409 CONFLICT` instead of silently overwriting their edit.

`200` → `{ "section": { "id", "content", "status", "revision", "wordCount",
"updatedAt" } }`.

---

## Versions

### `POST /api/projects/:projectId/versions`

Creates a named checkpoint of the current report.

### `GET /api/projects/:projectId/versions`

Lists checkpoints and export snapshots.

### `POST /api/projects/:projectId/versions/:versionId/restore`

Restores a checkpoint. This replaces current section content.

---

## Jobs

Long operations are asynchronous. A job moves through `queued` → `running` →
`succeeded` | `failed` | `cancelled`.

Job kinds: `extract_document`, `analyze_template`, `map_evidence`,
`generate_section`, `generate_all`, `assemble_docx`, `convert_pdf`, `cleanup`.

### `GET /api/projects/:projectId/jobs?kind=&status=&limit=`

`200` → `{ "jobs": [ { "id", "kind", "status", "stage", "progress",
"errorMessage", "attempts", "createdAt", "completedAt" } ] }`

### `GET /api/projects/:projectId/jobs/:jobId`

### `GET /api/jobs`

All jobs for the current user across projects.

### `POST /api/projects/:projectId/jobs/:jobId/cancel`

Cancels a queued or running job where possible.

### `POST /api/projects/:projectId/jobs/:jobId/retry`

Requeues a failed job (subject to `JOB_MAX_ATTEMPTS`).

---

## Exports

### `POST /api/projects/:projectId/exports`

Rate limited to 30 / 10 min.

```json
{ "format": "docx" }
```

`format` is `docx` or `pdf`. A version snapshot is taken automatically so the
export is reproducible.

`202` for `docx`:

```json
{ "exportId": "...", "jobId": "...", "format": "docx", "docxExportId": null, "pdfExportId": null }
```

`202` for `pdf` — note **both** artifacts are created, and the intermediate DOCX
is itself downloadable:

```json
{ "exportId": "<the DOCX artifact>", "jobId": "...", "format": "pdf",
  "docxExportId": "...", "pdfExportId": "<the PDF artifact>" }
```

When you want the PDF, download `pdfExportId`. Jobs `assemble_docx` and then
`convert_pdf` run in order.

If no converter is configured, the request fails with
`409 PDF_CONVERTER_NOT_CONFIGURED` and DOCX export continues to work.

### `GET /api/projects/:projectId/exports`

```json
{ "exports": [ { "id", "format", "status", "sizeBytes", "checksum",
                 "versionNumber", "createdAt" } ],
  "pdfAvailable": true, "retentionDays": 30 }
```

`pdfAvailable` tells the UI whether to offer PDF. Exports are pruned after
`EXPORT_RETENTION_DAYS`.

### `GET /api/projects/:projectId/exports/:exportId/download`

Binary. `content-type` is the DOCX or PDF MIME type; `cache-control: private,
no-store`. Ownership is verified before any bytes are read.

### `POST /api/projects/:projectId/exports/:exportId/convert-pdf`

Converts an already-assembled DOCX export. Idempotent entry point; `202` →
`{ "exportId", "jobId" }`.

---

## Usage and quotas

### `GET /api/usage`

`200` → `{ "events": [...], "summary": {...} }`. The summary covers the **last 30
days** and includes:

```json
{
  "windowDays": 30,
  "totals": { "requests": 42, "successes": 40, "failures": 2,
              "inputTokens": 152340, "outputTokens": 41200, "fallbacks": 0 },
  "byModel": [ { "model": "gpt-4o-mini", "providerType": "openai-compatible",
                 "requests": 42, "inputTokens": 152340, "outputTokens": 41200 } ]
}
```

`events` is the most recent 100 usage records for the signed-in user.

### `GET /api/usage/documents`

Storage usage for the current user against `USER_STORAGE_QUOTA_MB`.

---

## Health

### `GET /api/health` (public)

```json
{ "status": "ok", "time": "...",
  "features": { "pdfConversion": true, "ocr": false,
                "devProvider": false, "registration": true } }
```

### `GET /api/health/ready` (public)

`200` when the database is reachable; use for load-balancer readiness.

---

## Prompt-injection resistance

Source documents are untrusted input. The generation layer:

- treats extracted document text as data, never as instructions;
- wraps evidence in explicit delimiters with a system-level instruction that
  content inside them is reference material;
- validates structured model output against a schema and rejects/repairs
  malformed responses (`AI_STRUCTURED_REPAIR_ATTEMPTS`);
- never lets model output choose a storage path, URL, or credential.

If a source document tries to instruct the model to ignore its task or reveal the
prompt, this is treated as a content-quality issue only — it cannot escalate
privileges or cause facts outside the mapped evidence to be asserted.
