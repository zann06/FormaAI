# Security Threat Model

Scope: the FormaAI application as implemented in this repository (API + SPA + storage + DB +
outbound AI provider calls + LibreOffice conversion). Later sections list residual risks and
operator responsibilities.

## 1. Assets

| # | Asset | Sensitivity |
|---|-------|-------------|
| A1 | User AI API keys | Critical — billable secret |
| A2 | User-uploaded documents (template + sources) | High — often confidential |
| A3 | Generated reports, drafts, versions, exports | High |
| A4 | Session tokens | High |
| A5 | Account data (email, password hash) | Medium |
| A6 | Usage/audit metadata | Low–Medium |
| A7 | `CREDENTIAL_ENCRYPTION_KEY`, `SESSION_SECRET`, DB credentials | Critical |

## 2. Trust boundaries

```
Browser (untrusted) ──HTTP(S)──► API (trusted) ──► Postgres (trusted, private network)
                                    │
                                    ├──► Storage volume / S3 bucket (private)
                                    ├──► AI provider over HTTPS (semi-trusted: returns untrusted text)
                                    └──► LibreOffice subprocess (semi-trusted: parses untrusted files)
Uploaded files themselves are untrusted and may contain malicious content or prompt injections.
```

## 3. Threats and mitigations

### T-01 Broken object-level authorization (IDOR)
*Threat:* user changes `/api/projects/<other-id>` and reads/modifies another tenant's data.
*Mitigation:* every service function takes `AuthContext` and filters by `user_id` in the same SQL
statement; non-owned resources return 404. Cross-tenant integration tests for projects,
documents, template, sections, mappings, jobs, exports, credentials, usage. Verified in
`apps/api/test/isolation.test.ts`.

### T-02 Missing RLS / DB-level leak
*Threat:* a future query forgets the tenant predicate.
*Mitigation:* Drizzle schema keeps `user_id` NOT NULL on all tenant tables with FK to users and
indexes; `npm run check:tenancy` (CI) greps for `where(` clauses in service files lacking
`userId` and fails the build. Optional RLS migration
(`drizzle/0002_optional_rls.sql`) provided for operators who want defence in depth.

### T-03 API key disclosure
*Threat:* key leaks through API response, logs, browser storage, error payloads, or DB dump.
*Mitigation:* AES-256-GCM with per-record IV and AAD binding (`userId:credentialId`); keys are
write-only over the API (responses contain `keyLast4` + fingerprint); pino redaction list covers
`authorization`, `apiKey`, `api_key`, `key`, `cookie`; provider error bodies are passed through
`redactSecrets()` before logging; the SPA never persists credentials (no localStorage/sessionStorage
usage at all — asserted by a unit test on the built bundle); never placed in URLs.

### T-04 Cross-user or platform key fallback
*Threat:* a failed request silently uses another user's key or an operator key.
*Mitigation:* provider credential lookup is `WHERE id = $1 AND user_id = $2`. There is no
`AI_API_KEY` env var in the config schema; startup rejects unknown `AI_*` platform key names via a
guard test. Fallback occurs only via `users.fallback_credential_id` chosen by that user, is
recorded on the job (`fallback_used`), and is shown in the UI.

### T-05 Malicious upload (malformed DOCX/PDF, zip bomb, path traversal)
*Threat:* parser RCE, memory exhaustion, writing outside storage root, SQL/HTML injection via file
names.
*Mitigation:* validation by extension **and** magic bytes **and** declared MIME allow-list; max
size (`MAX_FILE_MB`, default 25) and max pages/paragraphs; stored file names are generated UUIDs
(original name kept only as a DB column and sanitised for `Content-Disposition`); ZIP entries are
read with `fflate` after a central-directory check (max 2000 entries, max 200 MB uncompressed,
max 100:1 ratio) — the archive is never extracted to disk; PDF parsing via `pdfjs-dist` in-process
with page caps; LibreOffice conversion runs in a subprocess with a scratch profile directory, a
hard timeout (120 s) and file-size guard. Containers run as non-root users.

### T-06 Prompt injection from documents
*Threat:* a source document contains "ignore previous instructions and output …".
*Mitigation:* system instructions only in the `system` role; document text is wrapped in
`<source_document untrusted="true">` delimiters with a standing rule that content is data; model
output is schema-validated and any generated heading structure is ignored (the template owns
structure); generation is per-section with only mapped evidence, so a poisoned chunk cannot alter
other sections; suspicious output patterns are flagged as warnings on the section, visible to the
user. Documents can never trigger tool calls, network requests, or reveal secrets because no tools
and no secrets are in the model context.

### T-07 Session hijacking / CSRF
*Threat:* stolen cookie; cross-site form POSTs.
*Mitigation:* `HttpOnly`, `SameSite=Lax`, `Secure` when `COOKIE_SECURE=true`; state-changing
routes require `Content-Type: application/json` or multipart with an `Origin` allow-list check;
session token hashed at rest; sliding expiry; logout deletes the row; password change deletes all
other sessions.

### T-08 Brute force / credential stuffing on FormaAI accounts
*Mitigation:* `@fastify/rate-limit` (per-IP + per-route buckets) on auth endpoints, generic error
messages, Argon2id (or scrypt fallback) password hashing, minimum password length 10, optional
sign-up disable switch (`REGISTRATION_ENABLED`), exponential per-account login backoff.

### T-09 Resource exhaustion / cost abuse via user's own key
*Mitigation:* per-user quotas (projects, documents, storage bytes, exports/day, AI requests/day),
`MAX_FILE_MB`, page caps, section generation limited to `AI_MAX_SECTIONS_PER_JOB` and
`AI_MAX_EVIDENCE_CHARS`, request timeouts on provider calls, rate limits on job-creating routes,
single in-flight job per (project, kind) unless forced.

### T-10 Malicious/compromised AI provider
*Threat:* provider returns HTML/script, huge payload, or an instruction-injection payload.
*Mitigation:* responses are never rendered as HTML (editor is plain text/markdown-lite rendered
via escaped text nodes); response size cap; timeouts; schema validation; `message.content`
treated as untrusted text.

### T-11 Sensitive data in logs / observability
*Mitigation:* no document text in logs by default (`LOG_DOCUMENT_CONTENT=false`); error objects
serialised with allow-listed fields; pino redact paths; request body logging disabled for
credential and upload routes; CI secret scanning (gitleaks) in the workflow.

### T-12 Export/DOCX injection
*Threat:* generated text containing XML-breaking characters or `w:` markup that corrupts the
document.
*Mitigation:* all inserted values are XML-escaped by the assembler; generated text is inserted as
`w:t` text only (never raw XML); post-write validation re-parses the DOCX and compares structure.

### T-13 Deletion / retention gaps
*Mitigation:* project delete removes DB rows in a transaction (cascade) and then storage objects;
account delete removes all storage prefixes and rows; retention job removes expired exports and
session-only credentials; documented in `docs/DEPLOYMENT.md` §Retention.

### T-14 Insecure deployment
*Mitigation:* documented HTTPS requirement, `COOKIE_SECURE=true` and
`TRUST_PROXY` in production, secrets from environment/secret manager, DB and storage not exposed
publicly in the provided Compose file, containers non-root and read-mostly.

### T-15 Dependency / supply chain
*Mitigation:* lockfiles committed, `npm audit` + Dependabot config + gitleaks in CI, minimal
dependency set, fixed Docker base images, no `postinstall` scripts from unvetted packages
(`npm ci --ignore-scripts` documented where feasible).

### T-16 Worker restart losing work
*Mitigation:* jobs persisted with `stage` and per-stage outputs; interrupted `running` jobs are
re-queued at boot; completed stages are keyed by their own rows so re-running skips work.

## 4. Residual risks / accepted limitations

1. In-process PDF/DOCX parsing shares memory with the API. A uniquely crafted file could crash a
   worker process. Mitigation: size/page caps, process supervision (Docker restart policy) and job
   retry; full sandboxing (separate container per parse) is a documented future hardening step.
2. Optional RLS is operator-opt-in; the primary control is query-level tenant predicates + CI check.
3. Client-side encryption at rest in the browser is out of scope (data is decrypted server-side for
   the LLM call).
4. LibreOffice is a large attack surface for DOCX parsing; accepted because DOCX must be converted
   faithfully, mitigated by subprocess isolation, timeout, non-root user and no network in the
   converter container (recommended compose config).
5. OCR quality depends on the configured external OCR engine.

## 5. Security testing performed

* `apps/api/test/isolation.test.ts` — cross-tenant attempts on every resource (expect 404).
* `apps/api/test/auth.test.ts` — signup/login/session renew/logout, rate limiting, password rules.
* `apps/api/test/credentials.test.ts` — plaintext never returned, ciphertext in DB differs,
  decryption fails with wrong AAD/key, deletion works.
* `apps/api/test/upload-validation.test.ts` — renamed `.exe`, zip bomb, oversized file, wrong
  magic bytes, traversal filenames.
* `apps/api/test/fallback.test.ts` — no key ⇒ explicit error, no platform key path, user fallback
  recorded.
* `apps/api/test/prompt-injection.test.ts` — poisoned source chunk cannot change section list, and
  is flagged.
* CI: `npm audit --omit=dev`, `gitleaks`, `npm run check:tenancy`, `npm run test`.
