/// <reference lib="webworker" />
import type { GenerateRequest, WorkerResponse } from '../model/types';
import { evaluateGraph } from './index';

const worker = self as unknown as DedicatedWorkerGlobalScope;
worker.addEventListener('message', (event: MessageEvent<GenerateRequest>) => {
  const request = event.data;
  if (request.type !== 'generate') return;
  const send = (response: WorkerResponse, transfers: Transferable[] = []) =>
    worker.postMessage(response, transfers);
  try {
    let lastProgress = 0;
    const result = evaluateGraph(request.project, {
      resolution: request.resolution,
      previewNodeId: request.previewNodeId,
      onProgress: (progress, stage) => {
        const now = performance.now();
        if (now - lastProgress > 60 || progress === 1) {
          send({ type: 'progress', id: request.id, progress, stage });
          lastProgress = now;
        }
      },
    });
    const buffers = new Set<ArrayBuffer>();
    for (const array of [
      result.field.height,
      result.field.flow,
      result.field.wear,
      result.field.deposition,
      ...Object.values(result.thumbnails),
    ])
      buffers.add(array.buffer as ArrayBuffer);
    send({ type: 'result', id: request.id, result }, [...buffers]);
  } catch (error) {
    send({
      type: 'error',
      id: request.id,
      message:
        error instanceof Error
          ? error.message
          : 'Terrain generation failed. Try a lower resolution.',
    });
  }
});
