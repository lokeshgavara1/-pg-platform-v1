import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { parse } from '../../lib/http.js';
import { addDays, endOfMonth, startOfMonth, todayIST } from '../../lib/dates.js';
import { me, requireRole } from '../auth/middleware.js';
import { managedPropertyIds } from '../access.js';

export const dashboardRouter = Router();

/**
 * Owner dashboard. All figures are aggregated in SQL (fixed number of queries,
 * no N+1). Occupancy uses the same derivation rules as bed status.
 */
export async function buildDashboard(propertyIds: string[], now = new Date()) {
  const today = todayIST(now);
  const monthStart = startOfMonth(today);
  const monthEnd = endOfMonth(today);
  const soon = addDays(today, 30);
  if (propertyIds.length === 0) {
    return {
      occupancy: { totalBeds: 0, occupied: 0, reserved: 0, vacant: 0, occupancyBps: 0 },
      month: { from: monthStart, to: monthEnd, duePaise: 0, collectedPaise: 0, outstandingPaise: 0 },
      overdue: [],
      endingSoon: [],
      openComplaints: 0,
      pending: { kyc: 0, verification: 0, bookings: 0, moveOuts: 0 },
    };
  }
  const ids = Prisma.join(propertyIds);

  const [occ] = await prisma.$queryRaw<{ total: bigint; occupied: bigint; reserved: bigint }[]>(Prisma.sql`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE t.id IS NOT NULL AND t."startDate" <= ${today}::date) AS occupied,
      COUNT(*) FILTER (WHERE (t.id IS NOT NULL AND t."startDate" > ${today}::date) OR (t.id IS NULL AND bk.id IS NOT NULL)) AS reserved
    FROM "Bed" b
    JOIN "Room" r ON r.id = b."roomId"
    LEFT JOIN "Tenancy" t ON t."bedId" = b.id AND t.status IN ('ACTIVE','NOTICE')
    LEFT JOIN "Booking" bk ON bk."bedId" = b.id AND (bk.status = 'PAID' OR (bk.status = 'RESERVED' AND bk."holdUntil" > ${now}))
    WHERE r."propertyId" IN (${ids}) AND b.status = 'ACTIVE' AND r.status = 'ACTIVE'`);

  const [money] = await prisma.$queryRaw<{ due: bigint | null; outstanding: bigint | null }[]>(Prisma.sql`
    SELECT SUM(i."totalPaise") AS due, SUM(i."totalPaise" - i."paidPaise") AS outstanding
    FROM "Invoice" i
    WHERE i."propertyId" IN (${ids}) AND i.status <> 'VOID' AND i.kind IN ('RENT','DEPOSIT','OTHER')
      AND i."dueDate" BETWEEN ${monthStart}::date AND ${monthEnd}::date`);

  const [collected] = await prisma.$queryRaw<{ collected: bigint | null }[]>(Prisma.sql`
    SELECT SUM(p."amountPaise") AS collected
    FROM "Payment" p JOIN "Invoice" i ON i.id = p."invoiceId"
    WHERE i."propertyId" IN (${ids}) AND p.status = 'SUCCESS'
      AND p."receivedAt" >= ${monthStart} AND p."receivedAt" < ${addDays(monthEnd, 1)}`);

  const overdue = await prisma.$queryRaw<
    { tenancyId: string; tenantName: string; propertyName: string; room: string; bed: string; overduePaise: bigint; oldestDueDate: Date }[]
  >(Prisma.sql`
    SELECT t.id AS "tenancyId", u.name AS "tenantName", p.name AS "propertyName", r.name AS room, b.label AS bed,
           SUM(i."totalPaise" - i."paidPaise") AS "overduePaise", MIN(i."dueDate") AS "oldestDueDate"
    FROM "Invoice" i
    JOIN "Tenancy" t ON t.id = i."tenancyId"
    JOIN "TenantProfile" tp ON tp.id = t."tenantProfileId"
    JOIN "User" u ON u.id = tp."userId"
    JOIN "Property" p ON p.id = t."propertyId"
    JOIN "Bed" b ON b.id = t."bedId"
    JOIN "Room" r ON r.id = b."roomId"
    WHERE i."propertyId" IN (${ids}) AND i.status IN ('DUE','PARTIAL') AND i."dueDate" < ${today}::date
    GROUP BY t.id, u.name, p.name, r.name, b.label
    ORDER BY MIN(i."dueDate") ASC
    LIMIT 50`);

  const endingSoon = await prisma.tenancy.findMany({
    where: {
      propertyId: { in: propertyIds },
      OR: [{ status: 'NOTICE' }, { status: 'ACTIVE', endDate: { lte: soon } }],
    },
    orderBy: { endDate: 'asc' },
    take: 50,
    select: {
      id: true,
      status: true,
      endDate: true,
      property: { select: { name: true } },
      bed: { select: { label: true, room: { select: { name: true } } } },
      tenantProfile: { select: { user: { select: { name: true } } } },
    },
  });

  const [openComplaints, kyc, verification, bookings, moveOuts] = await Promise.all([
    prisma.complaint.count({ where: { propertyId: { in: propertyIds }, status: { in: ['OPEN', 'IN_PROGRESS'] } } }),
    prisma.tenantProfile.count({ where: { kycStatus: 'PENDING', tenancies: { some: { propertyId: { in: propertyIds }, status: { in: ['ACTIVE', 'NOTICE'] } } } } }),
    prisma.verificationRecord.count({ where: { status: 'NOT_STARTED', tenancy: { propertyId: { in: propertyIds }, status: { in: ['ACTIVE', 'NOTICE'] } } } }),
    prisma.booking.count({ where: { propertyId: { in: propertyIds }, status: 'PAID' } }),
    prisma.moveOut.count({ where: { tenancy: { propertyId: { in: propertyIds } }, status: { in: ['REQUESTED', 'DISPUTED', 'TENANT_ACCEPTED'] } } }),
  ]);

  const total = Number(occ.total);
  const occupied = Number(occ.occupied);
  const reserved = Number(occ.reserved);
  return {
    occupancy: { totalBeds: total, occupied, reserved, vacant: total - occupied - reserved, occupancyBps: total ? Math.round((occupied * 10000) / total) : 0 },
    month: {
      from: monthStart,
      to: monthEnd,
      duePaise: Number(money.due ?? 0),
      collectedPaise: Number(collected.collected ?? 0),
      outstandingPaise: Number(money.outstanding ?? 0),
    },
    overdue: overdue.map((o) => ({ ...o, overduePaise: Number(o.overduePaise) })),
    endingSoon,
    openComplaints,
    pending: { kyc, verification, bookings, moveOuts },
  };
}

dashboardRouter.get('/dashboard', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { propertyId } = parse(z.object({ propertyId: z.string().optional() }), req.query);
  const ids = await managedPropertyIds(user);
  res.json(await buildDashboard(propertyId ? ids.filter((i) => i === propertyId) : ids));
});
