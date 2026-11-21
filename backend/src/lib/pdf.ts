import PDFDocument from 'pdfkit';

/** Standard PDF fonts cannot draw the ₹ sign, so PDFs use "Rs.". */
export function pdfMoney(paise: number): string {
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  const s = String(rupees);
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}Rs. ${rest ? rest + ',' + last3 : last3}.${String(p).padStart(2, '0')}`;
}

export function renderPdf(draw: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Producer: 'PGPAL', Creator: 'PGPAL' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      draw(doc);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/** PGPAL brand colours and logo, drawn as vectors (same geometry as brand/pgpal-mark.svg). */
export const BRAND_GREEN = '#1F4436';
export const BRAND_MARIGOLD = '#D19442';

export function drawBrandHeader(doc: PDFKit.PDFDocument, x = 50, y = 46, size = 30) {
  doc.save();
  doc.translate(x, y).scale(size / 100, (size / 100) * 0.969);
  doc.roundedRect(0, 0, 18.5, 100, 4.5).fill(BRAND_GREEN);
  doc.path('M0 0 H42 A22 22 0 0 1 64 22 V35 A22 22 0 0 1 42 57 H25 V39 H38 A8 8 0 0 0 46 31 V26 A7 7 0 0 0 39 19 H0 Z').fill(BRAND_GREEN);
  doc.path('M28 65.5 H46 V71 A12 12 0 0 0 58 83 H83 V65 H66 V47 H96 A4 4 0 0 1 100 51 V96 A4 4 0 0 1 96 100 H53 A25 25 0 0 1 28 75 Z').fill(BRAND_GREEN);
  doc.path('M61 0 H95 A5 5 0 0 1 100 5 V40 Q100 44 97.5 42.5 Z').fill(BRAND_MARIGOLD);
  doc.restore();
  doc.font('Helvetica-Bold').fontSize(16).fillColor(BRAND_GREEN).text('PGPAL', x + size + 10, y + size / 2 - 8, { characterSpacing: 1.5, lineBreak: false });
  doc.fillColor('#111').font('Helvetica');
  doc.x = 50;
  doc.y = y + size + 18;
}

export function table(doc: PDFKit.PDFDocument, rows: [string, string][], opts: { x?: number; width?: number } = {}) {
  const x = opts.x ?? 50;
  const width = opts.width ?? 495;
  for (const [label, value] of rows) {
    const y = doc.y;
    doc.font('Helvetica').fontSize(10).fillColor('#555').text(label, x, y, { width: width * 0.45 });
    doc.font('Helvetica').fontSize(10).fillColor('#111').text(value, x + width * 0.45, y, { width: width * 0.55, align: 'right' });
    doc.moveDown(0.4);
  }
  doc.fillColor('#111');
}
