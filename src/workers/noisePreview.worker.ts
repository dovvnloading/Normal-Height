/// <reference lib="webworker" />
import { generateStudioNoise } from '../engine/noiseStudio';
import type { NoisePreviewRequest, NoisePreviewResponse } from '../hooks/noisePreviewProtocol';

const worker = self as unknown as DedicatedWorkerGlobalScope;
worker.addEventListener(
  'message',
  (event: MessageEvent<{ type: 'batch'; requests: NoisePreviewRequest[] }>) => {
    if (event.data.type !== 'batch' || !Array.isArray(event.data.requests)) return;
    const send = (response: NoisePreviewResponse, transfers: Transferable[] = []) =>
      worker.postMessage(response, transfers);
    for (const request of event.data.requests.slice(0, 64)) {
      try {
        const resolution = Math.max(32, Math.min(192, Math.round(request.resolution)));
        const started = performance.now();
        const height = generateStudioNoise(
          request.params,
          request.projectSeed,
          resolution,
          request.worldSize,
        );
        let minimum = Infinity,
          maximum = -Infinity,
          sum = 0,
          outsideDisplayRange = 0;
        const histogram = new Array<number>(32).fill(0);
        for (const value of height) {
          if (!Number.isFinite(value)) throw new Error('The noise produced a non-finite sample.');
          minimum = Math.min(minimum, value);
          maximum = Math.max(maximum, value);
          sum += value;
          if (value < 0 || value > 1) outsideDisplayRange++;
          histogram[Math.min(31, Math.max(0, Math.floor(value * 32)))]++;
        }
        send(
          {
            type: 'preview',
            id: request.id,
            preview: {
              height,
              resolution,
              minimum,
              maximum,
              mean: sum / height.length,
              duration: performance.now() - started,
              histogram,
              outsideDisplayRange,
            },
          },
          [height.buffer as ArrayBuffer],
        );
      } catch (error) {
        send({
          type: 'error',
          id: request.id,
          message: error instanceof Error ? error.message : 'Noise preview failed.',
        });
      }
    }
    send({ type: 'complete' });
  },
);
