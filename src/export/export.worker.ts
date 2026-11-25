/// <reference lib="webworker" />
import { makeExport } from './heightmap';
import type { EncodeRequest, EncodeResponse } from './exportProtocol';
import { encodingStage } from './exportClient';
import { checkPBRExportBudget, isPBRExportFormat } from './budget';

const worker = self as unknown as DedicatedWorkerGlobalScope;
const send = (message: EncodeResponse, transfer: Transferable[] = []) => worker.postMessage(message, transfer);

worker.addEventListener('message', (event: MessageEvent<EncodeRequest>) => {
  const request = event.data;
  if (request.type !== 'encode') return;
  try {
    const stage = encodingStage(request.format, request.bundle);
    send({ type: 'progress', id: request.id, stage });
    if (isPBRExportFormat(request.format)) {
      checkPBRExportBudget(
        request.field.resolution, request.memoryBudgetMiB ?? 512, request.format, request.bundle,
      );
    }
    const output = makeExport(request.field, request.project, request.format, request.bundle, request.outputNodeId);
    // fflate returns a full owned ArrayBuffer. Copy only when an encoder
    // returns a slice, which cannot safely transfer its shared backing buffer.
    const bytes = output.bytes;
    const transferable = bytes.buffer instanceof ArrayBuffer &&
      bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer : bytes.slice().buffer;
    send(
      { type: 'result', id: request.id, filename: output.filename,
        mime: output.mime, bytes: transferable },
      [transferable],
    );
  } catch (error) {
    send({ type: 'error', id: request.id,
      message: error instanceof Error ? error.message : 'Failed to encode material maps.' });
  }
});
