import { Prisma, PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

export type Tx = Prisma.TransactionClient;
export type Db = PrismaClient | Tx;

export function isUniqueViolation(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return true;
  // Raw SQL / partial unique index violations surface as P2010 or with Postgres code 23505.
  const msg = err instanceof Error ? err.message : '';
  return /23505|unique constraint/i.test(msg);
}
