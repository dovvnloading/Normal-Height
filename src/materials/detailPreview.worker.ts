/// <reference lib="webworker" />
import { generateDetailPreview, type DetailPreviewRequest, type DetailPreviewResponse } from './detailPreview';

const worker = self as unknown as DedicatedWorkerGlobalScope;
worker.addEventListener('message', (event: MessageEvent<DetailPreviewRequest>) => {
  try {
    const maps = generateDetailPreview(event.data);
    const message: DetailPreviewResponse = { type: 'result', maps };
    worker.postMessage(message, [maps.color.buffer, maps.shape.buffer] as Transferable[]);
  } catch (error) {
    const message: DetailPreviewResponse = { type: 'error',
      message: error instanceof Error ? error.message : 'Could not synthesize local material textures.' };
    worker.postMessage(message);
  }
});
