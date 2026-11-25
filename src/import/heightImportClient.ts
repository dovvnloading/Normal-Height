import type { HeightRaster } from '../model/heightRaster';
import type { ImportReply, ImportRequest } from './heightmap.worker';

type ImportWorker = Pick<Worker, 'onmessage' | 'onerror' | 'onmessageerror' | 'postMessage' | 'terminate'>;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** One disposable worker per import. Replaced or cancelled tasks can never publish a result. */
export function createHeightImportClient(createWorker: () => ImportWorker) {
  let active: ImportWorker | null = null;

  function cancel() {
    const task = active;
    active = null;
    if (!task) return;
    task.onmessage = null;
    task.onerror = null;
    task.onmessageerror = null;
    task.terminate();
  }

  function start(
    request: ImportRequest,
    onResult: (raster: HeightRaster) => void,
    onError: (message: string) => void,
  ) {
    cancel();
    let task: ImportWorker;
    try {
      task = createWorker();
    } catch (error) {
      onError(errorMessage(error, 'Could not start the heightmap reader.'));
      return;
    }
    active = task;
    const fail = (message: string) => {
      if (active !== task) return;
      cancel();
      onError(message);
    };
    task.onmessage = (event: MessageEvent<ImportReply>) => {
      if (active !== task) return;
      const reply = event.data;
      if ('error' in reply) {
        fail(reply.error);
        return;
      }
      cancel();
      onResult(reply.raster);
    };
    task.onerror = (event) => {
      event.preventDefault();
      fail(event.message || 'The heightmap reader failed. Try again or choose a smaller file.');
    };
    task.onmessageerror = () => fail('The heightmap reader returned an unreadable response.');
    try {
      task.postMessage(request);
    } catch (error) {
      fail(errorMessage(error, 'Could not send the file to the heightmap reader.'));
    }
  }

  return { start, cancel };
}
