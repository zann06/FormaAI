#!/usr/bin/env node
/**
 * End-to-end smoke test against a *running* deployment.
 *
 * Starts a throwaway user and walks the whole product: sign up -> project ->
 * provider key -> template upload + analysis -> source upload + extraction ->
 * mapping -> generation -> DOCX export -> PDF export. It talks to the real HTTP
 * API through the web origin (nginx in Docker, or the Vite dev proxy).
 *
 *   node scripts/smoke-e2e.mjs http://localhost:8080
 *
 * Requires the API to be reachable and, for generation, a usable provider. Set
 * ENABLE_DEV_PROVIDER=true on the API to use the deterministic offline provider
 * (the default below) — no real API key is ever needed for this check.
 *
 * Nothing here is stubbed: every assertion inspects the real response bytes.
 */
import { randomUUID } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';

const BASE = (process.argv[2] ?? process.env.SMOKE_BASE_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
const PROVIDER = process.env.SMOKE_PROVIDER ?? 'dev-offline';
const API_KEY_SENTINEL = `smoke-secret-${randomUUID()}`;

let failures = 0;
const ok = (label, detail = '') => console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
const fail = (label, detail = '') => {
  failures += 1;
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
};
const check = (label, condition, detail = '') => (condition ? ok(label, detail) : fail(label, detail));

// --- cookie jar ------------------------------------------------------------
const cookies = new Map();
function storeCookies(res) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const i = pair.indexOf('=');
    if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');

async function request(method, path, { json, body, headers = {} } = {}) {
  const h = { ...headers };
  if (cookies.size) h.cookie = cookieHeader();
  let payload = body;
  if (json !== undefined) {
    h['content-type'] = 'application/json';
    payload = JSON.stringify(json);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers: h, body: payload });
  storeCookies(res);
  return res;
}

async function json(method, path, options) {
  const res = await request(method, path, options);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { res, data };
}

function upload(field, filename, mime, bytes, extra = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  form.append(field, new Blob([bytes], { type: mime }), filename);
  return form;
}

/** Builds a genuinely valid DOCX (OOXML package) with real heading styles. */
function makeDocx(headings) {
  const paragraphs = headings
    .map(
      (h) =>
        `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${h}</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>Body text for ${h}.</w:t></w:r></w:p>`,
    )
    .join('');
  // Real Word templates ship styles.xml; the analyser resolves heading levels
  // from it, so the fixture must include a genuine Heading 1 style.
  const stylesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>` +
    `<w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
    `</w:styles>`;
  return zipSync({
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
        `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
        `</Types>`,
    ),
    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
        `</Relationships>`,
    ),
    'word/_rels/document.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        `</Relationships>`,
    ),
    'word/styles.xml': strToU8(stylesXml),
    'word/document.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
        paragraphs +
        `<w:sectPr/></w:body></w:document>`,
    ),
  });
}

const isZip = (b) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const isPdf = (b) => b.length > 5 && Buffer.from(b.slice(0, 5)).toString('latin1') === '%PDF-';

/** Polls the project's job list until a job of `kind` reaches a terminal state. */
async function waitForJob(projectId, kind, timeoutMs = 180_000, jobId = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { res, data } = await json('GET', `/api/projects/${projectId}/jobs?kind=${kind}&limit=20`);
    if (res.status === 200) {
      const list = Array.isArray(data) ? data : (data?.jobs ?? []);
      const matching = list.filter((j) => j.kind === kind && (!jobId || j.id === jobId));
      // Prefer the most recently created job of this kind.
      const job = matching.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0];
      if (job && (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled')) return job;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

async function main() {
  console.log(`\nFormaAI end-to-end smoke test — ${BASE} (provider: ${PROVIDER})\n`);

  // --- 1. health -----------------------------------------------------------
  const health = await json('GET', '/api/health');
  check('health endpoint responds', health.res.status === 200, `status ${health.res.status}`);
  if (health.data?.features) {
    const f = health.data.features;
    console.log(`        pdfConversion=${f.pdfConversion} devProvider=${f.devProvider} registration=${f.registration}`);
  }

  // --- 2. auth -------------------------------------------------------------
  const email = `smoke-${randomUUID().slice(0, 8)}@example.test`;
  const password = 'smoke-test-password-123';
  const signup = await json('POST', '/api/auth/signup', { json: { email, password } });
  check('sign up', signup.res.status === 201, `status ${signup.res.status}`);

  const session = await json('GET', '/api/auth/session');
  check('session cookie established', session.data?.user?.email === email);

  // --- 3. project ----------------------------------------------------------
  const created = await json('POST', '/api/projects', { json: { title: 'Smoke Report' } });
  check('create project', created.res.status === 201, `status ${created.res.status}`);
  const projectId = created.data?.project?.id ?? created.data?.id;
  if (!projectId) {
    fail('project id returned', JSON.stringify(created.data).slice(0, 300));
    return finish();
  }

  // --- 4. provider credential ---------------------------------------------
  const cred = await json('POST', '/api/provider-credentials', {
    json: {
      displayName: 'Smoke credential',
      providerType: PROVIDER,
      model: resolveModel(),
      apiKey: API_KEY_SENTINEL,
      isDefault: true,
      ...(PROVIDER === 'openai-compatible' ? { baseUrl: process.env.SMOKE_BASE_URL_LLM ?? 'http://127.0.0.1:9/v1' } : {}),
    },
  });
  check('register provider credential', cred.res.status === 201, `status ${cred.res.status}`);
  check('API key is never echoed back', !JSON.stringify(cred.data ?? {}).includes(API_KEY_SENTINEL));

  // --- 5. template analysis ------------------------------------------------
  const tpl = await request('POST', `/api/projects/${projectId}/documents`, {
    body: upload(
      'file',
      'template.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      makeDocx(['Introduction', 'Financial Performance', 'Operations', 'Outlook']),
      { kind: 'template' },
    ),
  });
  check('upload template', tpl.status === 201, `status ${tpl.status}`);
  const tplJob = await waitForJob(projectId, 'analyze_template');
  check('template analysed', tplJob?.status === 'succeeded', `status ${tplJob?.status ?? 'timeout'}`);

  const structure = await json('GET', `/api/projects/${projectId}/template`);
  const sections = structure.data?.sections ?? [];
  check('template sections detected', sections.length > 0, `${sections.length} section(s)`);

  // --- 6. source document --------------------------------------------------
  const sourceText = [
    'Quarterly Operations Review',
    '',
    'Revenue for Q3 reached 4.2 million dollars, up 12 percent year over year.',
    'Average ticket handling time fell from 14 minutes to 9 minutes.',
    'Customer satisfaction rose to 91 percent.',
    'Hiring remains behind plan by 4 engineers.',
  ].join('\n');
  const src = await request('POST', `/api/projects/${projectId}/documents`, {
    body: upload('file', 'source.txt', 'text/plain', Buffer.from(sourceText, 'utf8'), { kind: 'source' }),
  });
  check('upload source document', src.status === 201, `status ${src.status}`);
  const srcJob = await waitForJob(projectId, 'extract_document');
  check('source text extracted', srcJob?.status === 'succeeded', `status ${srcJob?.status ?? 'timeout'}`);

  // --- 7. mapping ----------------------------------------------------------
  const map = await json('POST', `/api/projects/${projectId}/mapping`, { json: {} });
  check('start mapping', map.res.status === 202 || map.res.status === 200, `status ${map.res.status}`);
  const mapJob = await waitForJob(projectId, 'map_evidence');
  check('evidence mapped to sections', mapJob?.status === 'succeeded', `status ${mapJob?.status ?? 'timeout'}`);

  // --- 8. generation -------------------------------------------------------
  const gen = await json('POST', `/api/projects/${projectId}/generate`, { json: {} });
  check('start generation', gen.res.status === 202, `status ${gen.res.status}`);
  const genJob = await waitForJob(projectId, 'generate_all');
  check('report generated', genJob?.status === 'succeeded', `status ${genJob?.status ?? 'timeout'}`);

  const report = await json('GET', `/api/projects/${projectId}/report`);
  const bodies = Object.values(report.data?.sections ?? {});
  check('report has generated section bodies', bodies.length > 0, `${bodies.length} section(s)`);

  // --- 9. DOCX export (async: request -> job -> download) ------------------
  const docxReq = await json('POST', `/api/projects/${projectId}/exports`, { json: { format: 'docx' } });
  check('request DOCX export', docxReq.res.status === 202, `status ${docxReq.res.status}`);
  const docxExportId = docxReq.data?.exportId ?? docxReq.data?.id;
  const docxJob = await waitForJob(projectId, 'assemble_docx', 180_000, docxReq.data?.jobId ?? null);
  check('DOCX assembled', docxJob?.status === 'succeeded', `status ${docxJob?.status ?? 'timeout'}`);

  if (docxExportId) {
    const dl = await request('GET', `/api/projects/${projectId}/exports/${docxExportId}/download`);
    if (dl.status === 200) {
      const bytes = new Uint8Array(await dl.arrayBuffer());
      check('DOCX export is a real ZIP', isZip(bytes), `${bytes.length} bytes`);
    } else {
      fail('DOCX download', `status ${dl.status} ${(await dl.text()).slice(0, 200)}`);
    }
  } else {
    fail('DOCX export id returned', JSON.stringify(docxReq.data).slice(0, 300));
  }

  // --- 10. PDF export ------------------------------------------------------
  // A PDF request returns both artifacts: `exportId` is the intermediate DOCX,
  // `pdfExportId` is the actual PDF. Download the latter.
  const pdfReq = await json('POST', `/api/projects/${projectId}/exports`, { json: { format: 'pdf' } });
  if (pdfReq.res.status === 202) {
    const pdfExportId = pdfReq.data?.pdfExportId;
    // Two jobs are queued (assemble_docx, then convert_pdf); the response only
    // exposes the first job id, so poll for the newest convert_pdf job.
    const pdfJob = await waitForJob(projectId, 'convert_pdf');
    if (pdfJob?.status === 'succeeded' && pdfExportId) {
      const dl = await request('GET', `/api/projects/${projectId}/exports/${pdfExportId}/download`);
      const bytes = new Uint8Array(await dl.arrayBuffer());
      check('PDF export is a real PDF', dl.status === 200 && isPdf(bytes), `${bytes.length} bytes`);
    } else {
      // A deployment without LibreOffice/a converter must refuse loudly.
      const msg = JSON.stringify(pdfJob?.errorMessage ?? pdfJob?.error ?? '');
      const documented = msg.includes('PDF_CONVERTER_NOT_CONFIGURED');
      check(
        'PDF refused with documented reason (no converter configured)',
        documented,
        documented ? 'PDF_CONVERTER_NOT_CONFIGURED' : `status ${pdfJob?.status ?? 'timeout'} ${msg.slice(0, 200)}`,
      );
    }
  } else {
    const text = JSON.stringify(pdfReq.data);
    const documented = pdfReq.res.status === 409 && text.includes('PDF_CONVERTER_NOT_CONFIGURED');
    check('PDF refusal is documented', documented || pdfReq.res.status === 202, `status ${pdfReq.res.status}`);
  }

  // --- 11. isolation sanity ------------------------------------------------
  const saved = new Map(cookies);
  cookies.clear(); // now anonymous
  const anon = await json('GET', `/api/projects/${projectId}/report`);
  check('anonymous access rejected', anon.res.status === 401, `status ${anon.res.status}`);
  for (const [k, v] of saved) cookies.set(k, v);

  finish();
}

/** The dev provider ignores the model name; real providers need a real model id. */
function resolveModel() {
  return process.env.SMOKE_MODEL ?? (PROVIDER === 'dev-offline' ? 'dev-offline' : '');
}

function finish() {
  console.log(failures === 0 ? '\nAll smoke checks passed.\n' : `\n${failures} smoke check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nSmoke test crashed:', err);
  process.exit(1);
});
