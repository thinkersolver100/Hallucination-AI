import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';

interface State<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
}

interface Options<T> {
  /** Re-fetch every pollMs while keepPolling(data) is true. */
  pollMs?: number;
  keepPolling?: (data: T) => boolean;
}

const GIVE_UP = new Set([401, 403, 404]);

/** Loads data, optionally polling. Stale data stays visible while a reload is in flight. */
export function useLoad<T>(fetcher: () => Promise<T>, deps: readonly unknown[], options: Options<T> = {}) {
  const [state, setState] = useState<State<T>>({ data: undefined, error: undefined, loading: true });
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = async (): Promise<void> => {
      const { pollMs, keepPolling } = optionsRef.current;
      try {
        const data = await fetcherRef.current();
        if (cancelled) return;
        setState({ data, error: undefined, loading: false });
        if (pollMs && (keepPolling?.(data) ?? true)) timer = setTimeout(() => void run(), pollMs);
      } catch (err) {
        if (cancelled) return;
        const error = err instanceof Error ? err : new Error(String(err));
        setState((prev) => ({ data: prev.data, error, loading: false }));
        const final = error instanceof ApiError && GIVE_UP.has(error.status);
        if (pollMs && !final) timer = setTimeout(() => void run(), pollMs * 2);
      }
    };

    setState((prev) => ({ data: prev.data, error: undefined, loading: true }));
    void run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [...deps, tick]);

  return { ...state, reload: () => setTick((t) => t + 1) };
}
