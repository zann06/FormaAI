import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

/** Promise wrapper around crypto.scrypt (promisify's overloads drop the options arg). */
function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

// ---------------------------------------------------------------------------
// Password hashing (scrypt — built into Node, no native dependency)
// ---------------------------------------------------------------------------

const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password.normalize('NFKC'), salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 128 * 1024 * 1024,
  })) as Buffer;
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  const salt = Buffer.from(saltRaw!, 'base64');
  const expected = Buffer.from(hashRaw!, 'base64');
  const derived = (await scrypt(password.normalize('NFKC'), salt, expected.length, {
    N,
    r,
    p,
    maxmem: 256 * 1024 * 1024,
  })) as Buffer;
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

// ---------------------------------------------------------------------------
// Credential vault: AES-256-GCM with AAD binding
// ---------------------------------------------------------------------------

export interface EncryptedValue {
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion: number;
}

export const CURRENT_KEY_VERSION = 1;

/**
 * Encrypts a provider API key.
 *
 * `aad` binds the ciphertext to the owning user and credential row so a DB-level
 * attacker cannot copy a ciphertext from one user/row into another.
 */
export function encryptSecret(
  plaintext: string,
  key: Buffer,
  aad: string,
  keyVersion: number = CURRENT_KEY_VERSION,
): EncryptedValue {
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    keyVersion,
  };
}

export function decryptSecret(value: EncryptedValue, key: Buffer, aad: string): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]);
  return decrypted.toString('utf8');
}

export function aadFor(userId: string, credentialId: string): string {
  return `${userId}|${credentialId}`;
}

export function fingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

export function last4(secret: string): string {
  return secret.slice(-4);
}

// ---------------------------------------------------------------------------
// Session tokens
// ---------------------------------------------------------------------------

export function createSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string, secret: string): string {
  return createHash('sha256').update(`${token}:${secret}`).digest('hex');
}

export function hashIp(ip: string | undefined, secret: string): string | null {
  if (!ip) return null;
  return createHash('sha256').update(`${ip}:${secret}`).digest('hex').slice(0, 32);
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
