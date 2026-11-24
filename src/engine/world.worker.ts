/// <reference lib="webworker" />
import { prepareWorldEvaluation } from './world';
import type { WorldWorkerRequest, WorldWorkerResponse } from '../hooks/worldProtocol';
import { createWorldRegionStore, WORLD_REGION_CACHE_VERSION } from './worldStore';
import type { WorldRegionStore } from './worldStore';
import { canonical, semanticProjectSignature } from './plan/graph';

const scope = self as unknown as DedicatedWorkerGlobalScope;
let prepared: Awaited<ReturnType<typeof prepareWorldEvaluation>> | undefined;
let signature = '';
let epoch = 0;
let store: WorldRegionStore | undefined;

scope.onmessage = async (event: MessageEvent<WorldWorkerRequest>) => {
  const request = event.data;
  if (request.type !== 'preview') return;
  const current = ++epoch;
  const send = (message: WorldWorkerResponse, transfer: Transferable[] = []) => {
    if (current === epoch) scope.postMessage(message, transfer);
  };
  try {
    const cacheKey = canonical({ version: WORLD_REGION_CACHE_VERSION, graph: semanticProjectSignature(request.project), world: request.world, grid: request.grid });
    const cacheable = request.cache && request.world.backend === 'cpu-reference';
    if (cacheable) {
      store ??= await createWorldRegionStore();
      const cached = await store.get(cacheKey);
      if (cached) {
        const transfer = [...new Set([cached.heights, cached.flow, cached.wear, cached.deposition].map(a => a.buffer as ArrayBuffer))];
        send({ type: 'result', id: request.id, result: cached, cacheHit: true, store: store.stats() }, transfer);
        return;
      }
    }
    const next = JSON.stringify({ project: request.project, world: request.world });
    if (next !== signature || !prepared) {
      prepared?.dispose();
      prepared = undefined;
      prepared = await prepareWorldEvaluation(request.project, request.world, {
        onProgress: (progress, stage) => send({ type: 'progress', id: request.id, progress: progress * 0.55, stage }),
      });
      if (current !== epoch) return;
      signature = next;
    }
    send({ type: 'progress', id: request.id, progress: 0.6, stage: 'Sampling world coordinates' });
    const result = await prepared.sampleRegion(request.grid);
    if (cacheable && store && result.backend === 'cpu-reference') await store.put(cacheKey, result);
    const transfer = [...new Set([result.heights, result.flow, result.wear, result.deposition].map(a => a.buffer as ArrayBuffer))];
    send({ type: 'result', id: request.id, result, cacheHit: false, store: store?.stats(), compute: prepared.computeCapability, warnings: prepared.capability.warnings }, transfer);
  } catch (error) {
    signature = '';
    prepared?.dispose();
    prepared = undefined;
    send({ type: 'error', id: request.id, message: error instanceof Error ? error.message : 'World generation failed.' });
  }
};
