/**
 * Development seed: 1 admin, 1 owner (+ 1 staff), 1 property with 3 rooms and 8 beds,
 * and 3 tenants with active tenancies and invoices for the current month.
 * Log in with these numbers; the OTP is printed in the backend console.
 *
 *   Admin  : 9000000001   (admin app)
 *   Owner  : 9000000002   (owner app)
 *   Staff  : 9000000003   (owner app, complaints only)
 *   Tenants: 9000000011, 9000000012, 9000000013   (tenant app)
 */
import { PrismaClient } from '@prisma/client';
import { createTenancy } from '../src/modules/tenancies/service.js';
import { generateInvoicesForTenancy } from '../src/modules/invoices/engine.js';
import { addDays, startOfMonth, todayIST } from '../src/lib/dates.js';

const prisma = new PrismaClient();

async function main() {
  // Demo data has fake accounts with well-known test numbers: never on a real server.
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to load demo data: NODE_ENV=production. Create your admin with `npm run admin:create -w backend`.');
    process.exitCode = 1;
    return;
  }
  const existing = await prisma.property.findFirst({ where: { name: 'Sunrise PG for Men' } });
  if (existing) {
    console.log('Seed data already present — skipping. Run `npm run db:reset -w backend` for a clean database.');
    return;
  }
  const admin = await prisma.user.upsert({ where: { phone: '+919000000001' }, update: {}, create: { phone: '+919000000001', name: 'Platform Admin', role: 'ADMIN' } });
  const owner = await prisma.user.upsert({ where: { phone: '+919000000002' }, update: {}, create: { phone: '+919000000002', name: 'Ramesh Kumar', role: 'OWNER' } });
  const staff = await prisma.user.upsert({ where: { phone: '+919000000003' }, update: {}, create: { phone: '+919000000003', name: 'Suresh (Caretaker)', role: 'STAFF' } });

  const property = await prisma.property.create({
    data: {
      ownerId: owner.id,
      name: 'Sunrise PG for Men',
      address: '12, 5th Cross, Koramangala 4th Block, Bengaluru 560034',
      city: 'Bengaluru',
      rentDueDay: 5,
      minNoticeDays: 30,
      reservationHoldHours: 24,
      tokenAmountPaise: 200000,
      depositMonths: 2,
      inviteCode: 'SUNRISE1',
      staff: { create: { userId: staff.id } },
    },
  });

  const roomDefs = [
    { name: '101', floor: 1, sharingType: 3, rentPaise: 850000 },
    { name: '102', floor: 1, sharingType: 3, rentPaise: 850000 },
    { name: '201', floor: 2, sharingType: 2, rentPaise: 1100000 },
  ];
  const rooms = [];
  for (const r of roomDefs) {
    rooms.push(
      await prisma.room.create({
        data: { ...r, propertyId: property.id, beds: { create: Array.from({ length: r.sharingType }, (_, i) => ({ label: String.fromCharCode(65 + i) })) } },
        include: { beds: { orderBy: { label: 'asc' } } },
      }),
    );
  }

  const today = todayIST();
  const tenants = [
    { phone: '+919000000011', name: 'Arjun Mehta', bed: rooms[0].beds[0], rent: 850000, join: addDays(startOfMonth(today), -40), occupation: 'Software engineer', workplace: 'Infosys' },
    { phone: '+919000000012', name: 'Vikram Rao', bed: rooms[0].beds[1], rent: 850000, join: addDays(startOfMonth(today), -10), occupation: 'Student', workplace: 'Christ University' },
    { phone: '+919000000013', name: 'Imran Shaikh', bed: rooms[2].beds[0], rent: 1100000, join: startOfMonth(today), occupation: 'Analyst', workplace: 'Deloitte' },
  ];

  for (const t of tenants) {
    const user = await prisma.user.upsert({ where: { phone: t.phone }, update: {}, create: { phone: t.phone, name: t.name, role: 'TENANT' } });
    await prisma.$transaction(async (tx) => {
      const tenancy = await createTenancy(tx, {
        actorId: owner.id,
        propertyId: property.id,
        bedId: t.bed.id,
        tenantUserId: user.id,
        startDate: t.join,
        rentPaise: t.rent,
        depositPaise: t.rent * 2,
        depositCollectedPaise: t.rent * 2,
        charges: t.name === 'Arjun Mehta' ? [{ name: 'Food (veg)', amountPaise: 300000 }] : [],
      });
      await tx.tenantProfile.update({
        where: { id: tenancy.tenantProfileId },
        data: { occupation: t.occupation, workplace: t.workplace, guardianName: 'Parent', guardianPhone: '+919000000099' },
      });
      await generateInvoicesForTenancy(tx, tenancy.id, today);
    });
  }

  await prisma.notice.create({
    data: { propertyId: property.id, authorId: owner.id, title: 'Water supply maintenance', body: 'Water supply will be off on Sunday 10 am to 1 pm for tank cleaning.' },
  });

  console.log('Seeded:');
  console.log(`  admin ${admin.phone}, owner ${owner.phone}, staff ${staff.phone}`);
  console.log(`  property "${property.name}" (invite code ${property.inviteCode}) with 3 rooms / 8 beds`);
  console.log(`  tenants: ${tenants.map((t) => t.phone).join(', ')}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
