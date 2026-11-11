/**
 * Rotates the credential vault key.
 *
 * Every provider API key is stored as AES-256-GCM ciphertext bound to
 * (userId, credentialId) via AAD. To rotate the master key we must decrypt each
 * row with the old key and re-encrypt it with the new one *inside a single
 * transaction*, so a crash can never leave a mix of old- and new-key rows.
 *
 * Usage:
 *   OLD_CREDENTIAL_ENCRYPTION_KEY=... NEW_CREDENTIAL_ENCRYPTION_KEY=... \
 *     npm run rotate-key --workspace @formaai/api -- [--dry-run] [--force]
 *
 * Flags:
 *   --dry-run   Decrypt and re-encrypt in memory, roll back at the end. Use this
 *               first: it proves every row is decryptable with the old key.
 *   --force     Rotate rows whose key_version already equals the target version
 *               (normally skipped, since re-encrypting them is wasted work).
 *
 * Exit codes: 0 success, 1 failure (nothing committed).
 */
import 'dotenv/config';
import { createDb } from '../src/db/client.js';
import { aadFor, decryptSecret, encryptSecret, CURRENT_KEY_VERSION } from '../src/lib/crypto.js';
import { loadConfig } from '../src/config.js';

const OLD_ENV = 'OLD_CREDENTIAL_ENCRYPTION_KEY';
const NEW_ENV = 'NEW_CREDENTIAL_ENCRYPTION_KEY';

interface CredentialRow {
  id: string;
  user_id: string;
  api_key_ciphertext: string;
  api_key_iv: string;
  api_key_tag: string;
  key_version: number;
}

function decodeKey(raw: string, label: string): Buffer {
  const base64Like = /^[A-Za-z0-9+/=_\-]+$/.test(raw) ? Buffer.from(raw, 'base64') : null;
  if (base64Like && base64Like.length === 32) return base64Like;
  const hex = Buffer.from(raw, 'hex');
  if (hex.length === 32) return hex;
  throw new Error(`${label} must be 32 bytes encoded as base64 or hex (openssl rand -base64 32)`);
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const force = args.has('--force');

  const oldRaw = process.env[OLD_ENV];
  const newRaw = process.env[NEW_ENV];
  if (!oldRaw || !newRaw) {
    throw new Error(`Set both ${OLD_ENV} and ${NEW_ENV} in the environment before rotating.`);
  }
  const oldKey = decodeKey(oldRaw, OLD_ENV);
  const newKey = decodeKey(newRaw, NEW_ENV);
  if (oldKey.equals(newKey)) throw new Error('Old and new keys are identical; nothing to rotate.');

  // DATABASE_URL must already point at the target instance (usually set in .env).
  const config = loadConfig(process.env);
  const dbHandle = createDb(config);
  const { pool } = dbHandle;

  let rotated = 0;
  let skipped = 0;
  const targetVersion = CURRENT_KEY_VERSION + 1;

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the table so no credential can be written mid-rotation.
      const { rows } = await client.query<CredentialRow>(
        'SELECT id, user_id, api_key_ciphertext, api_key_iv, api_key_tag, key_version ' +
          'FROM provider_credentials ORDER BY created_at FOR UPDATE',
      );

      for (const row of rows) {
        if (!force && row.key_version >= targetVersion) {
          // Already re-encrypted (e.g. a rerun after an interrupted manual
          // rotation) — skip rather than double-encrypt.
          skipped += 1;
          continue;
        }
        const aad = aadFor(row.user_id, row.id);
        // Prove decryption works before we touch anything else; a failure here
        // aborts the whole transaction so no row can be half-rotated.
        const plaintext = decryptSecret(
          { ciphertext: row.api_key_ciphertext, iv: row.api_key_iv, tag: row.api_key_tag, keyVersion: row.key_version },
          oldKey,
          aad,
        );
        const reencrypted = encryptSecret(plaintext, newKey, aad, targetVersion);
        await client.query(
          'UPDATE provider_credentials SET api_key_ciphertext = $1, api_key_iv = $2, api_key_tag = $3, ' +
            'key_version = $4, updated_at = now() WHERE id = $5',
          [reencrypted.ciphertext, reencrypted.iv, reencrypted.tag, reencrypted.keyVersion, row.id],
        );
        rotated += 1;
      }

      if (dryRun) {
        await client.query('ROLLBACK');
        console.log(`[dry-run] ${rotated} credential(s) decryptable with the old key; rolled back.`);
      } else {
        await client.query('COMMIT');
        console.log(`Rotated ${rotated} credential(s); skipped ${skipped}.`);
        console.log('Set CREDENTIAL_ENCRYPTION_KEY to the new key and restart the API.');
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await dbHandle.close().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(`Credential key rotation failed: ${error.message}`);
  } else {
    // Never stringify arbitrary error objects without redaction.
    console.error('Credential key rotation failed with an unknown error.');
  }
  console.error('No changes were committed.');
  process.exitCode = 1;
});
