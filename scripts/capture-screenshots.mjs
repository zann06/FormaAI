/**
 * Captures real screenshots of the running app for the README.
 *
 * Playwright is not a dependency of this repo (and adding it just for docs images
 * would pull a browser download into every CI run), so this drives the system Chrome
 * directly over the DevTools protocol using nothing but Node's built-in `fetch` and
 * `WebSocket`. Node 22 ships both, so there is nothing to install.
 *
 * Usage:
 *   node scripts/capture-screenshots.mjs [baseUrl]
 *
 * Output goes to docs/screenshots/*.png.
 *
 * Captures are taken at 2x so text is sharp, then downsampled to 1x before they are
 * committed: the images are displayed at 1x on GitHub, and keeping the 2x files made
 * the set ~5.5 MB. After capturing, run:
 *
 *   node scripts/capture-screenshots.mjs && node scripts/shrink-screenshots.mjs
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The API pins WEB_ORIGIN (default http://localhost:8099) and rejects another origin,
// so the browser has to use `localhost`. Headless Chrome on Windows may resolve
// `localhost` to ::1 while the container publishes only IPv4, which produced a folder
// of ERR_CONNECTION_REFUSED screenshots that looked like real pages. Keep `localhost`
// as the app origin and force the resolver to hand out 127.0.0.1.
const BASE = process.argv[2] ?? 'http://localhost:8099';
const HOST_RULES = 'MAP localhost 127.0.0.1, MAP *.localhost 127.0.0.1';
const EMAIL = process.env.FORMAI_EMAIL ?? 'zoeex@forma.ai';
const PASSWORD = process.env.FORMAI_PASSWORD;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'docs', 'screenshots');
const PROFILE = join(ROOT, '.chrome-profile');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) if (existsSync(candidate)) return candidate;
  throw new Error('No Chrome/Edge binary found. Set CHROME_PATH.');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal CDP client: connect, send commands, await matching replies. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
        else resolve(message.result);
      } else if (message.method) {
        this.events.push(message);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 45_000);
    });
  }
}

async function connect(port) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        const info = await res.json();
        const ws = new WebSocket(info.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.addEventListener('open', resolve, { once: true });
          ws.addEventListener('error', reject, { once: true });
        });
        return new Cdp(ws);
      }
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error('Chrome DevTools endpoint never came up');
}

/** Signed-in browser session driven through the page, not the API. */
async function makePage(cdp, { width = 1440, height = 900 } = {}) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params = {}) => cdp.send(method, params, sessionId);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: false,
  });
  return { send, sessionId, targetId };
}

async function goto(page, url, waitMs = 1200) {
  await page.send('Page.navigate', { url });
  await sleep(waitMs);
  // A refused connection still "navigates" and paints a Chrome error page, which
  // would otherwise be captured as if it were the app. Refuse to continue.
  const problem = await evaluate(
    page,
    `(() => {
      const text = document.body ? document.body.innerText || '' : '';
      if (/ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED/.test(text)) return 'connection refused';
      if (!document.querySelector('#root')) return 'no #root (not the app)';
      return null;
    })()`,
  );
  if (problem) throw new Error(`${url} did not load the app: ${problem}`);
}

async function evaluate(page, expression) {
  const result = await page.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`page eval failed: ${result.exceptionDetails.text} ${result.result?.description ?? ''}`);
  }
  return result.result?.value;
}

async function shoot(page, name, clip) {
  const params = { format: 'png', captureBeyondViewport: true };
  if (clip) params.clip = { ...clip, scale: 1 };
  const { data } = await page.send('Page.captureScreenshot', params);
  const path = join(OUT_DIR, `${name}.png`);
  await writeFile(path, Buffer.from(data, 'base64'));
  console.log(`  saved ${name}.png`);
}
/** Wait until the page has painted text and no skeletons remain. */
async function settle(page, extra = 900) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const ready = await evaluate(
      page,
      `document.readyState === 'complete' && document.body && document.body.innerText.trim().length > 40`,
    );
    if (ready) break;
    await sleep(250);
  }
  await sleep(extra);
}

async function scrollToBottomFlush(page) {
  // Lazy/animated sections only paint once scrolled into view.
  await evaluate(page, `window.scrollTo(0, document.body.scrollHeight); true`);
  await sleep(700);
  await evaluate(page, `window.scrollTo(0, 0); true`);
  await sleep(500);
}

async function signIn(page) {
  if (!PASSWORD) throw new Error('Set FORMAI_PASSWORD so the harness can sign in.');
  await goto(page, `${BASE}/signin`, 800);

  // Wait for the controlled inputs to exist. The SPA hydrates after the HTML shell
  // arrives, so querying immediately races the first render and used to report
  // "no form" against a blank #root.
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    ready = await evaluate(
      page,
      `!!(document.querySelector('#email') && document.querySelector('#password'))`,
    );
    if (ready) break;
    await sleep(250);
  }
  if (!ready) {
    const text = await evaluate(page, `document.body ? document.body.innerText.slice(0, 200) : ''`);
    throw new Error(`sign-in form never rendered. Page said: ${JSON.stringify(text)}`);
  }

  const ok = await evaluate(
    page,
    `(() => {
      const email = document.querySelector('#email');
      const pass = document.querySelector('#password');
      if (!email || !pass) return 'no form';
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(email, ${JSON.stringify(EMAIL)});
      email.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(pass, ${JSON.stringify(PASSWORD)});
      pass.dispatchEvent(new Event('input', { bubbles: true }));
      const btn = document.querySelector('form button[type="submit"]');
      if (!btn) return 'no button';
      btn.click();
      return 'submitted';
    })()`,
  );
  console.log(`  signin: ${ok}`);
  if (ok !== 'submitted') throw new Error(`sign-in could not be submitted: ${ok}`);

  // Wait for the router to actually leave /signin instead of sleeping a fixed time.
  let where = '/signin';
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(250);
    where = await evaluate(page, 'location.pathname');
    if (where && !where.startsWith('/signin')) break;
    const err = await evaluate(
      page,
      `(() => { const el = document.querySelector('[role="alert"]'); return el ? el.innerText : null; })()`,
    );
    if (err) throw new Error(`sign-in rejected: ${err}`);
  }
  console.log(`  after signin: ${where}`);
  if (!where || where.startsWith('/signin')) {
    throw new Error('Sign-in did not navigate away from /signin — check the credentials.');
  }
  return where;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  await rm(PROFILE, { recursive: true, force: true });

  const chrome = findChrome();
  console.log(`Chrome: ${chrome}`);
  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--remote-debugging-port=9222',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--hide-scrollbars',
      `--host-resolver-rules=${HOST_RULES}`,
      `--user-data-dir=${PROFILE}`,
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  try {
    const cdp = await connect(9222);
    const page = await makePage(cdp);

    console.log('Capturing public pages...');
    await goto(page, `${BASE}/`, 0);
    await settle(page, 1400);
    await scrollToBottomFlush(page);
    await shoot(page, 'landing', { x: 0, y: 0, width: 1440, height: 900 });

    // The hero on its own, then the closing band, so the README can show the fade.
    await shoot(page, 'landing-hero', { x: 0, y: 0, width: 1440, height: 620 });

    const cta = await evaluate(
      page,
      `(() => { const s = document.querySelector('#privacy'); if (!s) return null; const r = s.getBoundingClientRect(); return { y: Math.round(r.top + window.scrollY), h: Math.round(r.height) }; })()`,
    );
    if (cta) {
      await shoot(page, 'landing-cta', {
        x: 0,
        y: Math.max(0, cta.y - 60),
        width: 1440,
        height: Math.min(700, cta.h + 120),
      });
    }

    // The sign-in screen itself, captured while signed out.
    await goto(page, `${BASE}/signin`, 0);
    await settle(page, 700);
    await shoot(page, 'signin', { x: 0, y: 0, width: 1440, height: 900 });

    console.log('Signing in...');
    await signIn(page);

    console.log('Capturing signed-in pages...');
    await goto(page, `${BASE}/dashboard`, 0);
    await settle(page, 1200);
    // Guard against being bounced back to the marketing page: an unauthenticated
    // dashboard capture is the failure mode that silently produced wrong images.
    const heading = await evaluate(
      page,
      `(() => { const h = document.querySelector('main h1, h1'); return h ? h.innerText.trim() : ''; })()`,
    );
    console.log(`  dashboard heading: ${heading}`);
    if (!/dashboard|project/i.test(heading)) {
      throw new Error(`dashboard did not render (heading: ${JSON.stringify(heading)})`);
    }
    await shoot(page, 'dashboard', { x: 0, y: 0, width: 1440, height: 900 });

    const projectId = await evaluate(
      page,
      `(() => {
        const a = [...document.querySelectorAll('a[href*="/projects/"]')].find((el) => /\\/projects\\/[0-9a-f-]{36}/.test(el.getAttribute('href')));
        if (!a) return null;
        const m = a.getAttribute('href').match(/\\/projects\\/([0-9a-f-]{36})/);
        return m ? m[1] : null;
      })()`,
    );
    console.log(`  project: ${projectId ?? 'none'}`);
    if (!projectId) throw new Error('no project link on the dashboard to screenshot the workspace');

    await goto(page, `${BASE}/projects/${projectId}`, 0);
    await settle(page, 2200);
    // The chat panel persists its transcript (and therefore old error notices) per
    // project in localStorage, so a fresh profile can still show a stale failure
    // toast from an earlier session. Clear the stored transcript and reload so the
    // screenshot shows the workspace itself rather than history.
    await evaluate(
      page,
      `(() => { Object.keys(window.localStorage || {})
          .filter((key) => key.startsWith('formaai:chat:'))
          .forEach((key) => window.localStorage.removeItem(key));
        return true; })()`,
    );
    await goto(page, `${BASE}/projects/${projectId}`, 0);
    await settle(page, 2400);
    await scrollToBottomFlush(page);
    const panes = await evaluate(
      page,
      `document.querySelectorAll('main *').length`,
    );
    if (!panes || panes < 30) throw new Error('workspace page rendered almost nothing');
    await shoot(page, 'workspace', { x: 0, y: 0, width: 1440, height: 900 });

    await goto(page, `${BASE}/settings/providers`, 0);
    await settle(page, 1400);
    const providerHeading = await evaluate(
      page,
      `(() => { const h = document.querySelector('h1'); return h ? h.innerText.trim() : ''; })()`,
    );
    if (!/provider/i.test(providerHeading)) {
      throw new Error(`providers page did not render (heading: ${JSON.stringify(providerHeading)})`);
    }
    await shoot(page, 'providers', { x: 0, y: 0, width: 1440, height: 900 });

    await goto(page, `${BASE}/about`, 0);
    await settle(page, 1200);
    await shoot(page, 'about', { x: 0, y: 0, width: 1440, height: 900 });

    console.log(`\nDone. Images in ${OUT_DIR}`);
  } finally {
    child.kill();
    await sleep(600);
    await rm(PROFILE, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(`\nFAILED: ${error.message}`);
  process.exitCode = 1;
});
