/**
 * API client shared by all apps: bearer tokens, automatic (single-flight) refresh
 * on 401, and typed errors that mirror the backend's { error: { code, message, details } } shape.
 */
export type AppKind = 'owner' | 'tenant' | 'admin';
export type Role = 'OWNER' | 'TENANT' | 'STAFF' | 'ADMIN';

export interface SessionUser {
  id: string;
  name: string;
  role: Role;
  phone: string;
}

export interface Session {
  user: SessionUser;
  accessToken: string;
  refreshToken: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

/** Where tokens live. Swap for a more secure store if the apps are wrapped natively. */
export interface TokenStore {
  load(): Session | null;
  save(s: Session | null): void;
}

export function localTokenStore(key: string): TokenStore {
  return {
    load() {
      try {
        const raw = localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as Session) : null;
      } catch {
        return null;
      }
    },
    save(s) {
      try {
        if (s) localStorage.setItem(key, JSON.stringify(s));
        else localStorage.removeItem(key);
      } catch {
        /* storage unavailable (private mode): session lives in memory only */
      }
    },
  };
}

export function memoryTokenStore(): TokenStore {
  let s: Session | null = null;
  return { load: () => s, save: (v) => (s = v) };
}

type Listener = (s: Session | null) => void;

export class ApiClient {
  private session: Session | null;
  private refreshing: Promise<boolean> | null = null;
  private listeners = new Set<Listener>();

  constructor(
    public readonly baseUrl: string,
    private store: TokenStore,
    private fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {
    this.session = store.load();
  }

  getSession() {
    return this.session;
  }

  setSession(s: Session | null) {
    this.session = s;
    this.store.save(s);
    this.listeners.forEach((l) => l(s));
  }

  onSessionChange(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private url(path: string) {
    return `${this.baseUrl}${path}`;
  }

  private async raw(method: string, path: string, body?: unknown, auth = true): Promise<Response> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth && this.session) headers.authorization = `Bearer ${this.session.accessToken}`;
    try {
      return await this.fetchImpl(this.url(path), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your internet connection and try again.');
    }
  }

  private async refresh(): Promise<boolean> {
    if (!this.session) return false;
    if (!this.refreshing) {
      const token = this.session.refreshToken;
      this.refreshing = (async () => {
        try {
          const r = await this.raw('POST', '/api/auth/refresh', { refreshToken: token }, false);
          if (!r.ok) {
            this.setSession(null);
            return false;
          }
          const data = await r.json();
          this.setSession({ user: data.user, accessToken: data.accessToken, refreshToken: data.refreshToken });
          return true;
        } finally {
          this.refreshing = null;
        }
      })();
    }
    return this.refreshing;
  }

  private async send(method: string, path: string, body?: unknown): Promise<Response> {
    let res = await this.raw(method, path, body);
    if (res.status === 401 && this.session && !path.startsWith('/api/auth/')) {
      if (await this.refresh()) res = await this.raw(method, path, body);
    }
    if (!res.ok) {
      let err: { code?: string; message?: string; details?: unknown } = {};
      try {
        err = (await res.json()).error ?? {};
      } catch {
        /* non-JSON */
      }
      throw new ApiError(res.status, err.code ?? 'HTTP_ERROR', err.message ?? `Request failed (${res.status})`, err.details);
    }
    return res;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.send(method, path, body);
    return (await res.json()) as T;
  }

  get<T>(path: string) {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body: unknown = {}) {
    return this.request<T>('POST', path, body);
  }
  patch<T>(path: string, body: unknown) {
    return this.request<T>('PATCH', path, body);
  }

  /** Fetch a binary (PDF/CSV) with auth and return a Blob. */
  async blob(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Blob> {
    const res = await this.send(method, path, body);
    return res.blob();
  }

  // ---- auth ----
  requestOtp(phone: string) {
    return this.request<{ ok: true; expiresInSeconds: number }>('POST', '/api/auth/request-otp', { phone });
  }

  async verifyOtp(phone: string, code: string, app: AppKind, name?: string) {
    const data = await this.request<{ user: SessionUser; accessToken: string; refreshToken: string }>('POST', '/api/auth/verify-otp', { phone, code, app, name });
    return data;
  }

  async logout() {
    const s = this.session;
    this.setSession(null);
    if (s) await this.raw('POST', '/api/auth/logout', { refreshToken: s.refreshToken }, false).catch(() => undefined);
  }
}

export interface Paged<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
