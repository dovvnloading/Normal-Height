import { describeWorldGraph, prepareWorldEvaluation } from './world';
import type { PreparedWorldEvaluation, WorldRegionResult } from './world';
import type {
  WorldPreviewProgress,
  WorldWorkerRequest,
  WorldWorkerResponse,
} from '../hooks/worldProtocol';
import { createWorldRegionStore, WORLD_REGION_CACHE_VERSION } from './worldStore';
import type { WorldRegionStore } from './worldStore';
import { canonical } from './plan/graph';
import { worldEvaluationSignature } from './worldPreviewPlan';

type Send = (message: WorldWorkerResponse, transfer?: Transferable[]) => void;
interface Dependencies {
  prepare: typeof prepareWorldEvaluation;
  describe: typeof describeWorldGraph;
  createStore: typeof createWorldRegionStore;
  now: () => number;
}

/** One worker owns one prepared world. Completed requests retain global context;
 * a superseded request owns no path to a newer context or to a published field. */
export class WorldPreviewSession {
  private prepared?: PreparedWorldEvaluation;
  private signature = '';
  private epoch = 0;
  private controller?: AbortController;
  private store?: WorldRegionStore;
  private readonly dependencies: Dependencies;

  constructor(dependencies: Partial<Dependencies> = {}) {
    this.dependencies = {
      prepare: prepareWorldEvaluation,
      describe: describeWorldGraph,
      createStore: createWorldRegionStore,
      now: () => performance.now(),
      ...dependencies,
    };
  }

  async run(request: WorldWorkerRequest, publish: Send): Promise<void> {
    if (request.type !== 'preview') return;
    const current = ++this.epoch;
    // Main-thread cancellation normally terminates this worker. This guard also
    // makes direct or queued overlapping requests safe while an async pass yields.
    if (this.controller) {
      this.controller.abort();
      this.releasePrepared();
    }
    const controller = new AbortController();
    this.controller = controller;
    const startedAt = this.dependencies.now();
    const currentRequest = () => current === this.epoch && !controller.signal.aborted;
    const send: Send = (message, transfer = []) => {
      if (currentRequest()) publish(message, transfer);
    };
    let lastSentAt = -Infinity;
    let lastStage = '';
    let compatibilityProgress = 0;
    const labels = new Map(request.project.graph.nodes.map((node) => [node.id, node.label]));
    const progress = (detail: WorldPreviewProgress) => {
      const stage = detail.nodeId ? (labels.get(detail.nodeId) ?? detail.stage) : detail.stage;
      const key = `${detail.phase}:${detail.nodeId ?? stage}`;
      const now = this.dependencies.now();
      if (key === lastStage && now - lastSentAt < 50 && detail.progress !== 1) return;
      lastStage = key;
      lastSentAt = now;
      // Keep the old scalar protocol usable. New surfaces render detail's named
      // phase and measured work, which intentionally have no invented ETA.
      const scalar =
        detail.phase === 'sampling'
          ? 0.6 + (detail.progress ?? 0) * 0.4
          : detail.phase === 'storing'
            ? 1
            : (detail.progress ?? 0) * 0.55;
      compatibilityProgress = Math.max(compatibilityProgress, scalar);
      send({
        type: 'progress',
        id: request.id,
        progress: compatibilityProgress,
        stage,
        detail: { ...detail, stage },
      });
    };
    const relabel = (result: WorldRegionResult): WorldRegionResult => ({
      ...result,
      stages: result.stages.map((stage) => ({
        ...stage,
        label: labels.get(stage.nodeId) ?? stage.label,
      })),
    });
    const transfer = (result: WorldRegionResult): Transferable[] =>
      [
        ...new Set(
          [result.heights, result.flow, result.wear, result.deposition].map(
            (array) => array.buffer,
          ),
        ),
      ].filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer);

    try {
      const signature = worldEvaluationSignature(
        request.project,
        request.world,
        request.previewNodeId,
      );
      const cacheKey = canonical({
        version: WORLD_REGION_CACHE_VERSION,
        signature,
        grid: request.grid,
      });
      const cacheable = request.cache && request.world.backend === 'cpu-reference';
      if (cacheable) {
        progress({ phase: 'cache', stage: 'Checking local region cache', progress: null });
        if (!this.store) {
          const store = await this.dependencies.createStore();
          if (!currentRequest()) {
            await store.close();
            return;
          }
          this.store = store;
        }
        const cached = await this.store.get(cacheKey);
        if (!currentRequest()) return;
        if (cached) {
          const result = relabel(cached);
          send(
            {
              type: 'result',
              id: request.id,
              result,
              cacheHit: true,
              cacheSource: 'persistent',
              store: this.store.stats(),
              compute: {
                requested: 'cpu-reference',
                available: false,
                qualified: false,
                backend: 'cpu-reference',
                reason: 'Restored a validated CPU reference region from the local cache.',
              },
              warnings: this.dependencies.describe(
                request.project,
                request.world,
                request.previewNodeId,
              ).capability.warnings,
              elapsedMs: this.dependencies.now() - startedAt,
            },
            transfer(result),
          );
          return;
        }
      }
      const preparedReused = signature === this.signature && !!this.prepared;
      if (!preparedReused) {
        this.releasePrepared();
        progress({ phase: 'preparing', stage: 'Preparing world graph', progress: null });
        const prepared = await this.dependencies.prepare(request.project, request.world, {
          signal: controller.signal,
          onProgressDetail: progress,
          previewNodeId: request.previewNodeId,
        });
        if (!currentRequest()) {
          prepared.dispose();
          return;
        }
        this.prepared = prepared;
        this.signature = signature;
      }
      const prepared = this.prepared!;
      progress({ phase: 'sampling', stage: 'Sampling world coordinates', progress: null });
      const sampled = await prepared.sampleRegion(request.grid, {
        signal: controller.signal,
        onProgressDetail: progress,
      });
      if (!currentRequest()) return;
      const result = relabel(sampled);
      if (cacheable && this.store && result.backend === 'cpu-reference') {
        progress({ phase: 'storing', stage: 'Saving reusable region', progress: null });
        await this.store.put(cacheKey, result);
      }
      if (!currentRequest()) return;
      send(
        {
          type: 'result',
          id: request.id,
          result,
          cacheHit: false,
          store: this.store?.stats(),
          compute: prepared.computeCapability,
          warnings: prepared.capability.warnings,
          preparedReused,
          elapsedMs: this.dependencies.now() - startedAt,
        },
        transfer(result),
      );
    } catch (error) {
      if (!currentRequest()) return;
      this.releasePrepared();
      send({
        type: 'error',
        id: request.id,
        message: error instanceof Error ? error.message : 'World generation failed.',
      });
    } finally {
      if (current === this.epoch) this.controller = undefined;
    }
  }

  dispose(): void {
    ++this.epoch;
    this.controller?.abort();
    this.controller = undefined;
    this.releasePrepared();
    void this.store?.close();
    this.store = undefined;
  }

  private releasePrepared(): void {
    this.prepared?.dispose();
    this.prepared = undefined;
    this.signature = '';
  }
}
