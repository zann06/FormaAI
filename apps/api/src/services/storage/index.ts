import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { AppConfig } from '../../config.js';
import { safeFilename } from '@formaai/shared';

export interface StorageAdapter {
  /** Persist bytes and return the storage key. */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  stream(key: string): Promise<NodeJS.ReadableStream>;
  delete(key: string): Promise<void>;
  /** Delete every object under a prefix (used for project/user deletion). */
  deletePrefix(prefix: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

/** Builds a storage key that can never traverse outside the storage root. */
export function buildStorageKey(userId: string, projectId: string, filename: string): string {
  const safe = safeFilename(filename, 'file').replace(/[^A-Za-z0-9._-]/g, '_');
  return `${userId}/${projectId}/${randomUUID()}-${safe}`;
}

function assertSafeKey(key: string): void {
  const normalized = key.replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized.includes('..') || normalized.includes('\0')) {
    throw new Error('Invalid storage key');
  }
}

export class LocalStorage implements StorageAdapter {
  constructor(private readonly rootDir: string) {}

  private resolve(key: string): string {
    assertSafeKey(key);
    const absoluteRoot = path.resolve(this.rootDir);
    const target = path.resolve(absoluteRoot, key);
    if (!target.startsWith(absoluteRoot + path.sep)) throw new Error('Invalid storage path');
    return target;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const target = this.resolve(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await fs.readFile(this.resolve(key)));
  }

  async stream(key: string): Promise<NodeJS.ReadableStream> {
    return createReadStream(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<void> {
    assertSafeKey(prefix);
    await fs.rm(this.resolve(prefix), { recursive: true, force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * S3-compatible storage using SigV4 signed requests implemented directly on
 * `fetch` (no SDK dependency). Objects are always private; downloads go through
 * the API which enforces ownership.
 */
export class S3Storage implements StorageAdapter {
  constructor(
    private readonly options: {
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      forcePathStyle: boolean;
    },
  ) {}

  private objectUrl(key: string): string {
    assertSafeKey(key);
    const base = this.options.endpoint.replace(/\/+$/, '');
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    if (this.options.forcePathStyle) return `${base}/${this.options.bucket}/${encodedKey}`;
    const url = new URL(base);
    url.hostname = `${this.options.bucket}.${url.hostname}`;
    return `${url.toString().replace(/\/+$/, '')}/${encodedKey}`;
  }

  private async sign(method: string, key: string, body: Uint8Array | null): Promise<Record<string, string>> {
    const { createHash, createHmac } = await import('node:crypto');
    const url = new URL(this.objectUrl(key));
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = createHash('sha256').update(body ?? new Uint8Array()).digest('hex');
    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    const signedHeaders = Object.keys(headers).sort().join(';');
    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map((h) => `${h}:${headers[h]}\n`)
      .join('');
    const canonicalRequest = [method, url.pathname, url.searchParams.toString(), canonicalHeaders, signedHeaders, payloadHash].join(
      '\n',
    );
    const scope = `${dateStamp}/${this.options.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');
    const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.options.secretAccessKey}`, dateStamp), this.options.region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    return {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${this.options.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const headers = await this.sign('PUT', key, bytes);
    const response = await fetch(this.objectUrl(key), {
      method: 'PUT',
      headers: { ...headers, 'content-type': contentType },
      // Node's undici accepts any ArrayBufferView; the DOM lib types are narrower.
      body: bytes as unknown as BodyInit,
    });
    if (!response.ok) throw new Error(`S3 upload failed (${response.status})`);
  }

  async get(key: string): Promise<Uint8Array> {
    const headers = await this.sign('GET', key, null);
    const response = await fetch(this.objectUrl(key), { method: 'GET', headers });
    if (!response.ok) throw new Error(`S3 download failed (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async stream(key: string): Promise<NodeJS.ReadableStream> {
    const headers = await this.sign('GET', key, null);
    const response = await fetch(this.objectUrl(key), { method: 'GET', headers });
    if (!response.ok || !response.body) throw new Error(`S3 download failed (${response.status})`);
    return response.body as unknown as NodeJS.ReadableStream;
  }

  async delete(key: string): Promise<void> {
    const headers = await this.sign('DELETE', key, null);
    await fetch(this.objectUrl(key), { method: 'DELETE', headers });
  }

  async deletePrefix(prefix: string): Promise<void> {
    // Object listing (ListObjectsV2) is intentionally not implemented: prefix
    // deletion on S3 requires a listing API. Callers delete known keys instead.
    void prefix;
  }

  async exists(key: string): Promise<boolean> {
    try {
      const headers = await this.sign('HEAD', key, null);
      const response = await fetch(this.objectUrl(key), { method: 'HEAD', headers });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export function createStorage(config: AppConfig): StorageAdapter {
  if (config.STORAGE_DRIVER === 's3') {
    if (!config.S3_BUCKET || !config.S3_ACCESS_KEY_ID || !config.S3_SECRET_ACCESS_KEY || !config.S3_ENDPOINT) {
      throw new Error('S3 storage requires S3_ENDPOINT, S3_BUCKET and credentials');
    }
    return new S3Storage({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      bucket: config.S3_BUCKET,
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
    });
  }
  return new LocalStorage(config.STORAGE_DIR);
}
