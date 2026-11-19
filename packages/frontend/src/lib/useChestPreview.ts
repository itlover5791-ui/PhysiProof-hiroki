import { useEffect, useState } from 'react';
import { chestPreviewSchema, type ChestTier } from '@my-app/shared';
import client from './hc';

export function useChestPreview(sessionId: string | null): ChestTier | null {
  const [estimate, setEstimate] = useState<{ sessionId: string; tier: ChestTier } | null>(null);

  useEffect(() => {
    setEstimate(null);
    if (!sessionId) return;
    let request: AbortController | undefined;
    let expiry: number | undefined;
    let stopped = false;

    function clearEstimate() {
      window.clearTimeout(expiry);
      setEstimate(null);
    }

    async function refresh() {
      if (request || !sessionId || document.hidden || !navigator.onLine) return;
      const controller = new AbortController();
      request = controller;
      const requestedAt = performance.now();
      const timeout = window.setTimeout(() => controller.abort(), 3500);
      try {
        const response = await client.api['map-chests'].sessions[':id'].preview.$get(
          { param: { id: sessionId } },
          { init: { signal: controller.signal, cache: 'no-store' } },
        );
        if (!response.ok) throw new Error('Could not load the chest estimate');
        const { preview } = chestPreviewSchema.parse(await response.json());
        if (stopped || controller.signal.aborted) return;
        if (!preview || document.hidden || !navigator.onLine) {
          clearEstimate();
          return;
        }
        const remaining = preview.valid_for_ms - (performance.now() - requestedAt);
        window.clearTimeout(expiry);
        if (remaining <= 0) {
          clearEstimate();
          return;
        }
        setEstimate(current => current?.sessionId === sessionId && current.tier === preview.tier
          ? current : { sessionId, tier: preview.tier });
        expiry = window.setTimeout(clearEstimate, remaining);
      } catch {
        if (!stopped) clearEstimate();
      } finally {
        window.clearTimeout(timeout);
        request = undefined;
      }
    }

    function sync() {
      if (document.hidden || !navigator.onLine) {
        request?.abort();
        clearEstimate();
      } else {
        void refresh();
      }
    }

    void refresh();
    const interval = window.setInterval(refresh, 4000);
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      stopped = true;
      request?.abort();
      window.clearInterval(interval);
      window.clearTimeout(expiry);
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [sessionId]);

  return estimate?.sessionId === sessionId ? estimate.tier : null;
}
