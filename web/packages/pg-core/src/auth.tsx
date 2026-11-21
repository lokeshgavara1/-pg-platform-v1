import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiClient, localTokenStore, type AppKind, type Role, type Session } from './api';

/** Which roles each app accepts. The backend enforces the same rule. */
export const APP_ROLES: Record<AppKind, Role[]> = {
  owner: ['OWNER', 'STAFF'],
  tenant: ['TENANT'],
  admin: ['ADMIN'],
};

export const WRONG_APP_MESSAGE: Record<AppKind, string> = {
  owner: 'This number is registered as a tenant. Please use the tenant app.',
  tenant: 'This number is registered as an owner or staff account. Please use the owner app.',
  admin: 'This account is not an admin.',
};

interface AuthValue {
  app: AppKind;
  client: ApiClient;
  session: Session | null;
  login(phone: string, code: string, name?: string): Promise<void>;
  loginWithGoogle(idToken: string, extra?: { name?: string; phone?: string; linkToken?: string }): Promise<void>;
  logout(): Promise<void>;
}

const Ctx = createContext<AuthValue | null>(null);

export function createClient(app: AppKind) {
  const base = (import.meta.env?.VITE_API_BASE_URL as string | undefined) ?? '';
  return new ApiClient(base, localTokenStore(`pg-${app}-session`));
}

export function AuthProvider({ app, client, children }: { app: AppKind; client: ApiClient; children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => {
    const s = client.getSession();
    // A stored session from the wrong kind of account is discarded.
    return s && APP_ROLES[app].includes(s.user.role) ? s : null;
  });

  useEffect(() => client.onSessionChange(setSession) as unknown as () => void, [client]);

  const value = useMemo<AuthValue>(
    () => ({
      app,
      client,
      session,
      async login(phone, code, name) {
        const r = await client.verifyOtp(phone, code, app, name);
        if (!APP_ROLES[app].includes(r.user.role)) throw new Error(WRONG_APP_MESSAGE[app]);
        client.setSession({ user: r.user, accessToken: r.accessToken, refreshToken: r.refreshToken });
      },
      async loginWithGoogle(idToken, extra = {}) {
        const r = await client.googleLogin({ idToken, app, ...extra });
        if (!APP_ROLES[app].includes(r.user.role)) throw new Error(WRONG_APP_MESSAGE[app]);
        client.setSession({ user: r.user, accessToken: r.accessToken, refreshToken: r.refreshToken });
      },
      logout: () => client.logout(),
    }),
    [app, client, session],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}

export function useApi() {
  return useAuth().client;
}
