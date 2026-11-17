import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

export interface AsyncState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
  setData: (d: T) => void;
}

/** Load data on mount / when deps change; exposes loading, error and reload. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fnRef
      .current()
      .then((d) => alive && setData(d))
      .catch((e: unknown) => alive && setError(errorMessage(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}

/** Wrap an action: tracks busy state and the last error message. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (...args: A): Promise<R | undefined> => {
      setBusy(true);
      setError(null);
      try {
        return await fn(...args);
      } catch (e) {
        setError(errorMessage(e));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [fn],
  );
  return { run, busy, error, setError };
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'BAD_REQUEST' && Array.isArray(e.details) && e.details.length) {
      const first = e.details[0] as { path?: string; message?: string };
      return first.path ? `${first.path}: ${first.message}` : (first.message ?? e.message);
    }
    return e.message;
  }
  if (e instanceof Error) return e.message;
  return 'Something went wrong';
}
