/**
 * Bed status is DERIVED from bookings and tenancies — it is never stored on the Bed row.
 *   INACTIVE  bed or room deactivated by the owner
 *   OCCUPIED  live tenancy (ACTIVE/NOTICE) that has started
 *   RESERVED  live tenancy starting in the future, a token-paid booking, or an unexpired reservation
 *   VACANT    otherwise
 */
import { Prisma } from '@prisma/client';
import { conflict } from '../../lib/errors.js';
import type { Db, Tx } from '../../lib/prisma.js';
import { todayIST } from '../../lib/dates.js';

export type BedState = 'VACANT' | 'RESERVED' | 'OCCUPIED' | 'INACTIVE';

export interface BedStatusInfo {
  status: BedState;
  tenancyId?: string;
  tenantName?: string;
  bookingId?: string;
  bookingStatus?: string;
  holdUntil?: Date;
}

export async function deriveBedStatuses(
  db: Db,
  beds: { id: string; status: string; roomStatus?: string }[],
  now = new Date(),
): Promise<Map<string, BedStatusInfo>> {
  const ids = beds.map((b) => b.id);
  const today = todayIST(now);
  const [tenancies, bookings] = await Promise.all([
    db.tenancy.findMany({
      where: { bedId: { in: ids }, status: { in: ['ACTIVE', 'NOTICE'] } },
      select: { id: true, bedId: true, startDate: true, tenantProfile: { select: { user: { select: { name: true } } } } },
    }),
    db.booking.findMany({
      where: {
        bedId: { in: ids },
        OR: [{ status: 'PAID' }, { status: 'RESERVED', holdUntil: { gt: now } }],
      },
      select: { id: true, bedId: true, status: true, holdUntil: true },
    }),
  ]);
  const tByBed = new Map(tenancies.map((t) => [t.bedId, t]));
  const bByBed = new Map(bookings.map((b) => [b.bedId, b]));
  const out = new Map<string, BedStatusInfo>();
  for (const bed of beds) {
    if (bed.status !== 'ACTIVE' || (bed.roomStatus && bed.roomStatus !== 'ACTIVE')) {
      out.set(bed.id, { status: 'INACTIVE' });
      continue;
    }
    const t = tByBed.get(bed.id);
    if (t) {
      out.set(bed.id, {
        status: t.startDate.getTime() > today.getTime() ? 'RESERVED' : 'OCCUPIED',
        tenancyId: t.id,
        tenantName: t.tenantProfile.user.name,
      });
      continue;
    }
    const b = bByBed.get(bed.id);
    if (b) {
      out.set(bed.id, { status: 'RESERVED', bookingId: b.id, bookingStatus: b.status, holdUntil: b.holdUntil });
      continue;
    }
    out.set(bed.id, { status: 'VACANT' });
  }
  return out;
}

/**
 * Lock the bed row for the rest of the transaction so two requests cannot both
 * reserve/assign it. Must be called inside prisma.$transaction.
 */
export async function lockBed(tx: Tx, bedId: string) {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "Bed" WHERE id = ${bedId} FOR UPDATE`);
}

/** Expire stale reservations on this bed, then fail if anything live still holds it. */
export async function assertBedFree(tx: Tx, bedId: string, opts: { ignoreTenancyId?: string; ignoreBookingId?: string } = {}, now = new Date()) {
  await expireStaleReservations(tx, now, bedId);
  const bed = await tx.bed.findUnique({ where: { id: bedId }, include: { room: true } });
  if (!bed || bed.status !== 'ACTIVE' || bed.room.status !== 'ACTIVE') throw conflict('This bed is not available');
  const liveTenancy = await tx.tenancy.findFirst({
    where: { bedId, status: { in: ['ACTIVE', 'NOTICE'] }, id: opts.ignoreTenancyId ? { not: opts.ignoreTenancyId } : undefined },
  });
  if (liveTenancy) throw conflict('This bed is already occupied');
  const liveBooking = await tx.booking.findFirst({
    where: { bedId, status: { in: ['RESERVED', 'PAID'] }, id: opts.ignoreBookingId ? { not: opts.ignoreBookingId } : undefined },
  });
  if (liveBooking) throw conflict('This bed is already reserved');
}

/** RESERVED bookings past their hold time become EXPIRED and their token invoice is voided. */
export async function expireStaleReservations(db: Db, now = new Date(), bedId?: string) {
  const stale = await db.booking.findMany({
    where: { status: 'RESERVED', holdUntil: { lte: now }, ...(bedId ? { bedId } : {}) },
    select: { id: true },
  });
  if (stale.length === 0) return 0;
  const ids = stale.map((s) => s.id);
  await db.booking.updateMany({ where: { id: { in: ids }, status: 'RESERVED' }, data: { status: 'EXPIRED' } });
  await db.invoice.updateMany({ where: { bookingId: { in: ids }, kind: 'TOKEN', paidPaise: 0, status: 'DUE' }, data: { status: 'VOID' } });
  return ids.length;
}
