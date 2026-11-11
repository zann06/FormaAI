#!/usr/bin/env node
/**
 * Tenancy guard.
 *
 * Every query that touches user-owned data MUST constrain on `user_id`. This is
 * a cheap *static review aid*: it scans the API source for Drizzle queries
 * against tenant-owned tables and fails when neither the query statement nor the
 * surrounding function mentions a user scoping value.
 *
 * It is heuristic by design — it cannot prove correctness. The authoritative
 * guarantee is the integration suite (`apps/api/test/security.test.ts`), which
 * attempts real cross-user reads and writes.
 *
 * Opt out for a specific statement with:
 *   // tenancy-guard: allow <reason>
 * placed on or above the statement.
 *
 * Exit code 0 = clean, 1 = suspicious query found.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['apps/api/src'];

/** Tables whose rows are owned by a single user. */
const TENANT_TABLES = [
  'projects',
  'documents',
  'extractedChunks',
  'documentChunks',
  'templateSections',
  'sectionMappings',
  'reportSections',
  'reportVersions',
  'exportArtifacts',
  'providerCredentials',
  'aiUsageEvents',
  'processingJobs',
  'factClaims',
  'sessions',
];
const TENANT_TABLE_RE = new RegExp(`\\b(${TENANT_TABLES.join('|')})\\b`);

/** Files where cross-tenant access is inherent (auth internals, db plumbing, worker). */
const ALLOWED_PATHS = [
  'apps/api/src/services/auth/',
  'apps/api/src/db/',
  'apps/api/src/lib/',
  // The background worker claims jobs by ID and derives the owning user from the
  // job row itself (see `executeJob`), so its job queries are system-level.
  'apps/api/src/services/worker/',
];

/**
 * Functions that are intentionally system-wide (queue recovery, worker
 * claiming, cleanup). They are identified by name in the enclosing method.
 */
const SYSTEM_FUNCTIONS = [
  'recoverStaleJobs',
  'claimNextJob',
  'runOnce',
  'purgeExpired',
  'deleteAllFiles',
  'deleteExpired',
  'cleanup',
  'cleanupExpired',
];

const OPT_OUT = /tenancy-guard:\s*allow/i;
// Scoping can appear directly, via a spread `conditions` array, or via a helper
// that builds the predicate. All of these are accepted as "scoped".
const USER_PREDICATE =
  /\buserId\b|\buser_id\b|ctx\.userId|user\.userId|\.userId\b|\$\.userId|ownerId|\bconditions\b|assertOwned|assertProject/;

/**
 * A line that starts (or continues) a Drizzle chain. Service-method calls such
 * as `documents.delete(user, id)` must NOT match, so we require either a dot
 * leading the line followed by a query builder method, or a `db.`/`tx.` receiver.
 */
const CHAIN_LINE =
  /^\s*\.(select|selectDistinct|insert|update|delete)\s*\(|\b(?:db|tx|client|this\.db|txn)\s*\.\s*(select|selectDistinct|insert|update|delete)\s*\(/;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else if (/\.ts$/.test(entry) && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** Returns the function body-ish text around a line (for scoping heuristics). */
function enclosingFunctionName(lines, index) {
  for (let i = index; i >= 0 && i > index - 120; i -= 1) {
    const match = /(?:async\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(lines[i] ?? '');
    if (match && lines[i].includes('(')) {
      if (/\b(async|function)\b|^\s*(?:public|private|protected)?\s*[A-Za-z_$][\w$]*\s*\(/.test(lines[i])) {
        return match[1];
      }
    }
  }
  return null;
}

/**
 * Collects the full statement starting at `start`, following chained lines until
 * a line ends with `;`. This is why the earlier version produced false positives:
 * a `userId` predicate 20 lines into a chain was outside its short window.
 */
function statementFrom(lines, start) {
  let depth = 0;
  const collected = [];
  for (let i = start; i < lines.length && i < start + 60; i += 1) {
    const line = lines[i];
    collected.push(line);
    for (const char of line) {
      if (char === '(' || char === '{' || char === '[') depth += 1;
      else if (char === ')' || char === '}' || char === ']') depth -= 1;
    }
    if (/;\s*$/.test(line) && depth <= 0) break;
  }
  return collected.join('\n');
}

function scanFile(file) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (ALLOWED_PATHS.some((prefix) => rel.startsWith(prefix))) return [];

  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const findings = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (!CHAIN_LINE.test(lines[i])) continue;

    const statement = statementFrom(lines, i);
    if (!TENANT_TABLE_RE.test(statement)) continue;
    if (USER_PREDICATE.test(statement)) continue;

    const context = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
    if (OPT_OUT.test(context) || OPT_OUT.test(statement)) continue;

    const fnName = enclosingFunctionName(lines, i);
    if (fnName && SYSTEM_FUNCTIONS.includes(fnName)) continue;

    findings.push({
      file: rel,
      line: i + 1,
      code: lines[i].trim(),
      fnName: fnName ?? '(module scope)',
    });
  }
  return findings;
}

let total = 0;
for (const dir of SCAN_DIRS) {
  let files;
  try {
    files = walk(join(ROOT, dir));
  } catch {
    continue;
  }
  for (const file of files) {
    for (const finding of scanFile(file)) {
      total += 1;
      console.error(`${finding.file}:${finding.line}  query without user scoping (in ${finding.fnName})`);
      console.error(`    ${finding.code}`);
      console.error('    -> add a userId condition or annotate "// tenancy-guard: allow <reason>"');
    }
  }
}

if (total > 0) {
  console.error(`\nTenancy guard: ${total} suspicious query block(s) found.`);
  process.exit(1);
}
console.log(`Tenancy guard: no unscoped tenant queries detected across ${SCAN_DIRS.join(', ')}.`);
