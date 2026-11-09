/// <reference lib="webworker" />
import type { HeightField, TerrainProject } from '../model/types';
import { makeExport } from './heightmap';
import type { ExportFormat } from './heightmap';
import { checkPBRExportBudget } from './budget';

type EncodeRequest = {
  type: 'encode';
  id: number;
  field: HeightField;
  project: TerrainProject;
  format: ExportFormat;
  bundle: boolean;
  memoryBudgetMiB?: number;
};
const worker = self as unknown as DedicatedWorkerGlobalScope;

worker.addEventListener('message', (event: MessageEvent<EncodeRequest>) => {
  const request = event.data;
  if (request.type !== 'encode') return;
  try {
    worker.postMessage({ type: 'progress', id: request.id, stage: 'Synthesizing and packing maps' });
    if (request.format === 'pbr') {
      checkPBRExportBudget(request.field.resolution, request.memoryBudgetMiB ?? 512);
    }
    const output = makeExport(request.field, request.project, request.format, request.bundle);
    // fflate returns a full owned ArrayBuffer. Copy only when an encoder
    // returns a slice, which cannot safely transfer its shared backing buffer.
    const bytes = output.bytes;
    const transferable = bytes.buffer instanceof ArrayBuffer &&
      bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer : bytes.slice().buffer;
    worker.postMessage(
      { type: 'result', id: request.id, filename: output.filename,
        mime: output.mime, bytes: transferable },
      [transferable],
    );
  } catch (error) {
    worker.postMessage({ type: 'error', id: request.id,
      message: error instanceof Error ? error.message : 'Failed to encode material maps.' });
  }
});
