/// <reference lib="webworker" />
import { streamWorldExport, worldExportFilename } from './worldExport';
import type { WorldExportRequest, WorldExportResponse } from './worldExport';

const worker = self as unknown as DedicatedWorkerGlobalScope;
let active = false;
const acknowledgments = new Map<string, () => void>();
worker.addEventListener('message', async (event: MessageEvent<WorldExportRequest>) => {
  const request = event.data;
  if (request.type === 'ack') {
    const key = `${request.id}:${request.sequence}`;
    acknowledgments.get(key)?.();
    acknowledgments.delete(key);
    return;
  }
  if (request.type !== 'export' || active) return;
  active = true;
  const send = (response: WorldExportResponse, transfers: Transferable[] = []) =>
    worker.postMessage(response, transfers);
  try {
    let sequence = 0,
      lastProgress = -Infinity;
    const manifest = await streamWorldExport(
      request.options,
      async (bytes) => {
        const index = sequence++;
        const acknowledged = new Promise<void>((resolve) =>
          acknowledgments.set(`${request.id}:${index}`, resolve),
        );
        // A fresh exact-sized buffer leaves encoder-owned chunks intact.
        const transfer = bytes.slice().buffer;
        send({ type: 'chunk', id: request.id, sequence: index, bytes: transfer }, [transfer]);
        await acknowledged;
      },
      (progress, stage) => {
        const now = performance.now();
        if (now - lastProgress >= 50 || progress === 1) {
          send({ type: 'progress', id: request.id, progress, stage });
          lastProgress = now;
        }
      },
    );
    send({
      type: 'complete',
      id: request.id,
      filename: worldExportFilename(request.options),
      manifest,
    });
  } catch (error) {
    send({
      type: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : 'World export failed.',
    });
  } finally {
    active = false;
    acknowledgments.clear();
  }
});
