# Self-hosting FormaAI

A short, task-oriented path from zero to a working instance on your own machine
or server. For production concerns — HTTPS, backups, upgrades, key rotation,
monitoring — read [`DEPLOYMENT.md`](./DEPLOYMENT.md).

FormaAI is **bring-your-own-key (BYOK)**: there is no platform AI key. You supply
your own provider key after signing up, and it is encrypted at rest with a key
only your instance holds.

---

## Option A — Docker (recommended)

**You need:** Docker Engine 24+ with Compose v2, ~2 GB RAM, ~10 GB disk.

```bash
git clone https://github.com/your-org/formaai.git
cd formaai
cp .env.example .env
```

Open `.env` and set these five values:

```ini
NODE_ENV=production
POSTGRES_PASSWORD=<choose a strong password>
SESSION_SECRET=<paste: openssl rand -hex 32>
CREDENTIAL_ENCRYPTION_KEY=<paste: openssl rand -base64 32>
WEB_ORIGIN=http://localhost:8080
```

Then:

```bash
docker compose up -d --build
docker compose ps        # wait for (healthy)
```

Open <http://localhost:8080>, create an account, and go to **Providers**.

> **It is meant to be yours alone.** Run one instance per person. Because the
> person who runs the server can read its database, do not share one instance
> with people whose data you should not be able to read. See
> [Trust model: one instance per person](../README.md#trust-model-one-instance-per-person).

### Add your AI provider

1. **Providers → Add provider.**
2. Choose the type:
   - **OpenAI-compatible** — works with OpenAI, Azure OpenAI, OpenRouter, Groq,
     Together, vLLM, Ollama and most gateways. Requires a **Base URL** and a model
     name.
   - **Anthropic** — Claude models.
   - **Gemini** — Google models.
3. Paste your API key and pick a model.
4. Press **Test connection** — it makes one real, minimal request with your key so
   you find out immediately if the URL or model is wrong.

The key is encrypted before it is stored and is never returned to the browser
afterwards; the UI only shows the last four characters.

### Make your first report

1. **New project** → give it a title.
2. **Upload a DOCX template.** This file defines the structure and formatting.
   FormaAI does not rebuild or flatten it — the export is a copy of your template
   with the content inserted. Real Word templates with heading styles work best.
3. Wait for **template analysis**; the detected sections appear in the middle pane.
   You can exclude sections or add your own.
4. **Add source documents** (PDF, DOCX, TXT) in the left pane. These are the only
   facts the AI is allowed to use.
5. **Map evidence** — FormaAI matches source passages to each section. Review the
   matches; sections with no evidence are flagged.
6. **Generate** — each section is drafted from its mapped evidence. Sections
   without evidence get an explicit `[MISSING: …]` marker instead of invented text.
7. Edit any section in the right pane, set its status (draft → needs review →
   validated → final), then **Export**.

DOCX export always works. PDF export needs LibreOffice, which the Docker image
includes.

---

## Option B — Local development

**You need:** Node 20.11+, a PostgreSQL 14+ database.

```bash
npm ci
cp .env.example .env      # then set DATABASE_URL
npm run db:migrate
npm run dev               # API on :8787, web on :5173
```

`npm run dev` runs API and web together; open <http://localhost:5173>. The Vite
dev server proxies `/api` to the API, so no CORS setup is needed.

In development the API falls back to a deterministic, clearly non-secret
encryption key and session secret. **Production refuses to start** without real
ones — that is deliberate.

To try the app without a real provider key in development only:

```ini
ENABLE_DEV_PROVIDER=true
```

This enables a deterministic offline provider that produces clearly-labelled
placeholder text. It is for tests and demos. **Never enable it on a public
instance.**

---

## Where your data lives

| Data | Location (Docker) | Notes |
| --- | --- | --- |
| Users, projects, sections, jobs, usage | `postgres` volume | Dump with `pg_dump` |
| Uploaded files, exports | `apidata` volume (`/app/data`) | Back this up **with** the database |

Exports are pruned after `EXPORT_RETENTION_DAYS` (default 30).

---

## Common first-run questions

**Do I need an OpenAI account?**
You need *some* supported provider. Any OpenAI-compatible endpoint works,
including a local model via Ollama or vLLM — set the Base URL to your local
server.

**Can several people use one instance?**
Technically yes. Accounts are isolated: every query is scoped to the signed-in
user, and another user's project returns `404`, not a permission error. Each user
brings their own key.

But the **recommended model is one instance per person**, not one shared
instance. The operator of a server has the database and the encryption key, so
they can read everything on it. Only share an instance with people whose data you
are entitled to see. Need real separation? Deploy separate instances — see
[Trust model](../README.md#trust-model-one-instance-per-person).

**Can I turn off public sign-up?**
Yes: `REGISTRATION_ENABLED=false`. Create accounts while it is open, then close it.

**Is my provider key safe if the database leaks?**
Keys are encrypted with AES-256-GCM using `CREDENTIAL_ENCRYPTION_KEY`, which lives
in your `.env`, not in the database. An attacker with a database dump alone cannot
read them. If the environment *and* the database leak together, rotate the key and
have users rotate their provider keys.

**Does it send my documents anywhere else?**
Only to the AI provider you configured, as prompt context for the sections being
generated. There is no telemetry and no third-party analytics in this codebase.

---

## Troubleshooting quick reference

| Problem | Fix |
| --- | --- |
| `docker compose up` fails with "required variable ... missing" | `.env` missing or `POSTGRES_PASSWORD` unset |
| API container restarting | Secrets invalid or database unreachable — `docker compose logs api` |
| "Test connection" fails | Wrong Base URL, model name, or key. For OpenAI-compatible gateways the URL usually ends in `/v1` |
| PDF export not offered / fails | No converter. Use the Docker image (ships LibreOffice) or set `CONVERTER_URL` |
| Sections come out empty or `[MISSING]` | No source evidence mapped to them. Add sources, or write the content yourself |
| Template sections not detected | The DOCX uses manual bold formatting instead of heading styles. Add sections manually in the outline pane |

More detail in [`DEPLOYMENT.md`](./DEPLOYMENT.md#9-troubleshooting).
