<div align="center">

# FormaAI

**Template-driven report generation that refuses to invent facts.**

Upload a Word template, attach your sources, and get a finished, editable report
that keeps your template's exact structure and formatting — exported as DOCX or PDF.

[![CI](https://github.com/zann06/FormaAI/actions/workflows/ci.yml/badge.svg)](https://github.com/zann06/FormaAI/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE.txt)
[![Tests](https://img.shields.io/badge/tests-456%20passing-brightgreen.svg)](#testing)
[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](#)

[Quick start](#quick-start-docker) · [How it works](#how-it-works) · [Trust model](#trust-model-one-instance-per-person) · [Architecture](#architecture) · [Testing](#testing) · [Contributing](#contributing)

</div>

---

Open source, self-hostable and **bring-your-own-key**. There is no platform-wide
API key, no central server and no telemetry. The intended deployment is **one
instance per person** — you keep your own database, your own encryption key and
your own files. Multiple accounts within one instance are still fully isolated
from each other.

## Why it exists

Most "AI writes your report" tools optimise for a plausible-looking page. That is
the wrong target for anything that gets submitted, graded or audited, because a
fluent invented figure is worse than a visible gap.

FormaAI is built the other way round: **every sentence must be traceable to a
source you attached.** When the sources cannot support a claim, the report says so
in place — `[MISSING: …]` or `[PERLU DICEK: …]` — instead of filling the space
with something that reads well and is false.

---

## How it works

1. **Analyse your template.** A real Word template's headings, styles, tables and
   page setup are detected — not flattened into plain text.
2. **Extract your sources.** PDF, DOCX, TXT, Markdown and image documents are
   parsed into passages. Scanned pages and images go through OCR.
3. **Map evidence to sections.** Passages are matched to the sections they support
   with deterministic BM25 retrieval, then optionally refined by the model. Gaps and
   contradictions are surfaced, not hidden.
4. **Draft section by section.** Only from mapped evidence. A section with no
   evidence gets an explicit marker — never an invented fact, figure, date or name.
5. **Review and edit.** A chat-and-preview workspace: ask for changes, resolve
   remaining markers against the sources, edit any section, snapshot versions.
6. **Export.** An editable DOCX built from a *copy of your template* (every part
   except `word/document.xml` stays byte-identical), plus a PDF converted from that
   final DOCX.

### The verification markers

This is the feature that matters most, so it is worth being precise about how it
behaves:

| Marker | Meaning | What to do |
| --- | --- | --- |
| `[MISSING: …]` | The sources contained nothing that supports this spot | Add a source, or write it yourself |
| `[PERLU DICEK: …]` | Text was written, but it is derived or uncertain and needs a human check | Confirm the value against the cited source |

- They are **intentional** and survive into the export, so you can find them in
  Word with search. They are not an error state to be hidden.
- The export summary tells you **exactly how many remain** and where.
- The **resolve-gaps** action re-reads your sources and fills only the markers it
  can corroborate: a text value must appear in the evidence, an image-derived
  value must both name an attached image *and* be backed by evidence text.
  Placeholder-looking values (`0.0.0.0`, `n/a`, …) are always rejected, and
  anything uncertain or derived is discarded rather than guessed.
- OCR lookalike glyphs (`0`/`o`, `1`/`l`, `5`/`S`, …) are folded **for comparison
  only**, so a number copied from a scan still matches its source.

### Cover dates

Cover-page date fields are a common source of wrong metadata, so the rules are
explicit:

- A label meaning **"generated on"** or **"submission date"** fills with the
  **export date**, in Indonesian long form and in local time (e.g.
  `13 November 2026`). Re-export tomorrow and it reads the 14th — it always
  follows the day you export.
- A label meaning **deadline / `tenggat` / `batas pengumpulan`** is **never**
  auto-filled, because an export day is not a deadline. The export reports it
  instead of writing a wrong date.
- If you state a date yourself ("tanggal pengumpulan 20 November 2026"), that
  overrides the export date, because you know better than the clock.

---

## The design commitments

Enforced in code and covered by tests, not aspirations:

- **The template is authoritative.** Exports edit only the document body and
  preserve every other part of the DOCX byte-for-byte.
- **No fabrication.** Sections without evidence get a visible marker. Source
  conflicts are shown to you, never silently resolved.
- **Your key, your data.** Provider keys are encrypted at rest with AES-256-GCM and
  bound to their owner, so a stolen database dump alone cannot decrypt them. Keys
  are write-only over the API and are never returned by any endpoint.
- **Strict tenant isolation.** Another user's resource returns `404`, never `403`,
  so its existence is not even confirmed.
- **Honest failure.** A missing PDF converter, a bad provider key or an unreachable
  provider produces a specific, documented error — never a fake file and never a
  silent fallback to someone else's key.

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

**Within** a single instance, multiple accounts are fully isolated: every query is
scoped to the authenticated `user_id`, a foreign resource returns `404`, and
provider keys are encrypted with AAD bound to `userId|credentialId` so ciphertext
cannot be transplanted between accounts.

### What this protects against — and what it does not

Be clear about the boundary:

| Threat | Protected? |
| --- | --- |
| User A reading user B's projects on the same instance | **Yes** — scoped queries, 404 on foreign IDs, verified by `apps/api/test/security.test.ts` |
| User A using user B's provider key | **Yes** — write-only, never returned, AAD-bound ciphertext |
| A stolen database dump alone | **Yes** — keys stay encrypted without `CREDENTIAL_ENCRYPTION_KEY` |
| The **operator** of an instance reading that instance's data | **No** — whoever runs the server holds the database and the encryption key |
| A compromised host (root on the server) | **No** — same reasoning; protect the host and encrypt your backups |

Those last two rows are the honest limit of any self-hosted, server-side-encrypted
application. It is also why the recommended model is *one instance per person*: it
keeps the number of people who can read your data at one.

If you need physical isolation between tenants, deploy **separate instances** (one
Compose stack and one database per tenant). Do not try to get that from account
separation inside a single instance.

---

## Quick start (Docker)

```bash
git clone https://github.com/zann06/FormaAI.git
cd FormaAI
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

Open <http://localhost:8080>, create an account, then add your AI provider key
under **Settings → AI providers**. The **About** page shows what the running
instance can actually do (PDF export, OCR, registration), read live from the API.

Want to try it without a provider key? For local experimentation only, set
`ENABLE_DEV_PROVIDER=true` — it generates clearly-labelled placeholder text. Never
enable it on a public instance.

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
| **Offline (dev)** | Deterministic stub that never touches the network; only when `ENABLE_DEV_PROVIDER=true` |

Each credential has a **Test connection** button that makes one real request, so
misconfigured URLs and model names fail immediately rather than halfway through a
draft.

---

## Architecture

A monorepo on npm workspaces:

```
apps/api                Fastify 5 · Drizzle · PostgreSQL · pino
  auth, projects, documents, template, mapping, generation,
  exports, credentials, usage, jobs + DB-backed worker
apps/web                React 19 · Vite · Tailwind
  landing, auth, dashboard, chat + preview workspace, settings, about
packages/shared         Zod schemas, constants, shared types
packages/docx-engine    Template analysis + surgical DOCX assembly
packages/ai-providers   Provider adapters, retries, structured-output repair
```

Notable choices:

- Plain PostgreSQL with first-party cookie sessions — no external auth service.
- A database-backed job queue using `FOR UPDATE SKIP LOCKED` with boot recovery —
  no Redis required, and safe to run several API replicas.
- AES-256-GCM credential vault with AAD binding to owner + credential id.
- Hybrid mapping: deterministic BM25 retrieval, then optional AI refinement.
- Document pipeline in TypeScript rather than Python — a deliberate, documented
  deviation from the original PRD.
- PDF via LibreOffice (`LIBREOFFICE_BIN`) or a remote converter (`CONVERTER_URL`).
  Without either, PDF export fails loudly and DOCX keeps working.

### Project layout

```
apps/api/src/services/       one folder per concern (template, mapping, generation, export …)
apps/api/src/routes/         one router per resource; all scoped to the session user
packages/docx-engine/src/    ZIP-level DOCX read/write; no Word installation needed
apps/web/src/components/     shared UI (Dialog, Drawer, Select, panes, chat)
apps/web/src/pages/          one file per screen
```

---

## Testing

```bash
npm run typecheck
npm run check:tenancy
npm test              # 456 tests across 5 workspaces
npm run build
```

| Workspace | Tests | What it pins down |
| --- | --- | --- |
| `@formaai/api` | 283 (+3 skipped) | auth, tenancy isolation, export rules, cover dates, gap resolution, jobs |
| `@formaai/web` | 103 | chat action planning, workspace flows, providers, auth, dashboard, about, polling isolation |
| `@formaai/docx-engine` | 43 | template analysis, byte-preserving assembly, section/placeholder binding |
| `@formaai/ai-providers` | 20 | adapters, retries, structured-output repair |
| `@formaai/shared` | 7 | schema and constant contracts |

The API suite runs against a real PostgreSQL database with a throwaway schema per
test file, so tenancy and constraint behaviour are tested for real rather than
mocked.

`scripts/smoke-e2e.mjs` drives a **running deployment** end-to-end and asserts the
exported DOCX is a real ZIP and the PDF a real PDF:

```bash
node scripts/smoke-e2e.mjs http://localhost:8080
```

---

## Production notes

- **Run one instance per person.** See [trust model](#trust-model-one-instance-per-person).
- **Keep `CREDENTIAL_ENCRYPTION_KEY` offline and backed up.** Losing it makes stored
  provider keys unrecoverable; leaking it defeats the vault.
- **Terminate TLS in front of the app.** Sessions are `HttpOnly` cookies; set
  `WEB_ORIGIN` to the public origin and keep `NODE_ENV=production`.
- **Protect backups.** An encrypted-dump is still a full copy of your projects.
- **Do not enable `ENABLE_DEV_PROVIDER` publicly.** It exists for local testing.

---

## Known limitations

Documented deliberately rather than discovered later:

- **PDF templates are not supported** as editable templates — DOCX only.
- New **table rows** are not generated; tables are filled via `{{placeholders}}`.
- **Footnotes, tracked changes, SmartArt** and content-control structure are not
  edited (placeholder text inside content controls *is* replaced).
- **XLSX / CSV / PPTX** are not extracted in this version.
- **Image sources** (`.png`, `.jpg`, `.jpeg`) are read with OCR only — the model
  never sees the picture, so nothing is inferred from a chart or photo that OCR
  could not put into words. OCR text can be inexact; the UI says so on the
  document. Without OCR configured, an image is rejected with
  `OCR_NOT_CONFIGURED` rather than indexed as empty. The Docker image bundles
  Tesseract (English + Indonesian); on other setups set `TESSERACT_BIN` or
  `OCR_ENDPOINT`.
- **PDF export** needs LibreOffice or a converter; without it, PDF export is
  refused with `PDF_CONVERTER_NOT_CONFIGURED` while DOCX continues to work.
- No multi-factor authentication.
- Rate limits are per instance; multiple replicas multiply the effective limit.

---

## Contributing

The project's rule is simple: **never claim something works if you have not run
it.** A pull request that says "tested" should come with the command and its
output; a fix without a test that fails before it is usually not merged.

- `npm run typecheck && npm test` must pass before you open a PR.
- Add a test that fails without your change, then make it pass.
- New AI features must keep the no-fabrication contract: if the evidence is not
  there, emit a marker.
- Security issues go to the maintainer privately via the GitHub profile, **not**
  the public issue tracker.

---

## License

[AGPL-3.0-or-later](LICENSE.txt). All dependencies are permissive and compatible
with the AGPL.

If you run a modified version of FormaAI as a network service, the AGPL requires
you to offer its complete corresponding source to your users.
