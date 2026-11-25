import { useEffect, useRef, useState } from 'react';
import type {
  NoisePreview,
  NoisePreviewRequest,
  NoisePreviewResponse,
} from './noisePreviewProtocol';
import { noisePreviewKey } from './noisePreviewProtocol';

// Small immutable preview buffers only. Full terrain grids stay in the engine.
const cache = new Map<string, NoisePreview>();
const CACHE_LIMIT = 96;

export function useNoisePreviews(requests: NoisePreviewRequest[]) {
  const [previews, setPreviews] = useState<Record<string, NoisePreview>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const current = useRef(requests);
  current.current = requests;
  const signature = JSON.stringify(
    requests.map((request) => [request.id, noisePreviewKey(request)]),
  );

  useEffect(() => {
    let disposed = false;
    let worker: Worker | null = null;
    const batch = current.current;
    const available: Record<string, NoisePreview> = {};
    const pending: NoisePreviewRequest[] = [];
    const keys = new Map<string, string>();
    for (const request of batch) {
      const key = noisePreviewKey(request);
      keys.set(request.id, key);
      const entry = cache.get(key);
      if (entry) {
        available[request.id] = entry;
        cache.delete(key);
        cache.set(key, entry);
      } else pending.push(request);
    }
    // Keep the previous field visible with an Updating badge while a new
    // parameter snapshot renders. Other cards never inherit its buffer.
    setPreviews((before) => ({
      ...Object.fromEntries(
        pending
          .filter((request) => before[request.id])
          .map((request) => [request.id, before[request.id]]),
      ),
      ...available,
    }));
    setErrors({});
    setBusy(pending.length > 0);
    setPendingIds(pending.map((request) => request.id));
    if (!pending.length) return;

    // Replacing/closing a batch terminates its worker, including a long sample.
    // The delay keeps slider drags from spawning a worker for every pointer event.
    const timer = setTimeout(() => {
      try {
        worker = new Worker(new URL('../workers/noisePreview.worker.ts', import.meta.url), {
          type: 'module',
        });
        worker.onmessage = (event: MessageEvent<NoisePreviewResponse>) => {
          if (disposed) return;
          const message = event.data;
          if (message.type === 'preview') {
            const key = keys.get(message.id);
            if (!key) return;
            cache.set(key, message.preview);
            while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
            setPreviews((before) => ({ ...before, [message.id]: message.preview }));
            setPendingIds((before) => before.filter((id) => id !== message.id));
          } else if (message.type === 'error') {
            setErrors((before) => ({ ...before, [message.id]: message.message }));
            setPendingIds((before) => before.filter((id) => id !== message.id));
          } else {
            setBusy(false);
            setPendingIds([]);
            worker?.terminate();
            worker = null;
          }
        };
        worker.onerror = (event) => {
          if (disposed) return;
          setErrors(
            Object.fromEntries(
              pending.map((request) => [
                request.id,
                event.message || 'Noise preview could not be generated.',
              ]),
            ),
          );
          setBusy(false);
          setPendingIds([]);
          worker?.terminate();
          worker = null;
        };
        worker.postMessage({ type: 'batch', requests: pending });
      } catch (error) {
        if (disposed) return;
        const message = error instanceof Error ? error.message : 'Noise preview is unavailable.';
        setErrors(Object.fromEntries(pending.map((request) => [request.id, message])));
        setBusy(false);
        setPendingIds([]);
        worker?.terminate();
        worker = null;
      }
    }, 140);
    return () => {
      disposed = true;
      clearTimeout(timer);
      worker?.terminate();
    };
  }, [signature]);

  return { previews, errors, busy, pendingIds };
}
