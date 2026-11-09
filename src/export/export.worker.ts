/// <reference lib="webworker" />
import type { HeightField, TerrainProject } from '../model/types';
import { makeExport } from './heightmap';
import type { ExportFormat } from './heightmap';

type EncodeRequest = {
  type: 'encode';
  id: number;
  field: HeightField;
  project: TerrainProject;
  format: ExportFormat;
  bundle: boolean;
};
const worker = self as unknown as DedicatedWorkerGlobalScope;

worker.addEventListener('message', (event: MessageEvent<EncodeRequest>) => {
  const request = event.data;
  if (request.type !== 'encode') return;
  try {
    worker.postMessage({ type: 'progress', id: request.id, stage: 'Synthesizing and packing maps' });
    const output = makeExport(request.field, request.project, request.format, request.bundle);
    const bytes = output.bytes.slice();
    worker.postMessage(
      { type: 'result', id: request.id, filename: output.filename,
        mime: output.mime, bytes: bytes.buffer },
      [bytes.buffer],
    );
  } catch (error) {
    worker.postMessage({ type: 'error', id: request.id,
      message: error instanceof Error ? error.message : 'Failed to encode material maps.' });
  }
});
