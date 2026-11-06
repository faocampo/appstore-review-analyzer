"use client";

import { useEffect, useEffectEvent, useState } from "react";

export interface Resource<T> {
  /** Latest successful data; kept while a new key loads so the view doesn't flash. */
  data: T | null;
  /** Error for the current key, if its load failed. */
  error: unknown;
  /** True while the current key has not resolved yet. */
  loading: boolean;
  /** True when `data` belongs to an earlier key. */
  stale: boolean;
}

type Settled<T> = { key: string; ok: true; data: T } | { key: string; ok: false; error: unknown };

/**
 * Loads data for a key. State is only set from the promise callbacks, never
 * synchronously in the effect body; `loading` is derived from the key.
 */
export function useResource<T>(key: string | null, load: () => Promise<T>): Resource<T> {
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const [lastData, setLastData] = useState<{ key: string; data: T } | null>(null);
  const run = useEffectEvent(load);

  useEffect(() => {
    if (key === null) return;
    let active = true;
    run().then(
      (data) => {
        if (!active) return;
        setSettled({ key, ok: true, data });
        setLastData({ key, data });
      },
      (error: unknown) => {
        if (active) setSettled({ key, ok: false, error });
      },
    );
    return () => {
      active = false;
    };
  }, [key]);

  const current = settled?.key === key ? settled : null;
  return {
    data: lastData?.data ?? null,
    error: current && !current.ok ? current.error : null,
    loading: key !== null && current === null,
    stale: lastData !== null && lastData.key !== key,
  };
}
