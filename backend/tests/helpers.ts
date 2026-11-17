import request from 'supertest';
import type { Role } from '@prisma/client';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { signAccessToken } from '../src/modules/auth/tokens.js';
import { resetAllLimiters } from '../src/lib/rateLimit.js';

export const app = createApp();
export const api = () => request(app);

let phoneSeq = 0;
export function nextPhone() {
  phoneSeq++;
  return `+9198${String(Date.now() % 1_000_000).padStart(6, '0')}${String(phoneSeq % 100).padStart(2, '0')}`;
}

/** Wipe all tables between test files (TEST DATABASE ONLY). */
export async function resetDb() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`);
  resetAllLimiters();
}

export async function makeUser(role: Role, name = `${role.toLowerCase()} user`) {
  const user = await prisma.user.create({ data: { phone: nextPhone(), name, role } });
  return { user, token: signAccessToken(user.id, role), auth: { Authorization: `Bearer ${signAccessToken(user.id, role)}` } };
}

export type Actor = Awaited<ReturnType<typeof makeUser>>;

/** Owner with one property (cityCode bengaluru) and rooms created through the API. */
export async function ownerWithProperty(opts: { rooms?: { name: string; sharingType: number; rentPaise: number }[]; property?: Record<string, unknown> } = {}) {
  const owner = await makeUser('OWNER', 'Owner');
  const p = await api()
    .post('/api/owner/properties')
    .set(owner.auth)
    .send({ name: 'Test PG', address: '1 Test Road, Bengaluru', city: 'Bengaluru', cityCode: 'bengaluru', ...opts.property })
    .expect(201);
  const rooms = [];
  for (const r of opts.rooms ?? [{ name: '101', sharingType: 2, rentPaise: 1000000 }]) {
    const res = await api().post(`/api/owner/properties/${p.body.id}/rooms`).set(owner.auth).send(r).expect(201);
    rooms.push(res.body as { id: string; beds: { id: string; label: string }[]; rentPaise: number });
  }
  return { owner, property: p.body as { id: string; inviteCode: string; rentDueDay: number }, rooms };
}

/** Add a tenant through the owner API; returns the tenancy and a tenant actor. */
export async function addTenant(owner: Actor, propertyId: string, bedId: string, extra: Record<string, unknown> = {}) {
  const phone = nextPhone();
  const res = await api()
    .post('/api/owner/tenants')
    .set(owner.auth)
    .send({ propertyId, bedId, name: 'Test Tenant', phone, joinDate: todayStr(), rentPaise: 1000000, depositPaise: 2000000, depositCollectedPaise: 2000000, ...extra });
  if (res.status !== 201) throw new Error(`addTenant failed: ${res.status} ${JSON.stringify(res.body)}`);
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  return {
    tenancy: res.body as { id: string; bedId: string; tenantProfileId: string },
    tenant: { user, token: signAccessToken(user.id, 'TENANT'), auth: { Authorization: `Bearer ${signAccessToken(user.id, 'TENANT')}` } },
  };
}

export function todayStr() {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 10);
}

/** Minimal valid file bodies for upload tests. */
export const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a0f50000000049454e44ae426082', 'hex');
export const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]);

export async function uploadFile(actor: Actor, purpose: string, body = PNG_BYTES, mimeType = 'image/png') {
  const r = await api().post('/api/files/upload-url').set(actor.auth).send({ purpose, mimeType, sizeBytes: body.length }).expect(201);
  const path = new URL(r.body.url).pathname;
  await api().put(path).set('content-type', mimeType).send(body).expect(200);
  return r.body.fileId as string;
}
