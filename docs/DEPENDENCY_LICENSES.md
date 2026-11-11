# Dependency licenses

FormaAI itself is licensed **AGPL-3.0-or-later** (see `LICENSE.txt`). Third-party
dependencies must be compatible with that, and all current ones are.

Generated from the installed dependency tree (364 packages). Re-generate after
changing dependencies:

```bash
npm ls --all --json | node -e "..."   # or run your licence scanner of choice
npx license-checker --summary
```

---

## License distribution

| License | Packages |
| --- | --- |
| MIT | 315 |
| ISC | 17 |
| Apache-2.0 | 11 |
| BSD-3-Clause | 8 |
| BSD-2-Clause | 7 |
| MIT-0 | 1 |
| CC-BY-4.0 | 1 |
| BSD | 1 |
| BlueOak-1.0.0 | 1 |
| (MIT OR GPL-3.0-or-later) | 1 |
| (MIT AND Zlib) | 1 |

All are permissive or dual-licensed with a permissive option, and every one is
compatible with distributing FormaAI under the AGPL-3.0.

---

## Direct runtime dependencies

### API (`apps/api`)

| Package | License | Purpose |
| --- | --- | --- |
| `fastify` | MIT | HTTP server |
| `@fastify/cookie` | MIT | Cookie parsing |
| `@fastify/multipart` | MIT | File uploads |
| `@fastify/rate-limit` | MIT | Rate limiting |
| `drizzle-orm` | Apache-2.0 | SQL query builder / migrations |
| `pg` | MIT | PostgreSQL driver |
| `zod` | MIT | Schema validation |
| `pino` | MIT | Structured logging |
| `dotenv` | BSD-2-Clause | `.env` loading |
| `mammoth` | BSD-2-Clause | DOCX → text extraction |
| `pdfjs-dist` | Apache-2.0 | PDF text extraction and validation |

### Web (`apps/web`)

| Package | License | Purpose |
| --- | --- | --- |
| `react`, `react-dom` | MIT | UI framework |
| `react-router-dom` | MIT | Client-side routing |

### Shared libraries

| Package | Used by | License | Purpose |
| --- | --- | --- | --- |
| `fast-xml-parser` | `docx-engine` | MIT | OOXML parsing |
| `fflate` | `docx-engine` | MIT | ZIP read/write for DOCX |
| `zod` | `shared`, `ai-providers` | MIT | Schemas |

### Build and test only (not distributed)

`typescript` (Apache-2.0), `vite`, `vitest`, `tailwindcss`, `postcss`,
`autoprefixer`, `jsdom`, `@testing-library/*`, `drizzle-kit`, `tsx`,
`@vitejs/plugin-react`, `prettier`, `@types/*` — all MIT or Apache-2.0. These are
not part of the shipped runtime.

---

## Notable licenses worth understanding

**`jszip` — `(MIT OR GPL-3.0-or-later)`.** Dual licensed; FormaAI uses the **MIT**
option, which satisfies the AGPL. It arrives transitively (DOCX handling). No
obligation beyond attribution.

**`duck` — `BSD`.** A permissive BSD variant, transitively pulled in by the
drizzle toolchain. Not a copyleft concern.

**`caniuse-lite` — `CC-BY-4.0`.** Browser-compatibility data used by the CSS
toolchain at **build time**. CC-BY requires attribution; it is not linked into the
shipped application, and its data is not redistributed by FormaAI.

**`@csstools/color-helpers` — `MIT-0`.** MIT No Attribution; maximally permissive.

**`BlueOak-1.0.0`.** A permissive modern license (OSI approved), used by a
transitive dependency.

---

## System dependencies

| Component | License | How it is used |
| --- | --- | --- |
| **LibreOffice** (`libreoffice-writer`, in the API Docker image) | MPL-2.0 | Invoked as a **separate headless process** to convert DOCX → PDF. FormaAI does not link against it or modify it. Distributing the container image means distributing LibreOffice, so its MPL-2.0 notice and source-availability obligations apply to that component — the MPL is file-scoped and compatible with an AGPL-3.0 application that invokes it as a subprocess. |
| **PostgreSQL** (`postgres:16-alpine` image) | PostgreSQL License (permissive, BSD-like) | Separate database service |
| **nginx** (`apps/web` image) | BSD-2-Clause | Static file server and API proxy |
| DejaVu / Liberation fonts (API image) | Permissive font licenses (Bitstream Vera derivative / SIL OFL) | Rendering PDFs |

If you redistribute the Docker images, keep the license files that ship with these
components (`/usr/share/doc/*/copyright` in Debian-based images) and make the
LibreOffice source available as the MPL requires.

---

## Obligations summary

Shipping FormaAI (as source or container image) requires you to:

1. Provide the AGPL-3.0 license text and make the complete corresponding source of
   FormaAI available to network users (AGPL §13).
2. Preserve third-party copyright and permission notices for MIT/BSD/ISC/Apache-2.0
   dependencies.
3. If you distribute the API image, comply with the MPL-2.0 for LibreOffice (keep
   notices; if you modify LibreOffice, publish those modifications).

There are no dependencies under a license that would force FormaAI itself to adopt
a different license, nor any non-free or "source-available only" components.

---

## Checking this yourself

```bash
npx license-checker --production --summary        # runtime tree
npx license-checker --summary                     # including dev
```

Or simply:

```bash
npm audit --omit=dev --audit-level=high   # vulnerabilities, not licenses
```

This document was produced by walking `node_modules` and reading each package's
`license` field. If you add a dependency under a copyleft license, note it here and
in the pull request before merging.
