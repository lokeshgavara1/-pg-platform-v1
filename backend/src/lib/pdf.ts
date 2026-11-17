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
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Producer: 'PG Platform', Creator: 'PG Platform' } });
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
