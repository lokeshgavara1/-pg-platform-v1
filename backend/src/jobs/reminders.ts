/**
 * Rent reminders: 3 days before the due date, on the due date, and 3 days after —
 * through every MessageProvider channel. Never sent between 9 pm and 8 am India time
 * (the hourly job simply skips; the next daytime run sends). Each (invoice, offset)
 * is sent at most once (unique ReminderLog row).
 */
import { prisma, isUniqueViolation } from '../lib/prisma.js';
import { addDays, diffDays, isQuietHoursIST, todayIST, toDateString } from '../lib/dates.js';
import { formatINR } from '../lib/money.js';
import { notify } from '../providers/message.js';

export const REMINDER_OFFSETS = [-3, 0, 3] as const;

export function reminderText(offset: number, amountPaise: number, dueDate: Date, propertyName: string) {
  const amt = formatINR(amountPaise);
  if (offset < 0) return { title: 'Rent due soon', body: `${amt} rent for ${propertyName} is due on ${toDateString(dueDate)}.` };
  if (offset === 0) return { title: 'Rent due today', body: `${amt} rent for ${propertyName} is due today.` };
  return { title: 'Rent overdue', body: `${amt} rent for ${propertyName} was due on ${toDateString(dueDate)}. Please pay as soon as possible.` };
}

export async function runRentReminders(now = new Date()) {
  if (isQuietHoursIST(now)) return { skipped: 'quiet-hours', sent: 0 };
  const today = todayIST(now);
  // Only invoices whose due date is today+3, today or today−3 can match an offset.
  const dueDates = REMINDER_OFFSETS.map((o) => addDays(today, -o));
  const invoices = await prisma.invoice.findMany({
    where: {
      kind: 'RENT',
      status: { in: ['DUE', 'PARTIAL'] },
      dueDate: { in: dueDates },
      property: { remindersEnabled: true, status: 'ACTIVE' },
      tenancy: { status: { in: ['ACTIVE', 'NOTICE'] } },
    },
    include: { property: true, tenancy: { include: { tenantProfile: true } }, reminders: true },
  });
  let sent = 0;
  for (const inv of invoices) {
    const offset = diffDays(inv.dueDate, today);
    if (!REMINDER_OFFSETS.includes(offset as (typeof REMINDER_OFFSETS)[number])) continue;
    if (inv.reminders.some((r) => r.offsetDays === offset)) continue;
    try {
      // Claim first so two concurrent runs cannot both send.
      const log = await prisma.reminderLog.create({ data: { invoiceId: inv.id, offsetDays: offset, channels: '' } });
      const { title, body } = reminderText(offset, inv.totalPaise - inv.paidPaise, inv.dueDate, inv.property.name);
      const channels = await notify({ userId: inv.tenancy!.tenantProfile.userId, title, body });
      await prisma.reminderLog.update({ where: { id: log.id }, data: { channels: channels.join(',') } });
      sent++;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  return { sent };
}
