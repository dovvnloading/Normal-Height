/// <reference lib="webworker" />
import { noiseExportFilename, streamNoiseExport } from '../export/noiseExport';
import type { NoiseExportOptions } from '../export/noiseExport';

declare const self: DedicatedWorkerGlobalScope;
self.onmessage = (event: MessageEvent<{ id: number; options: NoiseExportOptions }>) => {
  const { id, options } = event.data;
  let lastProgress = 0;
  try {
    streamNoiseExport(
      options,
      (data) => {
        // fflate may expose a view of a larger backing buffer. Transfer precisely
        // the output bytes, and never detach a buffer still owned by compression.
        const bytes = data.slice().buffer;
        self.postMessage({ type: 'chunk', id, bytes }, [bytes]);
      },
      (progress, stage) => {
        const now = performance.now();
        if (now - lastProgress > 80 || progress === 0 || progress === 1) {
          lastProgress = now;
          self.postMessage({ type: 'progress', id, progress, stage });
        }
      },
    );
    self.postMessage({ type: 'done', id, filename: noiseExportFilename(options) });
  } catch (error) {
    self.postMessage({
      type: 'error',
      id,
      message: error instanceof Error ? error.message : 'Could not export this noise source.',
    });
  }
};
