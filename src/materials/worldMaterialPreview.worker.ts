/// <reference lib="webworker" />
import { bakeWorldMaterialPreview } from './worldMaterialPreview';
import type {
  WorldMaterialPreviewRequest,
  WorldMaterialPreviewResponse,
  WorldMaterialPreviewSource,
} from './worldMaterialPreview';

const scope = self as unknown as DedicatedWorkerGlobalScope;
let current: { id: number; source: WorldMaterialPreviewSource } | undefined;
scope.onmessage = (event: MessageEvent<WorldMaterialPreviewRequest>) => {
  const request = event.data;
  if (request.type !== 'bake') return;
  const send = (message: WorldMaterialPreviewResponse, transfer: Transferable[] = []) =>
    scope.postMessage(message, transfer);
  try {
    if (request.source) current = { id: request.fieldId, source: request.source };
    if (!current || current.id !== request.fieldId)
      throw new Error('The material worker needs the matching terrain source.');
    const maps = bakeWorldMaterialPreview(current.source, request.project, request.ranges);
    send({ type: 'result', id: request.id, fieldId: request.fieldId, maps }, [
      maps.basecolor.buffer,
      maps.orm.buffer,
      maps.detailNormal.buffer,
    ] as ArrayBuffer[]);
  } catch (error) {
    send({
      type: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : 'World material preview failed.',
    });
  }
};
