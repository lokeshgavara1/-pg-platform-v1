/**
 * Structured JSON logger. Never pass personal data (phones, names, ID numbers),
 * OTPs or secrets. `redact` masks anything that looks like a phone number as a safety net.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

const PHONE_RE = /\+?\d[\d\s-]{8,}\d/g;

export function redact(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(PHONE_RE, '[redacted]');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (/phone|otp|code|token|secret|password|authorization|idnumber/i.test(k)) out[k] = '[redacted]';
      else out[k] = redact(v);
    }
    return out;
  }
  return value;
}

let silent = process.env.NODE_ENV === 'test';

function write(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (silent && level !== 'error') return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(redact(fields ?? {}) as object) });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const logger = {
  debug: (msg: string, f?: Record<string, unknown>) => write('debug', msg, f),
  info: (msg: string, f?: Record<string, unknown>) => write('info', msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => write('warn', msg, f),
  error: (msg: string, f?: Record<string, unknown>) => write('error', msg, f),
  setSilent: (v: boolean) => {
    silent = v;
  },
};

/** Error-reporting hook. Plug Sentry or similar in here; default writes a structured log line. */
export type ErrorReporter = (err: unknown, context: Record<string, unknown>) => void;
let reporter: ErrorReporter = (err, context) => {
  const e = err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : { err: String(err) };
  write('error', 'unhandled_error', { ...context, error: e });
};
export function setErrorReporter(r: ErrorReporter) {
  reporter = r;
}
export function reportError(err: unknown, context: Record<string, unknown> = {}) {
  reporter(err, context);
}
