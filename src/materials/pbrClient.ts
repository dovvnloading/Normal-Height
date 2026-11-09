import type { HeightField, TerrainProject } from '../model/types';
import { resolveSurface } from './pbr';
import type { PBRMaps } from './pbr';

interface Job {
  worker: Worker | null;
  promise: Promise<PBRMaps>;
  reject: (error: Error) => void;
  users: number;
  finished: boolean;
}

// Field identity is the terrain revision. Surface edits do not invalidate the
// erosion field; a physical/material signature distinguishes its PBR variants.
const cache = new WeakMap<HeightField, Map<string, Job>>();

export function requestPBR(field: HeightField, project: TerrainProject): {
  promise: Promise<PBRMaps>;
  release: () => void;
} {
  let variants = cache.get(field);
  if (!variants) {
    variants = new Map();
    cache.set(field, variants);
  }
  const key = JSON.stringify([
    project.seed, project.worldSize, project.heightScale, resolveSurface(project.surface),
  ]);
  let job = variants.get(key);
  if (!job) {
    let accept!: (maps: PBRMaps) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<PBRMaps>((resolve, fail) => {
      accept = resolve;
      reject = fail;
    });
    // The main thread never executes generatePBR. Only field buffers are
    // structured-cloned because terrain/3D callers still own their originals.
    const worker = new Worker(new URL('./pbr.worker.ts', import.meta.url), { type: 'module' });
    job = { worker, promise, reject, users: 0, finished: false };
    const running = job;
    const entries = variants;
    const fail = (message: string) => {
      if (running.finished) return;
      running.finished = true;
      running.worker?.terminate();
      running.worker = null;
      entries.delete(key);
      reject(new Error(message));
    };
    worker.onmessage = (event: MessageEvent<
      { type: 'result'; maps: PBRMaps } | { type: 'error'; message: string }
    >) => {
      if (running.finished) return;
      const message = event.data;
      if (message.type === 'error') {
        fail(message.message);
        return;
      }
      running.finished = true;
      running.worker?.terminate();
      running.worker = null;
      accept(message.maps);
    };
    worker.onerror = (event) => fail(event.message || 'PBR material worker failed.');
    variants.set(key, running);
    try {
      worker.postMessage({ field, project });
    } catch (error) {
      fail(error instanceof Error ? error.message : 'Could not send terrain to material worker.');
    }
    // Do not retain an unbounded material history when an artist drags controls.
    if (variants.size > 2) {
      for (const [oldKey, oldJob] of variants) {
        if (oldKey !== key && oldJob.finished && oldJob.users === 0) {
          variants.delete(oldKey);
          break;
        }
      }
    }
  }
  const active = job;
  active.users++;
  let released = false;
  return {
    promise: active.promise,
    release: () => {
      if (released) return;
      released = true;
      active.users--;
      if (!active.finished && active.users === 0) {
        active.finished = true;
        active.worker?.terminate();
        active.worker = null;
        variants!.delete(key);
        active.reject(new Error('PBR request superseded.'));
      }
    },
  };
}
