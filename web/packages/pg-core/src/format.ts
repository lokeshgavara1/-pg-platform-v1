/** Money is integer paise everywhere; these helpers only format and parse at the edges. */
export function formatINR(paise: number | null | undefined, opts: { decimals?: 'auto' | 'always' } = {}): string {
  if (paise === null || paise === undefined) return '—';
  const neg = paise < 0;
  const abs = Math.abs(Math.trunc(paise));
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  const s = String(rupees);
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const grouped = rest ? `${rest},${last3}` : last3;
  const showDec = opts.decimals === 'always' || p !== 0;
  return `${neg ? '−' : ''}₹${grouped}${showDec ? '.' + String(p).padStart(2, '0') : ''}`;
}

/** Parse a rupee amount typed by a person ("8,500", "8500.50") into integer paise. Returns null if invalid. */
export function parseRupees(input: string): number | null {
  const s = input.replace(/[,\s₹]/g, '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export interface UpiDetails {
  upiId: string;
  payeeName: string;
}

/**
 * Standard UPI payment link (NPCI "upi://pay"). On a phone it opens GPay / PhonePe / Paytm / BHIM
 * with the payee, exact amount and a note filled in. Money goes straight to the owner — free.
 */
export function upiPayUri(upi: UpiDetails, amountPaise: number, note: string): string {
  const rupees = `${Math.floor(amountPaise / 100)}.${String(amountPaise % 100).padStart(2, '0')}`;
  const params = [
    `pa=${upi.upiId}`, // UPI IDs only contain URL-safe characters; some apps reject an encoded "@"
    `pn=${encodeURIComponent(upi.payeeName)}`,
    `am=${rupees}`,
    'cu=INR',
    `tn=${encodeURIComponent(note.slice(0, 50))}`,
  ];
  return `upi://pay?${params.join('&')}`;
}

/** UPI app links only work on phones. */
export function isPhone(): boolean {
  return typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export function paiseToInput(paise: number): string {
  const r = Math.floor(paise / 100);
  const p = paise % 100;
  return p ? `${r}.${String(p).padStart(2, '0')}` : String(r);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Format a date-only value ("2026-11-05" or ISO) as "5 Nov 2026" without timezone drift. */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const iso = typeof value === 'string' ? value : value.toISOString();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return '—';
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

export function monthLabel(value: string | null | undefined): string {
  if (!value) return '';
  const m = /^(\d{4})-(\d{2})/.exec(value);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '';
}

/** Today's date in India as YYYY-MM-DD. */
export function todayIST(offsetDays = 0): string {
  const d = new Date(Date.now() + 5.5 * 3600e3 + offsetDays * 86400e3);
  return d.toISOString().slice(0, 10);
}

export function maskPhone(phone: string) {
  return phone.replace(/^\+91/, '').replace(/(\d{5})(\d{5})/, '$1 $2');
}

export function pct(bps: number) {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;
}

export function titleCase(s: string) {
  return s
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
