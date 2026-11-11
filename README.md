# FormaAI

**Template-driven AI report generation.** Upload a DOCX template, add your source
documents, and get a finished, editable report that keeps your template's exact
structure and formatting — exported as DOCX or PDF.

Open source, self-hostable and **bring-your-own-key**: you supply your own AI
provider credentials. There is no platform-wide API key, no central server and no
telemetry. The intended deployment is **one instance per person** — you keep your
own database, your own encryption key and your own files (see
[Trust model](#trust-model-one-instance-per-person)). Multiple accounts within one
instance are still isolated from each other.

[![CI](https://github.com/your-org/formaai/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/formaai/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE.txt)

---

## What it does

1. **Analyse your template.** A real Word template's headings, styles, tables and
   page setup are detected — not flattened.
2. **Extract your sources.** PDF, DOCX and TXT documents are parsed into passages.
3. **Map evidence to sections.** Each passage is matched to the section it supports,
   with gaps and contradictions surfaced rather than hidden.
4. **Draft section by section.** Only from mapped evidence. No evidence produces an
   explicit `[MISSING: …]` marker — never invented facts, figures, dates or names.
5. **Review and edit.** A three-pane workspace with per-section status, history and
   version snapshots.
6. **Export.** An editable DOCX built from a *copy of your template* (every part
   except `word/document.xml` stays byte-identical), plus PDF converted from that
   final DOCX.

---

## The design commitments

These are enforced in code and covered by tests, not just aspirations:

- **The template is authoritative.** Exports edit only the document body and
  preserve everything else byte-for-byte.
- **No fabrication.** Sections without evidence get a visible marker. Source
  conflicts are shown to the user, never silently resolved.
- **Your key, your data.** Provider keys are encrypted at rest with AES-256-GCM and
  bound to their owner, so a stolen database dump alone cannot decrypt them. Keys
  are write-only over the API.
- **Strict tenant isolation.** Another user's resource returns `404`, never `403`,
  so its existence is not even confirmed.
- **Honest failure.** Missing PDF converter, bad provider key or unreachable
  provider produce a specific, documented error — never a fake file or silent
  fallback to someone else's key.

---

## Trust model: one instance per person

The intended deployment is **one instance per person (or per organisation)**,
running on your own machine or your own server. That is what makes the privacy
story simple: *you* hold the database, the encryption key and the files, and
nobody else does.

```
                       not provided by this project
                    ┌──────────────────────────────┐
                    │  no central server           │
                    │  no shared database          │
                    │  no platform AI key          │
                    │  no telemetry                │
                    └──────────────────────────────┘

  Alice                        Bob                         Carol
  ┌──────────────┐             ┌──────────────┐            ┌──────────────┐
  │ her instance │             │ his instance │            │ her instance │
  │ her database │             │ his database │            │ her database │
  │ her keys     │             │ his keys     │            │ her keys     │
  └──────────────┘             └──────────────┘            └──────────────┘
```

There is no "someone else's database" to leak into, because each deployment is
independent. If you self-host for yourself, you are the only operator.

**Within** a single instance, multiple accounts are fully isolated from each
other: every query is scoped to the authenticated `user_id`, a foreign resource
returns `404`, and provider keys are encrypted with AAD bound to
`userId|credentialId` so ciphertext cannot be transplanted between accounts.

### What this protects against — and what it does not

Be clear about the boundary:

| Threat | Protected? |
| --- | --- |
| User A reading user B's projects on the same instance | **Yes** — scoped queries, 404 on foreign IDs, verified by `apps/api/test/security.test.ts` |
| User A using user B's provider key | **Yes** — write-only, never returned, AAD-bound ciphertext |
| A stolen database dump alone | **Yes** — keys stay encrypted without `CREDENTIAL_ENCRYPTION_KEY` |
| The **operator** of an instance reading that instance's data | **No** — whoever runs the server holds the database and the encryption key |
| A compromised host (root on the server) | **No** — same reasoning; protect the host, encrypt your backups |

That last row is the honest limit of any self-hosted, server-side-encrypted
application. It is also why the recommended model is *one instance per person*:
it keeps the number of people who can read your data at one.

If you need physical isolation between tenants, deploy **separate instances**
(one Compose stack and one database per tenant). Do not try to get that from
account separation inside a single instance.

---

## Quick start (Docker)

```bash
git clone https://github.com/your-org/formaai.git
cd formaai
cp .env.example .env
```

Set these in `.env`:

```ini
NODE_ENV=production
POSTGRES_PASSWORD=<a strong password>
SESSION_SECRET=<openssl rand -hex 32>
CREDENTIAL_ENCRYPTION_KEY=<openssl rand -base64 32>
WEB_ORIGIN=http://localhost:8080
```

```bash
docker compose up -d --build
```

Open <http://localhost:8080>, create an account, then add your AI provider key under
**Settings → Providers**.

Want to try it without a provider key? For local experimentation only, set
`ENABLE_DEV_PROVIDER=true` — it generates clearly-labelled placeholder text. Never
enable it on a public instance.

Full instructions: **[Self-hosting guide](docs/SELF_HOSTING.md)** ·
**[Deployment guide](docs/DEPLOYMENT.md)**

### Local development

```bash
npm ci
npm run db:migrate      # needs DATABASE_URL
npm run dev             # API :8787, web :5173
```

Requires Node 20.11+ and PostgreSQL 14+.

---

## Supported AI providers

| Provider type | Notes |
| --- | --- |
| **OpenAI-compatible** | Any endpoint speaking the OpenAI chat API: OpenAI, Azure OpenAI, OpenRouter, Groq, Together, vLLM, Ollama, most gateways. Requires a Base URL. |
| **Anthropic** | Claude models |
| **Gemini** | Google models |

Each credential has a **Test connection** button that makes one real request, so
misconfigured URLs and model names fail immediately.

---

## Architecture

A monorepo on npm workspaces:

```
apps/api                Fastify 5 · Drizzle · PostgreSQL · pino
  auth, projects, documents, template, mapping, generation,
  exports, credentials, usage, jobs + DB-backed worker
apps/web                React 19 · Vite · Tailwind
  landing, auth, dashboard, 3-pane workspace, settings
packages/shared         Zod schemas, constants, shared types
packages/docx-engine    Template analysis + surgical DOCX assembly
packages/ai-providers   Provider adapters, retries, structured-output repair
```

Notable choices, all recorded as ADRs in
[`docs/TECHNICAL_DECISIONS.md`](docs/TECHNICAL_DECISIONS.md):

- Plain PostgreSQL with first-party cookie sessions (no external auth service).
- A database-backed job queue using `FOR UPDATE SKIP LOCKED`, with boot recovery —
  no Redis required, and safe to run several API replicas.
- AES-256-GCM credential vault with AAD binding to owner + credential id.
- Hybrid mapping: deterministic BM25 retrieval, then optional AI refinement.
- Document pipeline in TypeScript rather than Python — a deliberate, documented
  deviation from the original PRD.
- PDF via LibreOffice (`LIBREOFFICE_BIN`) or a remote converter (`CONVERTER_URL`);
  without either, PDF export fails loudly and DOCX keeps working.

More: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
[`docs/SECURITY_THREAT_MODEL.md`](docs/SECURITY_THREAT_MODEL.md)

---

## Testing

```bash
npm run typecheck
npm run check:tenancy
npm test              # 97 tests across 5 workspaces
npm run build
```

The API suite runs against a real PostgreSQL database with a throwaway schema per
test file. `scripts/smoke-e2e.mjs` drives a **running deployment** end-to-end and
asserts the exported DOCX is a real ZIP and the PDF a real PDF.

```bash
node scripts/smoke-e2e.mjs http://localhost:8080
```

Details and the explicit list of what is *not* covered:
[`docs/TESTING.md`](docs/TESTING.md).

---

## Documentation

| Document | Contents |
| --- | --- |
| [User guide](docs/USER_GUIDE.md) | How to use the app, step by step |
| [Self-hosting](docs/SELF_HOSTING.md) | Get an instance running |
| [Deployment](docs/DEPLOYMENT.md) | HTTPS, backups, upgrades, key rotation, monitoring |
| [API documentation](docs/API_DOCUMENTATION.md) | Every endpoint, error codes, contracts |
| [Testing](docs/TESTING.md) | Test suites, how to run them, what is not covered |
| [Architecture](docs/ARCHITECTURE.md) | Components and data flow |
| [Technical decisions](docs/TECHNICAL_DECISIONS.md) | ADRs and their rationale |
| [Security threat model](docs/SECURITY_THREAT_MODEL.md) | Threat analysis |
| [Implementation plan](docs/IMPLEMENTATION_PLAN.md) | Phase-by-phase status |
| [Dependency licenses](docs/DEPENDENCY_LICENSES.md) | Third-party license audit |
| [PRD](docs/PRD.md) | Original product requirements |

---

## Known limitations

Documented deliberately rather than discovered later:

- **PDF templates are not supported** as editable templates — DOCX only.
- New **table rows** are not generated; tables are filled via `{{placeholders}}`.
- **Footnotes, tracked changes, SmartArt** and content-control structure are not
  edited (placeholder text inside content controls is replaced).
- **XLSX / CSV / PPTX / images** are not extracted in this version.
- **OCR** requires an external engine (`TESSERACT_BIN` or `OCR_ENDPOINT`).
- **PDF export** needs LibreOffice or a converter; without it, PDF export is refused
  with `PDF_CONVERTER_NOT_CONFIGURED` while DOCX continues to work.
- No multi-factor authentication.
- Rate limits are per instance; multiple replicas multiply the effective limit.

---

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first. The project's rule is simple:
**never claim something works if you have not run it.** Security issues go to the
private process in [`SECURITY.md`](SECURITY.md), not the public issue tracker.

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).

---

## License

[AGPL-3.0-or-later](LICENSE.txt). Third-party licenses are audited in
[`docs/DEPENDENCY_LICENSES.md`](docs/DEPENDENCY_LICENSES.md); all dependencies are
permissive and compatible with the AGPL.

If you run a modified version of FormaAI as a network service, the AGPL requires you
to offer its complete corresponding source to your users.
