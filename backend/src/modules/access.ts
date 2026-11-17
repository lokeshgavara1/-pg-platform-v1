/**
 * Access scoping. Every owner/staff/tenant query goes through these helpers so the
 * backend — not the app — decides what a caller may see. Out-of-scope resources
 * return 404 (not 403) so their existence is not leaked.
 */
import type { User } from '@prisma/client';
import { prisma, type Db } from '../lib/prisma.js';
import { forbidden, notFound } from '../lib/errors.js';

/** Property ids the caller manages. Owners: own properties. Staff: assigned properties. */
export async function managedPropertyIds(user: User, db: Db = prisma): Promise<string[]> {
  if (user.role === 'OWNER') {
    const rows = await db.property.findMany({ where: { ownerId: user.id }, select: { id: true } });
    return rows.map((r) => r.id);
  }
  if (user.role === 'STAFF') {
    const rows = await db.propertyStaff.findMany({ where: { userId: user.id, status: 'ACTIVE' }, select: { propertyId: true } });
    return rows.map((r) => r.propertyId);
  }
  return [];
}

/** Owner-only access to a property (staff cannot change setup, rent or deposits). */
export async function ownedProperty(user: User, propertyId: string, db: Db = prisma) {
  if (user.role !== 'OWNER') throw forbidden();
  const p = await db.property.findFirst({ where: { id: propertyId, ownerId: user.id } });
  if (!p) throw notFound('Property');
  return p;
}

/** Owner or assigned staff. */
export async function managedProperty(user: User, propertyId: string, db: Db = prisma) {
  const ids = await managedPropertyIds(user, db);
  if (!ids.includes(propertyId)) throw notFound('Property');
  return db.property.findUniqueOrThrow({ where: { id: propertyId } });
}

export async function ownedRoom(user: User, roomId: string, db: Db = prisma) {
  if (user.role !== 'OWNER') throw forbidden();
  const r = await db.room.findFirst({ where: { id: roomId, property: { ownerId: user.id } }, include: { property: true } });
  if (!r) throw notFound('Room');
  return r;
}

export async function ownedBed(user: User, bedId: string, db: Db = prisma) {
  if (user.role !== 'OWNER') throw forbidden();
  const b = await db.bed.findFirst({ where: { id: bedId, room: { property: { ownerId: user.id } } }, include: { room: true } });
  if (!b) throw notFound('Bed');
  return b;
}

export async function ownedTenancy(user: User, tenancyId: string, db: Db = prisma) {
  if (user.role !== 'OWNER') throw forbidden();
  const t = await db.tenancy.findFirst({
    where: { id: tenancyId, property: { ownerId: user.id } },
    include: { property: true, tenantProfile: { include: { user: true } }, bed: { include: { room: true } } },
  });
  if (!t) throw notFound('Tenancy');
  return t;
}

export async function ownedInvoice(user: User, invoiceId: string, db: Db = prisma) {
  if (user.role !== 'OWNER') throw forbidden();
  const inv = await db.invoice.findFirst({ where: { id: invoiceId, property: { ownerId: user.id } } });
  if (!inv) throw notFound('Invoice');
  return inv;
}

/** The tenant's profile and their current (ACTIVE/NOTICE) tenancy, if any. */
export async function tenantContext(user: User, db: Db = prisma) {
  if (user.role !== 'TENANT') throw forbidden();
  const profile = await db.tenantProfile.findUnique({ where: { userId: user.id } });
  const tenancy = profile
    ? await db.tenancy.findFirst({
        where: { tenantProfileId: profile.id, status: { in: ['ACTIVE', 'NOTICE'] } },
        include: { property: true, bed: { include: { room: true } } },
      })
    : null;
  return { profile, tenancy };
}

export async function requireCurrentTenancy(user: User, db: Db = prisma) {
  const ctx = await tenantContext(user, db);
  if (!ctx.profile || !ctx.tenancy) throw notFound('Active stay');
  return { profile: ctx.profile, tenancy: ctx.tenancy };
}

export async function ensureTenantProfile(userId: string, db: Db = prisma) {
  return (
    (await db.tenantProfile.findUnique({ where: { userId } })) ?? (await db.tenantProfile.create({ data: { userId } }))
  );
}
