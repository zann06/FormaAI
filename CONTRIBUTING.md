# Contributing to FormaAI

Thanks for helping. This project has one non-negotiable rule:

> **Never claim something works if you have not run it.**

That means no placeholder features, no fake providers, no buttons that do nothing,
and no documentation describing behaviour that the code does not have. If you add
a limitation, document it. If a test does not cover something, say so in the pull
request rather than implying it does.

---

## Getting set up

```bash
git clone https://github.com/your-org/formaai.git
cd formaai
npm ci

# A disposable database for the API test suite
docker run -d --name formaai-pg-test -p 55432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres -e POSTGRES_DB=formaai \
  postgres:16-alpine

cp .env.example .env    # set DATABASE_URL; dev fallbacks cover the secrets
npm run db:migrate
npm run dev             # API on :8787, web on :5173
```

Requirements: Node 20.11+ (22 recommended), PostgreSQL 14+, and Docker if you want
to test PDF conversion.

---

## Before you open a pull request

Run all of these and make sure they pass:

```bash
npm run typecheck
npm run check:tenancy
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/formaai npm test
npm run build
```

If you changed anything involving the database, Docker, exports, or auth, also run
the end-to-end smoke test against a running instance:

```bash
docker compose up -d --build
node scripts/smoke-e2e.mjs http://localhost:8080
```

---

## Repository layout

```
apps/api          Fastify API: auth, projects, documents, mapping,
                  generation, exports, credentials, jobs, worker
apps/web          React SPA: landing, auth, dashboard, 3-pane workspace, settings
packages/shared   Zod schemas, constants, shared types
packages/docx-engine   Template analysis + surgical DOCX assembly
packages/ai-providers  OpenAI-compatible / Anthropic / Gemini adapters
scripts/          Tenancy guard, end-to-end smoke test
docs/             Architecture, decisions, API, deployment, testing, user guide
```

Read `docs/ARCHITECTURE.md` and `docs/TECHNICAL_DECISIONS.md` before making
structural changes — the ADRs explain why things are the way they are, including
deliberate deviations from the PRD.

---

## House rules

### Tenant isolation

Every query touching user-owned data **must** be scoped to the signed-in user.
`npm run check:tenancy` is a heuristic review aid; the authoritative check is
`apps/api/test/security.test.ts`. If you truly need a cross-user query (a
system-level job, for example), annotate it:

```ts
// tenancy-guard: allow worker claims jobs across users
```

and explain why in your pull request. New endpoints must return **404** for
resources owned by another user — never 403, which would confirm the resource
exists.

### Secrets

- Never log an API key, session token or password. Use the redaction list.
- Provider keys are stored only as ciphertext via `lib/crypto.ts`. Never add a
  column, response field or log line that carries plaintext.
- `.env` is gitignored; CI runs gitleaks. Keep it that way.

### AI behaviour

- Never let the model's output decide a file path, URL or credential.
- Treat all document text as untrusted data, never as instructions.
- Missing evidence must produce an explicit marker, not plausible-sounding prose.
- Conflicts between sources must be surfaced, not silently resolved.
- Any new prompt must keep document content inside explicit delimiters with a
  system-level statement that it is reference material.

### The DOCX template is authoritative

Exports are produced by copying the uploaded template and editing only
`word/document.xml`. Every other part must remain byte-identical; `pipeline.test.ts`
asserts this. Do not introduce a step that rebuilds the document from scratch.

### Tests

- Add tests for new behaviour, especially security-relevant behaviour.
- API tests use `createTestApp()` / `signUpUser()` from `test/helpers.ts` and must
  call `context.close()`.
- Do not mock the database. Use the real throwaway-schema database.
- If you fix a bug, add a test that fails without the fix (state this in the PR).

### Style

TypeScript strict mode is on. Run Prettier before committing:

```bash
npx prettier --write .
```

Prefer clear names over comments; comment the *why*, not the obvious *what*.

---

## Commit messages

Conventional commits, imperative mood, one logical change per commit:

```
feat(mapping): surface contradicting figures as conflicts
fix(export): copy bytes before handing them to pdf.js
docs(deployment): correct the key-rotation command
test(security): cover cross-user export download
```

Reference the area in the scope. If a commit is a workaround or has a known
limitation, say so in the body.

---

## Pull requests

Include:

1. **What changed and why.**
2. **How you verified it** — the exact commands you ran. "Tests pass" needs the
   command; anything you only checked by hand should say so.
3. **What is not covered** — limitations, untested paths, follow-up work.
4. Screenshots for visible UI changes.

Keep PRs focused. Separate refactors from behaviour changes.

---

## Reporting bugs

Include the version/commit, what you did, what you expected, what happened, and
any relevant API `requestId` from the error response. If the API logs show an
error, include it — but **redact API keys, secrets and document content**.

For security issues, do not open a public issue; see `SECURITY.md`.

---

## License

Contributions are accepted under the AGPL-3.0-or-later (see `LICENSE.txt`). By
opening a pull request you agree your contribution may be distributed under that
license.
