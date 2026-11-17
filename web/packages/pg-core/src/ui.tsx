import { useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { NavLink } from 'react-router-dom';
import { formatINR, parseRupees, paiseToInput, titleCase } from './format';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';

export function Button({ variant = 'primary', small, block, busy, children, className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; small?: boolean; block?: boolean; busy?: boolean }) {
  const cls = ['btn', variant !== 'primary' && variant, small && 'small', block && 'block', className].filter(Boolean).join(' ');
  return (
    <button className={cls} disabled={busy || rest.disabled} {...rest}>
      {busy ? <span className="spinner" style={{ width: 16, height: 16, borderWidth: 2, margin: 0 }} aria-hidden /> : null}
      {children}
    </button>
  );
}

export function Card({ children, ledger, className = '', ...rest }: { children: ReactNode; ledger?: boolean; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`card ${ledger ? 'ledger' : ''} ${className}`} {...rest}>
      {children}
    </div>
  );
}

export function PageHead({ eyebrow, title, sub, actions }: { eyebrow?: string; title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {sub && <div className="muted" style={{ marginTop: 4 }}>{sub}</div>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <label className="field">
      <span className="lbl">{label}</span>
      {children}
      {hint && !error && <span className="hint">{hint}</span>}
      {error && <span className="err">{error}</span>}
    </label>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className="input" {...props} />;
}
export function Select({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className="input" {...props}>
      {children}
    </select>
  );
}
export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className="input" {...props} />;
}

/** Rupee input that reports integer paise (or null when empty/invalid). */
export function MoneyInput({ value, onChange, placeholder = '0', allowZero = true, ...rest }: { value: number | null; onChange: (paise: number | null) => void; placeholder?: string; allowZero?: boolean; autoFocus?: boolean; id?: string }) {
  const [text, setText] = useState(value === null ? '' : paiseToInput(value));
  useEffect(() => {
    const parsed = parseRupees(text);
    if (parsed !== value) setText(value === null ? '' : paiseToInput(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <div className="prefix">
      <span className="sym">₹</span>
      <input
        className="input money-input"
        inputMode="decimal"
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const p = parseRupees(e.target.value);
          onChange(p === null || (!allowZero && p === 0) ? null : p);
        }}
        {...rest}
      />
    </div>
  );
}

export function Money({ paise, className = '' }: { paise: number | null | undefined; className?: string }) {
  return <span className={`money ${className}`}>{formatINR(paise)}</span>;
}

const STATUS_TONE: Record<string, string> = {
  PAID: 'ok', APPROVED: 'ok', ACTIVE: 'ok', SIGNED: 'ok', RESOLVED: 'ok', ACKNOWLEDGED: 'ok', COMPLETED: 'ok', CONVERTED: 'ok', OCCUPIED: 'primary', SUCCESS: 'ok', PROCESSED: 'ok',
  DUE: 'warn', PARTIAL: 'warn', PENDING: 'warn', RESERVED: 'warn', NOTICE: 'warn', IN_PROGRESS: 'info', OPEN: 'warn', SUBMITTED: 'info', REQUESTED: 'warn', ACCEPTED: 'info', SETTLEMENT_PROPOSED: 'info', TENANT_ACCEPTED: 'info', DRAFT: 'warn', CREATED: 'info',
  OVERDUE: 'danger', REJECTED: 'danger', EXPIRED: 'danger', CANCELLED: 'danger', DISPUTED: 'danger', FAILED: 'danger', DEACTIVATED: 'danger',
  VOID: '', ENDED: '', CLOSED: '', NOT_STARTED: '', NOT_SUBMITTED: '', INACTIVE: '', VACANT: '', IGNORED: '',
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <span className={`badge ${STATUS_TONE[status] ?? ''}`}>{label ?? titleCase(status)}</span>;
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="state" role="status">
      <div className="spinner" />
      <div className="faint" style={{ marginTop: 10 }}>{label}</div>
    </div>
  );
}

export function EmptyState({ title, children, glyph = '∅' }: { title: string; children?: ReactNode; glyph?: string }) {
  return (
    <div className="state">
      <div className="glyph">{glyph}</div>
      <h3>{title}</h3>
      {children && <div className="muted" style={{ marginTop: 6 }}>{children}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state" role="alert">
      <div className="glyph">!</div>
      <h3>Couldn’t load this</h3>
      <p className="muted">{message}</p>
      {onRetry && <Button variant="secondary" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

/** Standard loading / error / empty handling for a useAsync result. */
export function Async<T>({ state, empty, children }: { state: { data: T | undefined; error: string | null; loading: boolean; reload: () => void }; empty?: (d: T) => ReactNode | null; children: (d: T) => ReactNode }) {
  if (state.loading && state.data === undefined) return <Spinner />;
  if (state.error && state.data === undefined) return <ErrorState message={state.error} onRetry={state.reload} />;
  if (state.data === undefined) return null;
  const e = empty?.(state.data);
  if (e) return <>{e}</>;
  return <>{children(state.data)}</>;
}

export function Alert({ children, tone = 'danger' }: { children: ReactNode; tone?: 'danger' | 'info' | 'warn' | 'ok' }) {
  if (!children) return null;
  return <div className={`alert ${tone === 'danger' ? '' : tone}`} role={tone === 'danger' ? 'alert' : 'status'}>{children}</div>;
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="grip" />
        <div className="row between" style={{ marginBottom: 14 }}>
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div className="tabs" role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value, sub, hero, meter }: { label: string; value: ReactNode; sub?: ReactNode; hero?: boolean; meter?: number }) {
  return (
    <div className={`card stat ${hero ? 'hero' : ''}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
      {meter !== undefined && (
        <div className="meter" aria-hidden>
          <span style={{ width: `${Math.max(0, Math.min(100, meter))}%` }} />
        </div>
      )}
    </div>
  );
}

export function Initials({ name }: { name: string }) {
  const i = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
  return <div className="avatar" aria-hidden>{i || '?'}</div>;
}

export interface NavItem {
  to: string;
  label: string;
  icon: string;
  end?: boolean;
}

export function BottomNav({ items }: { items: NavItem[] }) {
  return (
    <nav className="bottomnav" aria-label="Main">
      {items.map((i) => (
        <NavLink key={i.to} to={i.to} end={i.end} className={({ isActive }) => (isActive ? 'active' : '')}>
          <span className="ico" aria-hidden>{i.icon}</span>
          <span>{i.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

let toastSetter: ((m: string | null) => void) | null = null;
export function toast(message: string) {
  toastSetter?.(message);
}
export function ToastHost() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    toastSetter = setMsg;
    return () => {
      toastSetter = null;
    };
  }, []);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 2800);
    return () => clearTimeout(t);
  }, [msg]);
  return msg ? <div className="toast" role="status">{msg}</div> : null;
}
