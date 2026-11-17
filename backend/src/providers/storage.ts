import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';

/**
 * Private file storage. Files are never served statically; they are reached only
 * through short-lived HMAC-signed URLs (see src/modules/files).
 */
export interface StorageProvider {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
}

export class LocalStorageProvider implements StorageProvider {
  constructor(private root = path.resolve(env.STORAGE_DIR)) {}

  private resolve(key: string) {
    if (!/^[\w/.-]+$/.test(key) || key.includes('..')) throw new Error('Invalid storage key');
    return path.join(this.root, key);
  }

  async put(key: string, data: Buffer) {
    const p = this.resolve(key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, data);
  }

  async get(key: string) {
    return readFile(this.resolve(key));
  }
}

let provider: StorageProvider | null = null;
export function storage(): StorageProvider {
  if (!provider) provider = new LocalStorageProvider();
  return provider;
}
export function setStorageProvider(p: StorageProvider) {
  provider = p;
}

// ---- Signed URL tokens -------------------------------------------------------

export type SignedAction = 'get' | 'put';
export interface SignedPayload {
  f: string; // file id
  a: SignedAction;
  u: string; // user the URL was issued to (for access logs)
  e: number; // expiry, unix seconds
}

export const VIEW_URL_TTL_SECONDS = 5 * 60;
export const UPLOAD_URL_TTL_SECONDS = 10 * 60;

function sig(body: string) {
  return createHmac('sha256', env.FILE_SIGNING_SECRET).update(body).digest('base64url');
}

export function signFileToken(p: SignedPayload): string {
  const body = Buffer.from(JSON.stringify(p)).toString('base64url');
  return `${body}.${sig(body)}`;
}

export function verifyFileToken(token: string, now = Date.now()): SignedPayload | null {
  const [body, s] = token.split('.');
  if (!body || !s) return null;
  const expected = Buffer.from(sig(body));
  const given = Buffer.from(s);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SignedPayload;
    if (typeof p.e !== 'number' || p.e * 1000 < now) return null;
    return p;
  } catch {
    return null;
  }
}

export function signedFileUrl(fileId: string, userId: string, action: SignedAction, ttlSeconds: number) {
  const e = Math.floor(Date.now() / 1000) + ttlSeconds;
  const token = signFileToken({ f: fileId, a: action, u: userId, e });
  return { url: `${env.PUBLIC_BASE_URL}/files/${token}`, expiresAt: new Date(e * 1000).toISOString() };
}
