import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prisma } from '../../lib/prisma.js';
import { drawBrandHeader, pdfMoney, renderPdf } from '../../lib/pdf.js';
import { toDateString, todayIST } from '../../lib/dates.js';

const TEMPLATE_PATH = fileURLToPath(new URL('../../../../docs/agreement-template.md', import.meta.url));

export function fillTemplate(template: string, values: Record<string, string>) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => values[k] ?? `[${k}]`);
}

function drawMarkdown(doc: PDFKit.PDFDocument, md: string) {
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith('# ')) doc.font('Helvetica-Bold').fontSize(16).text(line.slice(2), { align: 'center' }).moveDown(0.6);
    else if (line.startsWith('## ')) doc.moveDown(0.3).font('Helvetica-Bold').fontSize(12).text(line.slice(3)).moveDown(0.2);
    else if (line.startsWith('- ')) doc.font('Helvetica').fontSize(10).text(`•  ${line.slice(2)}`, { indent: 10 });
    else if (line === '') doc.moveDown(0.4);
    else doc.font('Helvetica').fontSize(10).text(line, { align: 'justify' });
  }
}

export async function agreementValues(tenancyId: string) {
  const t = await prisma.tenancy.findUniqueOrThrow({
    where: { id: tenancyId },
    include: {
      property: { include: { owner: true } },
      bed: { include: { room: true } },
      tenantProfile: { include: { user: true } },
      charges: { where: { status: 'ACTIVE' } },
    },
  });
  return {
    agreementDate: toDateString(todayIST()),
    ownerName: t.property.owner.name,
    ownerPhone: t.property.owner.phone,
    tenantName: t.tenantProfile.user.name,
    tenantPhone: t.tenantProfile.user.phone,
    propertyName: t.property.name,
    propertyAddress: t.property.address,
    city: t.property.city,
    room: t.bed.room.name,
    bed: t.bed.label,
    startDate: toDateString(t.startDate),
    rent: pdfMoney(t.rentPaise),
    rentDueDay: String(t.property.rentDueDay),
    deposit: pdfMoney(t.depositPaise),
    minNoticeDays: String(t.property.minNoticeDays),
    charges: t.charges.length ? t.charges.map((c) => `${c.name} ${pdfMoney(c.amountPaise)}`).join(', ') : 'none',
  };
}

export async function agreementPdf(tenancyId: string, signature?: { name: string; at: Date; provider: string; devOnly: boolean }) {
  const md = fillTemplate(readFileSync(TEMPLATE_PATH, 'utf8'), await agreementValues(tenancyId));
  return renderPdf((doc) => {
    drawBrandHeader(doc);
    drawMarkdown(doc, md);
    if (signature) {
      doc.addPage();
      doc.font('Helvetica-Bold').fontSize(14).text('Signature record');
      doc.moveDown();
      doc.font('Helvetica').fontSize(10).text(`Signed by: ${signature.name}`);
      doc.text(`Signed at: ${signature.at.toISOString()}`);
      doc.text(`Method: ${signature.provider} (OTP confirmation on registered mobile)`);
      if (signature.devOnly) {
        doc.moveDown();
        doc.font('Helvetica-Bold').fontSize(16).fillColor('#b00020').text('TEST SIGNATURE - NOT LEGALLY VALID', { align: 'center' });
        doc.font('Helvetica').fontSize(10).text('This document was signed with a development e-sign provider for testing only.', { align: 'center' });
        doc.fillColor('#111');
      }
    }
  });
}
