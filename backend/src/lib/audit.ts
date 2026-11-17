import type { Prisma } from '@prisma/client';
import type { Db } from './prisma.js';

/**
 * Write an audit_log row. Required for every change to rent, deposits and KYC status
 * (and used for other sensitive admin changes). Never put full ID numbers or OTPs in before/after.
 */
export async function audit(
  db: Db,
  entry: {
    actorId: string | null;
    action: string;
    entityType: string;
    entityId: string;
    before?: Prisma.InputJsonValue | null;
    after?: Prisma.InputJsonValue | null;
  },
) {
  await db.auditLog.create({
    data: {
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      before: entry.before ?? undefined,
      after: entry.after ?? undefined,
    },
  });
}
