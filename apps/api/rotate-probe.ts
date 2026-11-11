import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createDb } from './src/db/client.js';
import { loadConfig } from './src/config.js';
import { aadFor, decryptSecret, encryptSecret } from './src/lib/crypto.js';

const DATABASE_URL = 'postgres://postgres:postgres@localhost:55432/formaai';
const OLD = Buffer.alloc(32, 11).toString('base64');
const NEW = Buffer.alloc(32, 22).toString('base64');
const base = './data/rotate-probe';
const storageArg = process.env.STORAGE_DIR ?? './data/test-storage';

const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL, STORAGE_DRIVER: 'local', STORAGE_DIR: storageArg, LOG_LEVEL: 'silent' } as any);
const h = createDb(cfg);
const { pool } = h;

// Seed a user + credential encrypted with OLD key.
const userId = randomUUID();
const credId = randomUUID();
await pool.query("insert into users (id,email,password_hash,display_name) values ($1,$2,'x','rot') on conflict do nothing", [userId, `rot-${userId}@x.test`]);
const enc = encryptSecret('sk-rotate-me', Buffer.alloc(32,11), aadFor(userId, credId), 1);
await pool.query("insert into provider_credentials (id,user_id,display_name,provider_type,model,api_key_ciphertext,api_key_iv,api_key_tag,key_version,key_last4,key_fingerprint) values ($1,$2,'r','dev-offline','m',$3,$4,$5,1,'e-me','fp')",
  [credId, userId, enc.ciphertext, enc.iv, enc.tag]);
await h.close();

// Dry run first.
const dry = execFileSync('npx', ['tsx','scripts/rotate-credential-key.ts','--dry-run'], { env: { ...process.env, DATABASE_URL, CREDENTIAL_ENCRYPTION_KEY: OLD, OLD_CREDENTIAL_ENCRYPTION_KEY: OLD, NEW_CREDENTIAL_ENCRYPTION_KEY: NEW }, encoding: 'utf8', shell: true });
console.log('DRY:', dry.trim());

// Real rotation.
const real = execFileSync('npx', ['tsx','scripts/rotate-credential-key.ts'], { env: { ...process.env, DATABASE_URL, CREDENTIAL_ENCRYPTION_KEY: OLD, OLD_CREDENTIAL_ENCRYPTION_KEY: OLD, NEW_CREDENTIAL_ENCRYPTION_KEY: NEW }, encoding: 'utf8', shell: true });
console.log('REAL:', real.trim());

// Verify: decrypt with NEW key must yield plaintext; key_version bumped.
const h2 = createDb(cfg);
const row = (await h2.pool.query('select api_key_ciphertext,api_key_iv,api_key_tag,key_version from provider_credentials where id=$1',[credId])).rows[0];
const plain = decryptSecret({ ciphertext: row.api_key_ciphertext, iv: row.api_key_iv, tag: row.api_key_tag, keyVersion: row.key_version }, Buffer.alloc(32,22), aadFor(userId, credId));
console.log('DECRYPTED:', plain, 'version:', row.key_version);
// Old key must now fail.
try { decryptSecret({ ciphertext: row.api_key_ciphertext, iv: row.api_key_iv, tag: row.api_key_tag, keyVersion: row.key_version }, Buffer.alloc(32,11), aadFor(userId, credId)); console.log('ERROR: old key still works'); }
catch { console.log('OLD KEY REJECTED: ok'); }
await h2.pool.query('delete from provider_credentials where id=$1',[credId]);
await h2.pool.query('delete from users where id=$1',[userId]);
await h2.close();
process.exit(0);
