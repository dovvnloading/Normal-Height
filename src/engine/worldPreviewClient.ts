import type {
  WorldPreviewProgress,
  WorldPreviewResult,
  WorldWorkerRequest,
  WorldWorkerResponse,
} from '../hooks/worldProtocol';
import { worldEvaluationSignature, worldPreviewRequestKey } from './worldPreviewPlan';
import { regionArrays } from './worldStore/codec';

export interface WorldPreviewWorkerPort {
  onmessage: ((event: MessageEvent<WorldWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: WorldWorkerRequest): void;
  terminate(): void;
}

export interface WorldPreviewCallbacks {
  start?(id: number): void;
  progress(progress: WorldPreviewProgress): void;
  result(result: WorldPreviewResult): void;
  error(message: string): void;
}
export type WorldPreviewInput = Omit<WorldWorkerRequest, 'type' | 'id'>;
interface CachedRegion {
  response: WorldPreviewResult;
  bytes: number;
  persistentRequested: boolean;
}

/** Keeps an idle worker (and its prepared global solution), deduplicates requests,
 * and holds a bounded LRU of completed regions for instant spatial backtracking.
 * Both worker identity and job identity guard every callback, including failures. */
export class WorldPreviewClient {
  private worker: WorldPreviewWorkerPort | null = null;
  private epoch = 0;
  private active = false;
  private requestKey = '';
  private cachedBytes = 0;
  private readonly regions = new Map<string, CachedRegion>();

  constructor(
    private readonly createWorker: () => WorldPreviewWorkerPort,
    private readonly memoryBudgetBytes = 24 * 1024 * 1024,
    private readonly maxEntries = 8,
  ) {}

  preview(input: WorldPreviewInput, callbacks: WorldPreviewCallbacks): number {
    let key: string;
    try {
      key = worldPreviewRequestKey(
        worldEvaluationSignature(input.project, input.world, input.previewNodeId),
        input.grid,
      );
    } catch (error) {
      this.resetWorker();
      callbacks.error(
        error instanceof Error ? error.message : 'These World settings cannot be read.',
      );
      return this.epoch;
    }
    if (this.active && this.requestKey === key) return this.epoch;
    if (this.active) this.resetWorker();
    const id = ++this.epoch;
    this.requestKey = key;
    callbacks.start?.(id);
    const cached = this.regions.get(key);
    if (cached && (!input.cache || cached.persistentRequested)) {
      this.regions.delete(key);
      this.regions.set(key, cached);
      const labels = new Map(input.project.graph.nodes.map((node) => [node.id, node.label]));
      callbacks.result({
        ...cached.response,
        id,
        cacheHit: true,
        cacheSource: 'memory',
        elapsedMs: 0,
        result: {
          ...cached.response.result,
          stages: cached.response.result.stages.map((stage) => ({
            ...stage,
            label: labels.get(stage.nodeId) ?? stage.label,
          })),
        },
      });
      return id;
    }
    try {
      // Snapshot before creating a worker so clone failures do not leak a port.
      const snapshot = structuredClone(input);
      const worker = this.worker ?? this.createWorker();
      this.worker = worker;
      this.active = true;
      const current = () => this.active && id === this.epoch && this.worker === worker;
      const fail = (message: string) => {
        if (!current()) return;
        this.resetWorker();
        callbacks.error(message);
      };
      worker.onmessage = ({ data }) => {
        if (!current() || data.id !== id) return;
        if (data.type === 'progress') {
          const detail = data.detail ?? {
            phase: 'sampling' as const,
            progress: data.progress,
            stage: data.stage,
          };
          callbacks.progress({
            ...detail,
            progress:
              detail.progress !== null && Number.isFinite(detail.progress)
                ? Math.max(0, Math.min(1, detail.progress))
                : null,
          });
        } else if (data.type === 'error') fail(data.message);
        else {
          this.active = false;
          this.remember(key, data, !!snapshot.cache);
          callbacks.result(data);
        }
      };
      worker.onerror = (event) => {
        if (this.worker !== worker) return;
        if (!this.active) this.resetWorker();
        else if (this.epoch === id)
          fail(event.message || 'The World worker stopped unexpectedly. Retry the preview.');
      };
      worker.onmessageerror = () =>
        fail('The World worker returned an unreadable result. Retry the preview.');
      worker.postMessage({ type: 'preview', id, ...snapshot });
    } catch (error) {
      this.resetWorker();
      callbacks.error(
        error instanceof Error ? error.message : 'Could not start the World preview.',
      );
    }
    return id;
  }

  cancel(): void {
    if (this.active) this.resetWorker();
  }

  /** Invalidates the in-process regions and prepared context. Persistent cache
   * storage is managed separately so clearing one has no hidden storage effect. */
  clearCache(): void {
    this.resetWorker();
    this.regions.clear();
    this.cachedBytes = 0;
  }

  dispose(): void {
    this.clearCache();
  }

  private resetWorker(): void {
    ++this.epoch;
    this.active = false;
    this.requestKey = '';
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    }
  }

  private remember(key: string, response: WorldPreviewResult, persistentRequested: boolean): void {
    const bytes = [...new Set(regionArrays(response.result).map((array) => array.buffer))].reduce(
      (total, buffer) => total + buffer.byteLength,
      0,
    );
    if (!Number.isFinite(bytes) || bytes > this.memoryBudgetBytes || this.maxEntries < 1) return;
    const previous = this.regions.get(key);
    if (previous) this.cachedBytes -= previous.bytes;
    this.regions.delete(key);
    this.regions.set(key, { response, bytes, persistentRequested });
    this.cachedBytes += bytes;
    while (this.cachedBytes > this.memoryBudgetBytes || this.regions.size > this.maxEntries) {
      const oldest = this.regions.entries().next().value;
      if (!oldest) break;
      this.regions.delete(oldest[0]);
      this.cachedBytes -= oldest[1].bytes;
    }
  }
}
