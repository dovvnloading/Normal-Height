import type { TerrainProject } from '../model/types';
import type { MaterialRanges } from './layerSynthesis';
import { pbrVariantKey } from './pbrClient';
import type {
  WorldMaterialPreview,
  WorldMaterialPreviewRequest,
  WorldMaterialPreviewResponse,
  WorldMaterialPreviewSource,
} from './worldMaterialPreview';

interface PreviewWorker {
  onmessage: ((event: MessageEvent<WorldMaterialPreviewResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: WorldMaterialPreviewRequest): void;
  terminate(): void;
}
export interface WorldMaterialPreviewInput {
  source: WorldMaterialPreviewSource;
  project: TerrainProject;
  ranges: MaterialRanges;
}
export interface WorldMaterialPreviewCallbacks {
  start(): void;
  result(maps: WorldMaterialPreview, cached: boolean): void;
  error(message: string): void;
}

export function worldMaterialPreviewKey(input: WorldMaterialPreviewInput): string {
  return JSON.stringify([pbrVariantKey(input.project), input.source.sampling, input.ranges]);
}

/** One idle worker reuses a bounded terrain field across material-only edits.
 * A superseded synchronous bake is terminated; late responses cannot publish.
 * Original terrain arrays are cloned, never transferred or detached. */
export class WorldMaterialPreviewClient {
  private worker: PreviewWorker | null = null;
  private epoch = 0;
  private fieldId = 0;
  private installed: WorldMaterialPreviewSource | null = null;
  private busy = false;
  private completed?: {
    source: WorldMaterialPreviewSource;
    key: string;
    maps: WorldMaterialPreview;
  };
  constructor(
    private readonly createWorker: () => PreviewWorker = () =>
      new Worker(new URL('./worldMaterialPreview.worker.ts', import.meta.url), { type: 'module' }),
  ) {}

  request(input: WorldMaterialPreviewInput, callbacks: WorldMaterialPreviewCallbacks): void {
    const id = ++this.epoch;
    if (this.busy) this.releaseWorker();
    const key = worldMaterialPreviewKey(input);
    if (this.completed?.source === input.source && this.completed.key === key) {
      callbacks.result(this.completed.maps, true);
      return;
    }
    callbacks.start();
    const fail = (message: string) => {
      if (id !== this.epoch) return;
      this.releaseWorker();
      callbacks.error(message);
    };
    try {
      const worker = this.worker ?? (this.worker = this.createWorker());
      const changed = this.installed !== input.source;
      if (changed) this.fieldId++;
      const fieldId = this.fieldId;
      worker.onmessage = (event) => {
        if (id !== this.epoch || this.worker !== worker || !this.busy) return;
        const message = event.data;
        if (message.id !== id) return;
        if (message.type === 'error') {
          fail(message.message);
          return;
        }
        if (message.fieldId !== fieldId) {
          fail('The material worker returned a different terrain revision.');
          return;
        }
        const { width, height } = input.source.sampling.grid;
        if (
          message.maps.width !== width ||
          message.maps.height !== height ||
          [message.maps.basecolor, message.maps.orm, message.maps.detailNormal].some(
            (values) =>
              !(values instanceof Uint8ClampedArray) || values.length !== width * height * 4,
          )
        ) {
          fail('The material worker returned inconsistent preview dimensions.');
          return;
        }
        this.busy = false;
        this.completed = { source: input.source, key, maps: message.maps };
        callbacks.result(message.maps, false);
      };
      worker.onerror = (event) => fail(event.message || 'World material worker failed.');
      worker.onmessageerror = () => fail('The world material preview could not be decoded.');
      this.busy = true;
      this.installed = input.source;
      worker.postMessage({
        type: 'bake',
        id,
        fieldId,
        source: changed ? input.source : undefined,
        project: { ...input.project, graph: { nodes: [], edges: [] } },
        ranges: input.ranges,
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : 'The world material worker could not start.');
    }
  }

  cancel(): void {
    ++this.epoch;
    this.releaseWorker();
  }
  dispose(): void {
    this.cancel();
    this.completed = undefined;
  }
  private releaseWorker(): void {
    if (this.worker) {
      this.worker.onmessage = this.worker.onerror = this.worker.onmessageerror = null;
      this.worker.terminate();
    }
    this.worker = null;
    this.installed = null;
    this.busy = false;
  }
}
