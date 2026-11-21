import { useEffect, useState } from 'react';
import type { ApiClient } from './api';

/** What this server offers (GET /api/auth/config). Production: Google sign-in, no OTP, paper signing. */
export interface ServerConfig {
  otpLogin: boolean;
  googleLogin: boolean;
  esign: boolean;
  onlineGateway: boolean;
}

/** If the server can't be reached, offer everything and let the server answer per request. */
const FALLBACK: ServerConfig = { otpLogin: true, googleLogin: true, esign: true, onlineGateway: true };

let cached: Promise<ServerConfig> | null = null;

export function loadServerConfig(client: ApiClient): Promise<ServerConfig> {
  if (!cached) {
    cached = client.get<ServerConfig>('/api/auth/config').catch(() => {
      cached = null; // try again next time
      return FALLBACK;
    });
  }
  return cached;
}

/** For tests. */
export function resetServerConfigCache() {
  cached = null;
}

export function useServerConfig(client: ApiClient): ServerConfig | null {
  const [cfg, setCfg] = useState<ServerConfig | null>(null);
  useEffect(() => {
    let alive = true;
    void loadServerConfig(client).then((c) => alive && setCfg(c));
    return () => {
      alive = false;
    };
  }, [client]);
  return cfg;
}
