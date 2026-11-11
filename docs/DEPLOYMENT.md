# Deployment

FormaAI ships as three containers: **PostgreSQL**, the **API** (Node + LibreOffice),
and the **web** app (nginx serving the SPA and proxying `/api`). This guide takes
you from a clean server to a working instance, then through the operational tasks
you will actually need: secrets, backups, upgrades, key rotation and monitoring.

> Everything below is the same configuration used by the automated end-to-end
> smoke test (`scripts/smoke-e2e.mjs`). If your deployment passes that script,
> uploads, AI generation, DOCX export and PDF export all work.

---

## 1. Requirements

| Resource | Minimum | Notes |
| --- | --- | --- |
| CPU | 2 vCPU | LibreOffice PDF conversion is the heaviest step |
| RAM | 2 GB | Each concurrent conversion can use a few hundred MB |
| Disk | 10 GB | Files + exports; exports are pruned after `EXPORT_RETENTION_DAYS` |
| Software | Docker Engine 24+ with Compose v2 | `docker compose version` |

The API image is ~1.1 GB on disk because it includes LibreOffice. If you do not
need PDF export you can still run it — PDF requests return a clear
`PDF_CONVERTER_NOT_CONFIGURED`-style failure instead of a fake file.

---

## 2. Install

```bash
git clone https://github.com/your-org/formaai.git
cd formaai

# 1. Create the environment file
cp .env.example .env
```

Generate the two required secrets and paste them into `.env`:

```bash
openssl rand -base64 32   # -> CREDENTIAL_ENCRYPTION_KEY
openssl rand -hex 32      # -> SESSION_SECRET
```

Then set at minimum:

```ini
NODE_ENV=production
POSTGRES_PASSWORD=<a strong password>
SESSION_SECRET=<from openssl rand -hex 32>
CREDENTIAL_ENCRYPTION_KEY=<from openssl rand -base64 32>
WEB_ORIGIN=https://reports.example.com
COOKIE_SECURE=true
```

Start it:

```bash
docker compose up -d --build
docker compose ps          # wait until api and web report (healthy)
```

Open `http://<host>:8080` (or your `WEB_PORT`). Sign up — the first account is a
normal user. FormaAI is bring-your-own-key: each user adds their own provider
credential under **Providers** before generating anything.

### Verify the install

```bash
# Liveness and readiness
curl -fsS http://localhost:8080/api/health
curl -fsS http://localhost:8080/api/health/ready

# Full product flow against the real deployment (needs ENABLE_DEV_PROVIDER=true)
node scripts/smoke-e2e.mjs http://localhost:8080
```

`smoke-e2e.mjs` creates a throwaway user, runs a complete report, and asserts
that the DOCX is a real ZIP and the PDF a real PDF. Run it against staging, not
against production data you care about.

---

## 3. HTTPS

Terminate TLS in front of the web container with Caddy, Traefik, or nginx. Two
rules matter:

1. **Set `COOKIE_SECURE=true`** once you serve HTTPS, so session cookies carry the
   `Secure` flag.
2. **Set `TRUST_PROXY=true`** so the API reads the real client IP from
   `X-Forwarded-For` for rate limiting and audit logs.

Example Caddyfile (automatic certificates):

```caddy
reports.example.com {
    reverse_proxy localhost:8080
}
```

Example nginx:

```nginx
server {
    listen 443 ssl http2;
    server_name reports.example.com;

    ssl_certificate     /etc/letsencrypt/live/reports.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/reports.example.com/privkey.pem;

    client_max_body_size 30m;          # >= MAX_FILE_MB

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;       # PDF conversion can be slow
    }
}
```

---

## 4. Secrets you must protect

| Secret | Purpose | If leaked |
| --- | --- | --- |
| `CREDENTIAL_ENCRYPTION_KEY` | Encrypts every user's AI API key at rest (AES-256-GCM) | All stored provider keys are decryptable. Rotate **and** have users rotate their provider keys. |
| `SESSION_SECRET` | Peppers session-token hashes | Attackers can forge session tokens. Rotate; this signs everyone out. |
| `POSTGRES_PASSWORD` | Database access | Full data access. Rotate the DB password and `DATABASE_URL`. |

Never commit `.env`. It is already in `.gitignore`; the CI pipeline also runs
`gitleaks` to catch accidental secrets.

> **The operator can read this instance's data.** Holding
> `CREDENTIAL_ENCRYPTION_KEY` *and* database access means you can decrypt every
> key on your instance. Encryption at rest defends against a stolen database
> dump or a leaked backup, not against the administrator. Design your deployment
> accordingly: **one instance per person or organisation**, and only give shell
> and `.env` access to people who are meant to see the data. See
> [Trust model](../README.md#trust-model-one-instance-per-person).

### Rotating the credential-encryption key

Rotation re-encrypts every stored API key inside a single transaction, so a crash
cannot leave a mix of old- and new-key rows. It was verified end-to-end against a
real database.

```bash
# The rotation script ships as TypeScript and runs via tsx, so run it with the
# dev dependencies present (npm ci --include=dev) or from a checkout, not from
# the slim runtime image. Point DATABASE_URL at the live database.

# 1. Dry run: proves every row decrypts with the old key. Commits nothing.
OLD_CREDENTIAL_ENCRYPTION_KEY="$OLD_KEY" \
NEW_CREDENTIAL_ENCRYPTION_KEY="$NEW_KEY" \
DATABASE_URL="$DATABASE_URL" \
  npm run rotate-key --workspace @formaai/api -- --dry-run

# 2. Real rotation
OLD_CREDENTIAL_ENCRYPTION_KEY="$OLD_KEY" \
NEW_CREDENTIAL_ENCRYPTION_KEY="$NEW_KEY" \
DATABASE_URL="$DATABASE_URL" \
  npm run rotate-key --workspace @formaai/api

# 3. Put the new key in .env and restart
docker compose up -d api
```

Exit code `0` means everything was re-encrypted; `1` means nothing was committed.

---

## 5. Backups

Two things must be backed up together: the **database** and the **storage
volume**. A database dump alone is useless because it points at files that are
gone, and files alone have no ownership or metadata.

### Database

```bash
docker compose exec -T postgres \
  pg_dump -U "${POSTGRES_USER:-formaai}" -d "${POSTGRES_DB:-formaai}" -Fc \
  > formaai-$(date +%F).dump
```

### Uploaded files and exports (local storage)

```bash
docker run --rm \
  -v formaai_apidata:/data:ro \
  -v "$PWD":/backup \
  alpine tar czf /backup/formaai-data-$(date +%F).tar.gz -C /data .
```

If you use `STORAGE_DRIVER=s3`, back up the bucket with your provider's tooling
instead and keep the same retention as the database.

### Restore

```bash
# 1. Restore the database
docker compose exec -T postgres \
  pg_restore -U formaai -d formaai --clean --if-exists < formaai-2025-01-31.dump

# 2. Restore files
docker run --rm \
  -v formaai_apidata:/data \
  -v "$PWD":/backup \
  alpine sh -c 'tar xzf /backup/formaai-data-2025-01-31.tar.gz -C /data'

docker compose restart api
```

Test a restore on a scratch instance before you need one for real. An untested
backup is a guess.

### Retention

- Export artifacts are pruned after `EXPORT_RETENTION_DAYS` (default 30).
- Keep database + file backups for at least as long as your longest retention
  window, otherwise restored rows can reference deleted files.
- The `cleanup` job kind removes expired exports; it runs in the worker.

---

## 6. Upgrades

```bash
git pull
docker compose build
docker compose up -d          # migrations run automatically on API start
docker compose ps             # confirm healthy
```

The API applies pending migrations on boot (`runMigrations` in `apps/api/src/index.ts`)
before it starts accepting traffic. Take a backup first — this is the one moment
where a bad migration is hard to undo.

To roll back: check out the previous tag, rebuild, and restore the matching
backup. Migrations are forward-only; there are no down-migrations.

---

## 7. Configuration that most deployments change

| Variable | Why you would set it |
| --- | --- |
| `REGISTRATION_ENABLED=false` | Private instance: closes public sign-up |
| `ADMIN_EMAILS` | Grants the operator view (usage/health). Operators get **no** access to other users' documents |
| `MAX_FILE_MB`, `MAX_PDF_PAGES` | Tighter limits for untrusted users |
| `DAILY_AI_REQUEST_QUOTA`, `DAILY_EXPORT_QUOTA` | Per-user abuse caps |
| `WORKER_CONCURRENCY` | Raise for more parallel AI calls; watch provider rate limits |
| `STORAGE_DRIVER=s3` | Multi-instance or ephemeral-disk deployments |
| `CONVERTER_URL` | Offload PDF conversion to a separate service |

**`ENABLE_DEV_PROVIDER` must stay `false` in production.** The offline provider
emits placeholder text; it exists so the test suite and demos need no real key.

### Scaling beyond one API container

The job queue is database-backed (`FOR UPDATE SKIP LOCKED`), so several API
containers can share one database safely:

- Set `STORAGE_DRIVER=s3` — local disk is per-container.
- Either keep `WORKER_ENABLED=true` on every replica (each claims distinct jobs),
  or run exactly one dedicated worker and set `WORKER_ENABLED=false` on the API
  replicas. Both are correct; the first is simpler.
- Sticky sessions are not required: sessions are database-backed tokens in a
  cookie, not in-memory state.

---

## 8. Monitoring

- `GET /api/health` — liveness plus which optional features are enabled
  (`pdfConversion`, `ocr`, `devProvider`, `registration`).
- `GET /api/health/ready` — database reachable; use this for load-balancer
  readiness.
- Logs are JSON (pino). Set `LOG_LEVEL=debug` temporarily when diagnosing.
- Watch job failures: `GET /api/jobs` (authenticated) lists them with
  `status: "failed"` so you can surface them in your own dashboards.

`docker compose logs -f api` is the fastest first stop for any problem.

---

## 9. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| API restarts in a loop at start | Missing/invalid `SESSION_SECRET` or `CREDENTIAL_ENCRYPTION_KEY`, or unreachable database. `docker compose logs api` shows the exact validation error. |
| `POSTGRES_PASSWORD is missing a value` | `.env` not found in the directory you ran `docker compose` from, or the variable is unset. |
| Uploads rejected with 413 | `client_max_body_size` in your reverse proxy is below `MAX_FILE_MB`. |
| PDF export fails, DOCX works | LibreOffice missing from the image, or `LIBREOFFICE_BIN`/`CONVERTER_URL` unset. Check `/api/health` → `features.pdfConversion`. |
| Sign-in loops or cookie not set | Serving over HTTPS with `COOKIE_SECURE=false`, or vice versa; also check `WEB_ORIGIN` matches the browser origin. |
| `429 RATE_LIMITED` | Per-route or global rate limit hit. Tune `RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW`. |
| Provider errors `502 PROVIDER_*` | The user's own key/base URL/model is wrong — it is their credential, not a platform key. Ask them to use **Test connection** on the Providers page. |

---

## 10. What has and has not been verified

Verified by automation in this repository:

- Both images build, and `docker compose up` yields healthy containers.
- The complete user journey (sign-up → template analysis → source extraction →
  mapping → generation → DOCX export → PDF export) through nginx, on the real
  Docker stack, producing a real 15.6 KB `%PDF-1.6` file with extractable text.
- Migrations applied automatically on API start.

Not exercised by the automated suite — validate in your own environment:

- HTTPS termination with a specific reverse proxy and real certificates.
- `STORAGE_DRIVER=s3` against a real bucket.
- `CONVERTER_URL` against a real remote converter.
- Behaviour under sustained multi-instance load.

See `docs/TESTING.md` for how to run the suites, and
`docs/SELF_HOSTING.md` for a shorter, task-oriented setup guide.
