/**
 * Free "Sign in with Google" through Firebase Authentication (Spark plan; no SMS).
 *
 * These Firebase web settings are PUBLIC by design — they ship inside every website that
 * uses Firebase. Protection comes from Firebase's "Authorized domains" list and from the
 * backend verifying every token. Override them with VITE_FIREBASE_* variables for another project.
 */
const env = (import.meta.env ?? {}) as Record<string, string | undefined>;

export const firebaseWebConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY ?? 'AIzaSyCCCHGzinow2GxkCggNHUDRy-MVhPc8EfM',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN ?? 'pg-platform-e8a57.firebaseapp.com',
  projectId: env.VITE_FIREBASE_PROJECT_ID ?? 'pg-platform-e8a57',
  appId: env.VITE_FIREBASE_APP_ID ?? '1:370029399581:web:3bda51aa77fe3bd87b40f4',
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '370029399581',
};

export const googleSignInAvailable = Boolean(firebaseWebConfig.apiKey && env.VITE_GOOGLE_SIGNIN !== 'off');

/**
 * Opens Google's account picker and returns a Firebase ID token for the backend,
 * or null if the person closed the popup. Firebase keeps nothing in the browser:
 * our own session is what keeps the user logged in.
 */
export async function googleIdToken(): Promise<string | null> {
  // Loaded only when someone taps the button, so the apps stay small.
  const [{ initializeApp, getApps }, auth] = await Promise.all([import('@firebase/app'), import('@firebase/auth')]);
  const app = getApps()[0] ?? initializeApp(firebaseWebConfig);
  const a = auth.getAuth(app);
  await auth.setPersistence(a, auth.inMemoryPersistence);
  const provider = new auth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    const cred = await auth.signInWithPopup(a, provider);
    const token = await cred.user.getIdToken();
    await auth.signOut(a);
    return token;
  } catch (e) {
    const code = (e as { code?: string }).code ?? '';
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return null;
    if (code === 'auth/popup-blocked') throw new Error('Your browser blocked the Google window. Allow pop-ups for this site and try again.');
    if (code === 'auth/unauthorized-domain') throw new Error('Google sign-in is not allowed on this web address yet. Add it under Firebase → Authentication → Settings → Authorized domains.');
    if (code === 'auth/network-request-failed') throw new Error('No internet connection. Check your connection and try again.');
    throw new Error('Google sign-in failed. Please try again.');
  }
}
