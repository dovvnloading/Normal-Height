import { describe, expect, it, vi } from 'vitest';
import type { TerrainProject } from '../src/model/types';
import { createWorldDefinition, DEFAULT_WORLD_TRANSPORT } from '../src/model/world';
import type { WorldDefinition } from '../src/model/world';
import {
  createWorldPreviewGrid,
  isWorldOverview,
  worldEvaluationSignature,
} from '../src/engine/worldPreviewPlan';
import { WorldPreviewClient } from '../src/engine/worldPreviewClient';
import type { WorldPreviewCallbacks, WorldPreviewInput } from '../src/engine/worldPreviewClient';
import { WorldPreviewSession } from '../src/engine/worldPreviewSession';
import { generateWorldRegion } from '../src/engine/world';
import type {
  PreparedWorldEvaluation,
  WorldEvaluationProgress,
  WorldRegionResult,
  WorldRunOptions,
  WorldSampleGrid,
} from '../src/engine/world';
import type { WorldWorkerRequest, WorldWorkerResponse } from '../src/hooks/worldProtocol';

const project = (): TerrainProject => ({
  version: 1,
  name: 'World preview',
  seed: 17,
  resolution: 64,
  worldSize: 8000,
  heightScale: 1000,
  presetId: 'custom',
  graph: {
    nodes: [
      {
        id: 'source',
        kind: 'noise',
        label: 'Hills',
        position: { x: 0, y: 0 },
        params: {
          noiseModel: 'v3',
          kernel: 'perlin',
          fractal: 'fbm',
          octaves: 2,
          sampling: 'point',
        },
      },
      { id: 'out', kind: 'output', label: 'Output', position: { x: 100, y: 0 }, params: {} },
    ],
    edges: [{ id: 'e', source: 'source', target: 'out', targetHandle: 'in' }],
  },
});
function input(): WorldPreviewInput {
  const scene = project();
  const world = createWorldDefinition(scene);
  world.globalResolution = 64;
  return { project: scene, world, grid: createWorldPreviewGrid(world) };
}
function result(): WorldRegionResult {
  const diagnostics = new Float32Array(4);
  return {
    width: 2,
    height: 2,
    heights: new Float32Array([0, 0.5, 0.75, 1]),
    flow: diagnostics,
    wear: diagnostics,
    deposition: diagnostics,
    min: 0,
    max: 1,
    stages: [
      {
        nodeId: 'source',
        label: 'Hills',
        kind: 'noise',
        scope: 'pointwise',
        mode: 'native',
        backend: 'cpu-reference',
        algorithmVersion: 'test',
        samplesX: 2,
        samplesZ: 2,
        spacingX: 8000,
        spacingZ: 8000,
        simulationResolution: null,
        reason: 'Native',
      },
    ],
    spacingX: 8000,
    spacingZ: 8000,
    duration: 1,
    backend: 'cpu-reference',
    estimatedPeakBytes: 32,
  };
}

class FakeWorker {
  onmessage: ((event: MessageEvent<WorldWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  posts: WorldWorkerRequest[] = [];
  terminated = 0;
  postError?: Error;
  postMessage(message: WorldWorkerRequest) {
    if (this.postError) throw this.postError;
    this.posts.push(message);
  }
  terminate() {
    this.terminated++;
  }
  emit(message: WorldWorkerResponse) {
    this.onmessage?.({ data: message } as MessageEvent<WorldWorkerResponse>);
  }
  complete() {
    this.emit({ type: 'result', id: this.posts.at(-1)!.id, result: result(), cacheHit: false });
  }
}
function harness(budget?: number, entries?: number) {
  const workers: FakeWorker[] = [];
  const faults: { construct?: Error; post?: Error } = {};
  const callbacks: WorldPreviewCallbacks = {
    start: vi.fn(),
    progress: vi.fn(),
    result: vi.fn(),
    error: vi.fn(),
  };
  const client = new WorldPreviewClient(
    () => {
      if (faults.construct) throw faults.construct;
      const worker = new FakeWorker();
      worker.postError = faults.post;
      workers.push(worker);
      return worker;
    },
    budget,
    entries,
  );
  return { client, callbacks, workers, faults };
}

describe('World preview planning', () => {
  it('uses physical aspect and bounded samples for enormous authored worlds', () => {
    const { world } = input();
    world.domain.depth = 4000;
    world.domain.cellsX = 32768;
    world.domain.cellsZ = 32768;
    expect(createWorldPreviewGrid(world)).toMatchObject({ samplesX: 385, samplesZ: 193 });
    expect(createWorldPreviewGrid(world, null, 'detail')).toMatchObject({
      samplesX: 513,
      samplesZ: 257,
    });
    const tile = { startX: 32000, startZ: 0, cellsX: 128, cellsZ: 256 };
    const region = createWorldPreviewGrid(world, tile, 'detail');
    expect(region).toMatchObject({ ...tile, samplesX: 129, samplesZ: 257 });
    expect(isWorldOverview(world, region)).toBe(false);
    expect(isWorldOverview(world, createWorldPreviewGrid(world))).toBe(true);
    expect(createWorldPreviewGrid(world, { ...tile, cellsX: 0.5, cellsZ: 0.25 })).toMatchObject({
      samplesX: 2,
      samplesZ: 2,
    });
  });

  it('preserves prepared World identity through graph layout and legacy viewport changes', () => {
    const a = input();
    const baseline = worldEvaluationSignature(a.project, a.world);
    const cosmetic = structuredClone(a.project);
    cosmetic.name = 'Renamed';
    cosmetic.resolution = 1024;
    cosmetic.heightScale = 999;
    cosmetic.worldSize = 999;
    cosmetic.graph.nodes[0].position = { x: 400, y: 300 };
    cosmetic.graph.nodes[0].label = 'Renamed source';
    cosmetic.graph.nodes.push({
      id: 'experiment',
      kind: 'noise',
      label: 'Unconnected',
      position: { x: 0, y: 0 },
      params: { noiseModel: 'v3' },
    });
    expect(worldEvaluationSignature(cosmetic, a.world)).toBe(baseline);
    const disabledTransport = {
      ...a.world,
      transport: { ...DEFAULT_WORLD_TRANSPORT, iterations: 100 },
    };
    expect(worldEvaluationSignature(a.project, disabledTransport)).toBe(baseline);
    cosmetic.graph.nodes[0].params.octaves = 4;
    expect(worldEvaluationSignature(cosmetic, a.world)).not.toBe(baseline);
    expect(
      worldEvaluationSignature(a.project, { ...a.world, domain: { ...a.world.domain, datum: 5 } }),
    ).not.toBe(baseline);
    expect(worldEvaluationSignature(a.project, a.world, 'source')).not.toBe(baseline);
  });
});

describe('World preview client lifecycle', () => {
  it('deduplicates a running request and sends immutable snapshots', () => {
    const h = harness();
    const request = input();
    const id = h.client.preview(request, h.callbacks);
    expect(h.client.preview(request, h.callbacks)).toBe(id);
    expect(h.workers).toHaveLength(1);
    expect(h.workers[0].posts).toHaveLength(1);
    request.project.seed = 999;
    request.world.domain.width = 1234;
    expect(h.workers[0].posts[0].project.seed).toBe(17);
    expect(h.workers[0].posts[0].world.domain.width).toBe(8000);
  });

  it('reuses the idle worker and restores bounded regions instantly with current labels', () => {
    const h = harness();
    const first = input();
    h.client.preview(first, h.callbacks);
    h.workers[0].complete();
    h.client.preview({ ...first, grid: { ...first.grid, cellsX: 256 } }, h.callbacks);
    h.workers[0].complete();
    const renamed = structuredClone(first);
    renamed.project.graph.nodes[0].label = 'New hills';
    h.client.preview(renamed, h.callbacks);
    expect(h.workers).toHaveLength(1);
    expect(h.workers[0].posts).toHaveLength(2);
    expect(h.callbacks.result).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cacheHit: true,
        cacheSource: 'memory',
        result: expect.objectContaining({
          stages: [expect.objectContaining({ label: 'New hills' })],
        }),
      }),
    );
  });

  it('evicts least-recently used regions within both memory and entry bounds', () => {
    // The result has two distinct 16-byte buffers; aliased diagnostics count once.
    const h = harness(32, 1);
    const first = input();
    h.client.preview(first, h.callbacks);
    h.workers[0].complete();
    h.client.preview(first, h.callbacks);
    expect(h.workers[0].posts).toHaveLength(1);
    h.client.preview({ ...first, grid: { ...first.grid, cellsX: 256 } }, h.callbacks);
    h.workers[0].complete();
    h.client.preview(first, h.callbacks);
    expect(h.workers[0].posts).toHaveLength(3);
    h.client.clearCache();
    expect(h.workers[0].terminated).toBe(1);
    h.client.preview(first, h.callbacks);
    expect(h.workers).toHaveLength(2);
  });

  it('lets enabling persistent cache reach the worker even if a memory preview exists', () => {
    const h = harness();
    const request = input();
    h.client.preview(request, h.callbacks);
    h.workers[0].complete();
    h.client.preview({ ...request, cache: true }, h.callbacks);
    expect(h.workers[0].posts).toHaveLength(2);
    expect(h.workers[0].posts[1].cache).toBe(true);
    h.workers[0].complete();
    h.client.preview({ ...request, cache: true }, h.callbacks);
    expect(h.workers[0].posts).toHaveLength(2);
  });

  it('rejects stale results and errors after replacement, cancellation, and close', () => {
    const h = harness();
    const first = input();
    h.client.preview(first, h.callbacks);
    const old = h.workers[0];
    const lateMessage = old.onmessage!;
    const lateError = old.onerror!;
    const oldId = old.posts[0].id;
    h.client.preview({ ...first, grid: { ...first.grid, cellsX: 256 } }, h.callbacks);
    expect(old.terminated).toBe(1);
    lateMessage({
      data: { type: 'result', id: oldId, result: result(), cacheHit: false },
    } as MessageEvent<WorldWorkerResponse>);
    lateError({ message: 'late failure' } as ErrorEvent);
    expect(h.callbacks.result).not.toHaveBeenCalled();
    expect(h.callbacks.error).not.toHaveBeenCalled();
    const next = h.workers[1];
    next.emit({ type: 'result', id: oldId, result: result(), cacheHit: false });
    expect(h.callbacks.result).not.toHaveBeenCalled();
    const cancelledMessage = next.onmessage!;
    h.client.cancel();
    cancelledMessage({
      data: { type: 'result', id: next.posts[0].id, result: result(), cacheHit: false },
    } as MessageEvent<WorldWorkerResponse>);
    expect(h.callbacks.result).not.toHaveBeenCalled();
    h.client.preview(first, h.callbacks);
    h.client.dispose();
    h.workers[2].complete();
    expect(h.callbacks.result).not.toHaveBeenCalled();
  });

  it.each(['construct', 'post'] as const)('recovers from a synchronous %s failure', (fault) => {
    const h = harness();
    h.faults[fault] = new Error('injected failure');
    h.client.preview(input(), h.callbacks);
    expect(h.callbacks.error).toHaveBeenCalledWith('injected failure');
    for (const worker of h.workers) expect(worker.terminated).toBe(1);
    delete h.faults[fault];
    h.client.preview(input(), h.callbacks);
    h.workers.at(-1)!.complete();
    expect(h.callbacks.result).toHaveBeenCalledTimes(1);
  });

  it.each(['crash', 'unreadable', 'reported'] as const)(
    'cleans up a %s response and retries',
    (kind) => {
      const h = harness();
      h.client.preview(input(), h.callbacks);
      const worker = h.workers[0];
      if (kind === 'crash') worker.onerror?.({ message: 'Worker crashed' } as ErrorEvent);
      else if (kind === 'unreadable') worker.onmessageerror?.({} as MessageEvent);
      else worker.emit({ type: 'error', id: worker.posts[0].id, message: 'Could not sample' });
      expect(h.callbacks.error).toHaveBeenCalledTimes(1);
      expect(worker.terminated).toBe(1);
      h.client.preview(input(), h.callbacks);
      h.workers[1].complete();
      expect(h.callbacks.result).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps unknown work indeterminate and uses phase-local measured progress', () => {
    const h = harness();
    const id = h.client.preview(input(), h.callbacks);
    h.workers[0].emit({
      type: 'progress',
      id,
      progress: 0.6,
      stage: 'Rows',
      detail: {
        phase: 'sampling',
        stage: 'Hills',
        progress: 0.5,
        completed: 8,
        total: 16,
        unit: 'rows',
      },
    });
    expect(h.callbacks.progress).toHaveBeenLastCalledWith(
      expect.objectContaining({ progress: 0.5, completed: 8, total: 16 }),
    );
    h.workers[0].emit({
      type: 'progress',
      id,
      progress: 1,
      stage: 'Saving',
      detail: {
        phase: 'storing',
        stage: 'Saving',
        progress: null,
      },
    });
    expect(h.callbacks.progress).toHaveBeenLastCalledWith(
      expect.objectContaining({ progress: null, phase: 'storing' }),
    );
  });
});

function prepared(): PreparedWorldEvaluation {
  return {
    stages: [],
    capability: {
      supported: true,
      native: true,
      fullGraph: true,
      requiresGlobal: false,
      warnings: [],
    },
    computeCapability: {
      requested: 'cpu-reference',
      available: false,
      qualified: false,
      backend: 'cpu-reference',
      reason: 'Reference',
    },
    sampleRegion: vi.fn(async (_grid: WorldSampleGrid, options?: WorldRunOptions) => {
      options?.onProgressDetail?.({
        phase: 'sampling',
        stage: 'Old label',
        nodeId: 'source',
        progress: 0.5,
        completed: 8,
        total: 16,
        unit: 'rows',
      });
      return result();
    }),
    dispose: vi.fn(),
  };
}

describe('World worker preparation and publication', () => {
  it('reuses semantic preparation while forwarding real progress and fresh metadata', async () => {
    const context = prepared();
    const prepare = vi.fn(async () => context);
    const session = new WorldPreviewSession({ prepare, now: () => 100 });
    const events: WorldWorkerResponse[] = [];
    const transfers: Transferable[][] = [];
    const send = (event: WorldWorkerResponse, transfer: Transferable[] = []) => {
      events.push(event);
      transfers.push(transfer);
    };
    const request = input();
    await session.run({ type: 'preview', id: 1, ...request }, send);
    const renamed = structuredClone(request);
    renamed.project.graph.nodes[0].label = 'Renamed hills';
    renamed.project.resolution = 2048;
    await session.run(
      { type: 'preview', id: 2, ...renamed, grid: { ...request.grid, cellsX: 256 } },
      send,
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(context.sampleRegion).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'progress',
        id: 2,
        detail: expect.objectContaining({
          stage: 'Renamed hills',
          completed: 8,
          total: 16,
          unit: 'rows',
        }),
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      preparedReused: true,
      result: { stages: [{ label: 'Renamed hills' }] },
    });
    expect(transfers.at(-1)).toHaveLength(2);
    session.dispose();
    expect(context.dispose).toHaveBeenCalledTimes(1);
  });

  it('isolates new graph revisions and inspected targets', async () => {
    const contexts: PreparedWorldEvaluation[] = [];
    const prepare = vi.fn(async () => {
      const context = prepared();
      contexts.push(context);
      return context;
    });
    const session = new WorldPreviewSession({ prepare });
    const request = input();
    const send = vi.fn();
    await session.run({ type: 'preview', id: 1, ...request }, send);
    await session.run({ type: 'preview', id: 2, ...request, previewNodeId: 'source' }, send);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenLastCalledWith(
      request.project,
      request.world,
      expect.objectContaining({ previewNodeId: 'source' }),
    );
    expect(contexts[0].dispose).toHaveBeenCalledTimes(1);
    request.project.seed++;
    await session.run({ type: 'preview', id: 3, ...request }, send);
    expect(prepare).toHaveBeenCalledTimes(3);
    session.dispose();
  });

  it('disposes late preparation without publishing or disposing a newer context', async () => {
    const resolvers: ((context: PreparedWorldEvaluation) => void)[] = [];
    const prepare = vi.fn(
      () => new Promise<PreparedWorldEvaluation>((resolve) => resolvers.push(resolve)),
    );
    const session = new WorldPreviewSession({ prepare });
    const send = vi.fn();
    const request = input();
    const first = session.run({ type: 'preview', id: 1, ...request }, send);
    const second = session.run(
      { type: 'preview', id: 2, ...request, project: { ...request.project, seed: 99 } },
      send,
    );
    const old = prepared(),
      current = prepared();
    resolvers[1](current);
    await second;
    resolvers[0](old);
    await first;
    expect(old.dispose).toHaveBeenCalledTimes(1);
    expect(current.dispose).not.toHaveBeenCalled();
    const results = send.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(2);
    session.dispose();
  });

  it('releases failed preparation and permits a clean retry', async () => {
    const first = prepared(),
      second = prepared();
    first.sampleRegion = vi.fn(async () => {
      throw new Error('Sampling failed');
    });
    const prepare = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const session = new WorldPreviewSession({ prepare });
    const send = vi.fn();
    const request = input();
    await session.run({ type: 'preview', id: 1, ...request }, send);
    expect(send).toHaveBeenLastCalledWith({ type: 'error', id: 1, message: 'Sampling failed' }, []);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    await session.run({ type: 'preview', id: 2, ...request }, send);
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'result', id: 2 }),
      expect.any(Array),
    );
    session.dispose();
  });
});

describe('measured World progress', () => {
  it.each(['v3', 'legacy'])(
    'keeps %s World values independent of legacy viewport settings',
    async (model) => {
      const scene = project();
      scene.graph.nodes[0].params.noiseModel = model;
      const world = { ...createWorldDefinition(scene), globalResolution: 64 };
      const grid = { startX: 0, startZ: 0, cellsX: 32, cellsZ: 32, samplesX: 9, samplesZ: 9 };
      const original = await generateWorldRegion(scene, world, grid);
      const edited = await generateWorldRegion(
        {
          ...scene,
          name: 'Renamed',
          resolution: 2048,
          worldSize: 12345,
          heightScale: 9999,
        },
        world,
        grid,
      );
      for (const channel of ['heights', 'flow', 'wear', 'deposition'] as const)
        expect(edited[channel]).toEqual(original[channel]);
    },
  );

  it('reports real sampled rows without changing terrain values', async () => {
    const scene = project();
    const world = createWorldDefinition(scene);
    world.globalResolution = 64;
    const grid = { startX: 0, startZ: 0, cellsX: 32, cellsZ: 32, samplesX: 17, samplesZ: 19 };
    const events: WorldEvaluationProgress[] = [];
    const observed = await generateWorldRegion(scene, world, grid, {
      onProgressDetail: (progress) => events.push(progress),
    });
    const baseline = await generateWorldRegion(scene, world, grid);
    expect(observed.heights).toEqual(baseline.heights);
    const rows = events.filter((event) => event.phase === 'sampling' && event.unit === 'rows');
    expect(rows.map((event) => event.completed)).toEqual([8, 16, 19]);
    expect(
      rows.every((event) => event.total === 19 && event.progress === event.completed! / 19),
    ).toBe(true);
  });

  it('reports completed transport iterations separately from regional reconstruction', async () => {
    const scene = project();
    const world: WorldDefinition = {
      ...createWorldDefinition(scene),
      globalResolution: 64,
      transport: { ...DEFAULT_WORLD_TRANSPORT, enabled: true, iterations: 3 },
    };
    const events: WorldEvaluationProgress[] = [];
    await generateWorldRegion(
      scene,
      world,
      { startX: 0, startZ: 0, cellsX: 32, cellsZ: 32, samplesX: 9, samplesZ: 9 },
      {
        onProgressDetail: (progress) => events.push(progress),
      },
    );
    expect(
      events
        .filter((event) => event.phase === 'transport' && event.unit === 'iterations')
        .map((event) => event.completed),
    ).toEqual([1, 2, 3]);
    expect(events).toContainEqual(
      expect.objectContaining({ phase: 'sampling', unit: 'rows', completed: 9, total: 9 }),
    );
  });
});
