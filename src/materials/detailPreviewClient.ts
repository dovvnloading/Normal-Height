import type { DetailPreviewMaps, DetailPreviewRequest, DetailPreviewResponse } from './detailPreview';

export function detailPreviewKey(request: DetailPreviewRequest): string {
  return request.biome + ':' + (request.seed >>> 0);
}

export interface DetailPreviewLease {
  promise: Promise<DetailPreviewMaps>;
  release(): void;
}

interface Job {
  users: number;
  worker: Worker | null;
  finished: boolean;
  promise: Promise<DetailPreviewMaps>;
  reject: (error: Error) => void;
}

/**
 * Share CPU buffers between split-view consumers, never share WebGL objects
 * between contexts. Two completed variants are retained; stale pending
 * work is cancelled when the final consumer releases its lease.
 */
export class DetailPreviewCache {
  private jobs = new Map<string, Job>();

  constructor(private readonly createWorker = () =>
    new Worker(new URL('./detailPreview.worker.ts', import.meta.url), { type: 'module' })) {}

  private prune() {
    for (const [key, job] of this.jobs) {
      if (this.jobs.size <= 2) break;
      if (job.finished && job.users === 0) this.jobs.delete(key);
    }
  }

  request(request: DetailPreviewRequest): DetailPreviewLease {
    const key = detailPreviewKey(request);
    let job = this.jobs.get(key);
    if (!job) {
      let accept!: (maps: DetailPreviewMaps) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<DetailPreviewMaps>((resolve, fail) => { accept = resolve; reject = fail; });
      const running: Job = { users: 0, worker: null, finished: false, promise, reject };
      job = running;
      this.jobs.set(key, job);
      const finish = () => {
        running.finished = true;
        running.worker?.terminate();
        running.worker = null;
      };
      const fail = (message: string) => {
        if (running.finished) return;
        finish();
        this.jobs.delete(key);
        reject(new Error(message));
      };
      try {
        const worker = this.createWorker();
        running.worker = worker;
        worker.onmessage = (event: MessageEvent<DetailPreviewResponse>) => {
          if (running.finished) return;
          if (event.data.type === 'error') { fail(event.data.message); return; }
          finish();
          accept(event.data.maps);
          this.prune();
        };
        worker.onerror = event => fail(event.message || 'Local material worker failed.');
        worker.onmessageerror = () => fail('Could not read local material texture data.');
        worker.postMessage(request);
      } catch (error) {
        fail(error instanceof Error ? error.message : 'Could not start local material worker.');
      }
    } else {
      // Move to the end of insertion order for LRU eviction.
      this.jobs.delete(key);
      this.jobs.set(key, job);
    }
    const active = job;
    active.users++;
    this.prune();
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
          this.jobs.delete(key);
          active.reject(new Error('Local material request superseded.'));
        }
        this.prune();
      },
    };
  }
}

const cache = new DetailPreviewCache();
export const requestDetailPreview = (request: DetailPreviewRequest) => cache.request(request);
