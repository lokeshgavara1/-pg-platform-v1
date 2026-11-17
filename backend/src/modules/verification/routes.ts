import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { idParam, parse } from '../../lib/http.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { toDateString } from '../../lib/dates.js';
import { renderPdf } from '../../lib/pdf.js';
import { me, requireRole } from '../auth/middleware.js';
import { managedPropertyIds } from '../access.js';
import { getCity, listCities } from './cities.js';

export const verificationRouter = Router();

verificationRouter.get('/cities', requireRole('OWNER', 'STAFF'), (_req, res) => {
  res.json({ items: listCities().map((c) => ({ code: c.code, name: c.name, authority: c.authority, verified: c.verified, note: c.note, fields: c.fields })) });
});

const recordInclude = {
  tenancy: {
    include: {
      property: { include: { owner: true } },
      bed: { include: { room: true } },
      tenantProfile: { include: { user: true } },
    },
  },
} as const;

verificationRouter.get('/verification', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const q = parse(z.object({ propertyId: z.string().optional(), status: z.enum(['NOT_STARTED', 'SUBMITTED', 'ACKNOWLEDGED']).optional() }), req.query);
  const ids = await managedPropertyIds(user);
  const rows = await prisma.verificationRecord.findMany({
    where: {
      tenancy: { propertyId: { in: q.propertyId ? ids.filter((i) => i === q.propertyId) : ids }, status: { in: ['ACTIVE', 'NOTICE'] } },
      ...(q.status ? { status: q.status } : {}),
    },
    orderBy: { createdAt: 'asc' },
    include: {
      tenancy: {
        select: {
          id: true,
          startDate: true,
          property: { select: { name: true, cityCode: true } },
          bed: { select: { label: true, room: { select: { name: true } } } },
          tenantProfile: { select: { kycStatus: true, user: { select: { name: true } } } },
        },
      },
    },
  });
  res.json({ items: rows });
});

verificationRouter.patch('/verification/:id', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const input = parse(
    z.object({ status: z.enum(['NOT_STARTED', 'SUBMITTED', 'ACKNOWLEDGED']), reference: z.string().trim().max(100).optional(), notes: z.string().trim().max(500).optional() }),
    req.body,
  );
  const r = await prisma.verificationRecord.findFirst({ where: { id, tenancy: { property: { ownerId: user.id } } } });
  if (!r) throw notFound('Verification record');
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.verificationRecord.update({
      where: { id },
      data: {
        status: input.status,
        reference: input.reference,
        notes: input.notes,
        submittedAt: input.status !== 'NOT_STARTED' ? (r.submittedAt ?? new Date()) : null,
        acknowledgedAt: input.status === 'ACKNOWLEDGED' ? (r.acknowledgedAt ?? new Date()) : null,
      },
    });
    await audit(tx, { actorId: user.id, action: 'VERIFICATION_STATUS_CHANGED', entityType: 'VerificationRecord', entityId: id, before: { status: r.status }, after: { status: u.status } });
    return u;
  });
  res.json(updated);
});

type Rec = Awaited<ReturnType<typeof loadRecords>>[number];

async function loadRecords(ownerId: string, tenancyIds: string[]) {
  return prisma.verificationRecord.findMany({ where: { tenancyId: { in: tenancyIds }, tenancy: { property: { ownerId } } }, include: recordInclude });
}

function valueFor(rec: Rec, source: string): string {
  const t = rec.tenancy;
  const p = t.tenantProfile;
  switch (source) {
    case 'user.name': return p.user.name;
    case 'user.phone': return p.user.phone;
    case 'profile.fatherName': return p.fatherName ?? '';
    case 'profile.permanentAddress': return p.permanentAddress ?? '';
    case 'profile.idType': return p.idType ?? '';
    case 'profile.idLast4': return p.idLast4 ? `XXXX${p.idLast4}` : '';
    case 'profile.occupation': return p.occupation ?? '';
    case 'profile.workplace': return p.workplace ?? '';
    case 'profile.guardianPhone': return [p.guardianName, p.guardianPhone].filter(Boolean).join(' ');
    case 'tenancy.startDate': return toDateString(t.startDate);
    case 'tenancy.roomBed': return `${t.bed.room.name} / ${t.bed.label}`;
    case 'property.address': return `${t.property.name}, ${t.property.address}`;
    case 'owner.name': return t.property.owner.name;
    default: return '';
  }
}

const csvCell = (v: string) => {
  // Neutralise spreadsheet formula injection and quote everything.
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return `"${safe.replace(/"/g, '""')}"`;
};

verificationRouter.post('/verification/export', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { tenancyIds, format } = parse(z.object({ tenancyIds: z.array(z.string()).min(1).max(200), format: z.enum(['csv', 'pdf']) }), req.body);
  const recs = await loadRecords(user.id, tenancyIds);
  if (recs.length !== new Set(tenancyIds).size) throw notFound('Tenant');
  const cityCodes = new Set(recs.map((r) => r.tenancy.property.cityCode));
  if (cityCodes.size > 1) throw badRequest('Export tenants from one city at a time');
  const city = getCity([...cityCodes][0]);
  if (!city) throw badRequest('No compliance config for this city');
  await audit(prisma, { actorId: user.id, action: 'VERIFICATION_EXPORTED', entityType: 'VerificationRecord', entityId: recs.map((r) => r.id).join(','), after: { format, count: recs.length, city: city.code } });

  if (format === 'csv') {
    const header = city.fields.map((f) => csvCell(f.label)).join(',');
    const rows = recs.map((r) => city.fields.map((f) => csvCell(valueFor(r, f.source))).join(','));
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="verification-${city.code}-${toDateString(new Date())}.csv"`);
    res.send('﻿' + [header, ...rows].join('\r\n'));
    return;
  }
  const pdf = await renderPdf((doc) => {
    recs.forEach((r, i) => {
      if (i > 0) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(14).text('Tenant details for police verification');
      doc.font('Helvetica').fontSize(9).fillColor('#555').text(`${city.name} — ${city.authority}`);
      if (!city.verified) doc.fillColor('#b00020').text('Field list not yet confirmed with the local authority.');
      doc.fillColor('#111').moveDown();
      for (const f of city.fields) {
        doc.font('Helvetica-Bold').fontSize(10).text(f.label, { continued: true }).font('Helvetica').text(`:  ${valueFor(r, f.source) || '—'}`);
        doc.moveDown(0.3);
      }
      doc.moveDown(2).fontSize(10).text('Owner signature: ______________________     Date: ____________');
    });
  });
  res.setHeader('content-type', 'application/pdf');
  res.setHeader('content-disposition', `attachment; filename="verification-${city.code}-${toDateString(new Date())}.pdf"`);
  res.send(pdf);
});
