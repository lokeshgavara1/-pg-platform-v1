import { createRemoteJWKSet, jwtVerify } from 'jose';
import { env } from '../config/env.js';

/**
 * "Sign in with Google" through Firebase Authentication (free on the Spark plan; no SMS).
 * The browser signs in with Google and sends us a Firebase ID token. We verify it against
 * Google's public keys using only the Firebase project id — no service-account secret.
 * https://firebase.google.com/docs/auth/admin/verify-id-tokens#verify_id_tokens_using_a_third-party_jwt_library
 */
export interface GoogleIdentity {
  uid: string; // Firebase user id (stable per Google account per project)
  email: string | null; // only when Google says it is verified
  name: string | null;
  provider: string; // 'google.com' for Google sign-in
}

export type GoogleTokenVerifier = (idToken: string) => Promise<GoogleIdentity>;

const FIREBASE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'));

export function firebaseTokenVerifier(projectId: string): GoogleTokenVerifier {
  return async (idToken) => {
    const { payload } = await jwtVerify(idToken, FIREBASE_JWKS, {
      algorithms: ['RS256'],
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
      clockTolerance: 30,
    });
    if (typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.sub.length > 128) throw new Error('Token has no subject');
    if (typeof payload.auth_time !== 'number' || payload.auth_time * 1000 > Date.now() + 30_000) throw new Error('Bad auth_time');
    const fb = (payload.firebase ?? {}) as { sign_in_provider?: string };
    return {
      uid: payload.sub,
      email: payload.email_verified === true && typeof payload.email === 'string' ? payload.email.toLowerCase() : null,
      name: typeof payload.name === 'string' ? payload.name : null,
      provider: fb.sign_in_provider ?? 'unknown',
    };
  };
}

let override: GoogleTokenVerifier | null = null;

/** The active verifier, or null when Google sign-in is not configured on this server. */
export function googleVerifier(): GoogleTokenVerifier | null {
  if (override) return override;
  return env.FIREBASE_PROJECT_ID ? firebaseTokenVerifier(env.FIREBASE_PROJECT_ID) : null;
}

/** Tests replace Google with a fake verifier. */
export function setGoogleTokenVerifier(v: GoogleTokenVerifier | null) {
  override = v;
}
