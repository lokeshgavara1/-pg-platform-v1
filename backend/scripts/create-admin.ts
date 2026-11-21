/**
 * Create (or re-activate) an admin account and print a one-time login link.
 * Admins cannot sign up through the apps.
 *
 *   npm run admin:create -w backend -- 9876543210 "Your Name"
 *
 * Open the printed link (valid 7 days, works once) and "Continue with Google": that connects your
 * Google account to the admin account. After that, log in with Google on the admin site.
 * Running the command again for the same number prints a fresh link (the old one stops working).
 */
import { prisma } from '../src/lib/prisma.js';
import { createLoginLink } from '../src/modules/auth/google.js';

const [rawPhone, ...nameParts] = process.argv.slice(2);
const name = nameParts.join(' ').trim();
const digits = (rawPhone ?? '').replace(/\D/g, '').slice(-10);

if (!/^[6-9]\d{9}$/.test(digits) || name.length < 2) {
  console.error('Usage: npm run admin:create -w backend -- <10-digit mobile> "<Full name>"');
  process.exit(1);
}

const phone = `+91${digits}`;

try {
  const existing = await prisma.user.findUnique({ where: { phone } });
  if (existing && existing.role !== 'ADMIN') {
    console.error(`+91 ${digits} already belongs to a ${existing.role.toLowerCase()} account. Use a different number for the admin.`);
    process.exitCode = 1;
  } else {
    const user = existing
      ? await prisma.user.update({ where: { id: existing.id }, data: { status: 'ACTIVE', name } })
      : await prisma.user.create({ data: { phone, name, role: 'ADMIN' } });
    await prisma.auditLog.create({ data: { actorId: null, action: existing ? 'ADMIN_REACTIVATED' : 'ADMIN_CREATED', entityType: 'User', entityId: user.id, after: { via: 'cli' } } });
    const link = await createLoginLink(user.id, null);
    console.log(`Admin ready: ${user.name} (+91 ${digits}).`);
    console.log(`\nOpen this one-time link and "Continue with Google" to connect your Google account (expires ${link.expiresAt.slice(0, 10)}):\n\n  ${link.url}\n`);
  }
} finally {
  await prisma.$disconnect();
}
