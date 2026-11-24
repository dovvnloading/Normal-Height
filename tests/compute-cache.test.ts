import { describe, expect, it, vi } from 'vitest';
import { evaluateGraph } from '../src/engine';
import { GraphFieldCache } from '../src/engine/compute/cache';
import { TerrainComputeClient } from '../src/engine/compute/client';
import type { TerrainWorkerPort } from '../src/engine/compute/client';
import { compileGraph, semanticProjectSignature } from '../src/engine/plan/graph';
import type {
  EvaluationResult,
  GenerateRequest,
  TerrainNode,
  TerrainProject,
  WorkerResponse,
} from '../src/model/types';

const node = (
  id: string,
  kind: TerrainNode['kind'],
  params: TerrainNode['params'] = {},
): TerrainNode => ({ id, kind, params, label: id, position: { x: 0, y: 0 } });
const scene = (): TerrainProject => ({
  version: 1,
  name: 'Cache test',
  seed: 23,
  resolution: 32,
  worldSize: 4000,
  heightScale: 1800,
  presetId: 'test',
  graph: {
    nodes: [
      node('source', 'noise', { noiseModel: 'v2' }),
      node('shape', 'terrace'),
      node('out', 'output'),
      node('disconnected', 'mountain'),
    ],
    edges: [
      { id: 'a', source: 'source', target: 'shape' },
      { id: 'b', source: 'shape', target: 'out' },
    ],
  },
});
const run = (project: TerrainProject, cache?: GraphFieldCache, previewNodeId?: string) =>
  evaluateGraph(project, { resolution: project.resolution, previewNodeId }, cache);
const checkEqual = (cached: EvaluationResult, plain: EvaluationResult) => {
  for (const channel of ['height', 'flow', 'wear', 'deposition'] as const)
    expect(cached.field[channel]).toEqual(plain.field[channel]);
  expect(cached.stats).toEqual(plain.stats);
};

describe('persistent CPU graph cache', () => {
  it('compiles only reachable dependencies in execution order with reverse indexes', () => {
    const plan = compileGraph(scene());
    expect(plan.stages.map((stage) => stage.nodeId)).toEqual(['source', 'shape', 'out']);
    expect(plan.consumers.get('source')).toEqual(['shape']);
    expect(plan.needed.has('disconnected')).toBe(false);
  });

  it('reuses valid ancestors across downstream edits, previews, undo and presentation changes', () => {
    const project = scene(),
      cache = new GraphFieldCache();
    const first = run(project, cache);
    expect(first.diagnostics?.cacheMisses).toBe(3);
    const warm = run(project, cache);
    checkEqual(warm, first);
    expect(warm.diagnostics?.cacheHits).toBe(3);
    project.graph.nodes[1].params.steps = 8;
    const edited = run(project, cache);
    checkEqual(edited, run(project));
    expect(edited.diagnostics?.nodes.map((n) => n.status)).toEqual(['hit', 'computed', 'computed']);
    delete project.graph.nodes[1].params.steps;
    const undone = run(project, cache);
    checkEqual(undone, first);
    expect(undone.diagnostics?.cacheHits).toBe(3);
    expect(run(project, cache, 'source').diagnostics?.cacheHits).toBe(1);
    project.graph.nodes.reverse();
    project.graph.edges.reverse();
    project.graph.nodes.forEach((n) => {
      n.position.x = 100;
      n.label += ' changed';
    });
    project.graph.edges.forEach((e) => {
      e.id += ' new';
      e.sourceHandle = 'height';
      e.targetHandle = 'in';
    });
    expect(run(project, cache).diagnostics?.cacheHits).toBe(3);
  });

  it('ignores node identifiers in content identity while preserving thumbnails and selection', () => {
    const project = scene(),
      cache = new GraphFieldCache();
    const before = run(project, cache);
    project.graph.nodes.forEach((n) => {
      n.id += '-new';
    });
    project.graph.edges.forEach((e) => {
      e.source += '-new';
      e.target += '-new';
    });
    const after = run(project, cache);
    checkEqual(after, before);
    expect(after.diagnostics?.cacheHits).toBe(3);
    expect(after.outputNodeId).toBe('out-new');
    expect(Object.keys(after.thumbnails)).toEqual(['source-new', 'shape-new', 'out-new']);
  });

  it.each(['seed', 'worldSize', 'heightScale', 'resolution'] as const)(
    'invalidates conservative %s dependencies',
    (property) => {
      const project = scene(),
        cache = new GraphFieldCache();
      run(project, cache);
      project[property] += 16;
      const next = run(project, cache);
      expect(next.diagnostics?.cacheHits).toBe(0);
      checkEqual(next, run(project));
    },
  );

  it('keeps diagnostic routing, bypass, and spline geometry in the dependency contract', () => {
    const project = scene(),
      cache = new GraphFieldCache();
    run(project, cache);
    project.graph.edges[0].sourceHandle = 'flow';
    const diagnostic = run(project, cache);
    expect(diagnostic.field.height.every((v) => v === 0)).toBe(true);
    expect(diagnostic.diagnostics?.cacheHits).toBe(1);
    project.graph.nodes[1].bypassed = true;
    checkEqual(run(project, cache), run(project));
    project.graph.edges[0].sourceHandle = 'height';
    project.graph.nodes[1] = {
      ...node('shape', 'spline'),
      path: [
        { x: 0.2, y: 0.2 },
        { x: 0.8, y: 0.8 },
      ],
    };
    run(project, cache);
    project.graph.nodes[1].path![0].x = 0.4;
    const moved = run(project, cache);
    checkEqual(moved, run(project));
    expect(moved.diagnostics?.cacheHits).toBe(1);
  });

  it('does not evaluate bypassed secondary branches or invalidate from disconnected edits', () => {
    const project = scene();
    project.graph.nodes[1] = { ...node('shape', 'blend'), bypassed: true };
    project.graph.edges[0].targetHandle = 'a';
    project.graph.edges.push({
      id: 'c',
      source: 'disconnected',
      target: 'shape',
      targetHandle: 'b',
    });
    const cache = new GraphFieldCache();
    run(project, cache);
    const signature = semanticProjectSignature(project);
    project.graph.nodes[3].params.relief = 20;
    expect(semanticProjectSignature(project)).toBe(signature);
    const next = run(project, cache);
    expect(next.diagnostics?.cacheHits).toBe(3);
    expect(next.thumbnails.disconnected).toBeUndefined();
  });

  it('returned fields are independent, and transfers never detach the authoritative cache', () => {
    const project = scene(),
      cache = new GraphFieldCache();
    const reference = run(project);
    const first = run(project, cache);
    first.field.height.fill(-100);
    first.field.wear.fill(200);
    const second = run(project, cache);
    checkEqual(second, reference);
    const buffers = [
      ...new Set(
        Object.values(second.field)
          .filter((value): value is Float32Array => value instanceof Float32Array)
          .map((array) => array.buffer),
      ),
    ];
    structuredClone(second, { transfer: buffers });
    expect(second.field.height.length).toBe(0);
    checkEqual(run(project, cache), reference);
  });

  it('counts unique buffers once for forwarding stages, bounds retention and recovers after eviction', () => {
    const project = scene();
    project.graph.nodes[1].bypassed = true;
    const oneField = 2 * project.resolution ** 2 * 4;
    const cache = new GraphFieldCache(oneField);
    const first = run(project, cache);
    expect(first.diagnostics?.cacheBytes).toBe(oneField);
    expect(cache.size).toBe(3);
    expect(run(project, cache).diagnostics?.cacheHits).toBe(3);
    for (let seed = 0; seed < 16; seed++) {
      project.seed = seed;
      const result = run(project, cache);
      expect(result.diagnostics!.cacheBytes).toBeLessThanOrEqual(oneField);
      checkEqual(result, run(project));
    }
    expect(cache.evictions).toBeGreaterThan(0);
    cache.clear();
    expect(cache.bytes).toBe(0);
    expect(cache.size).toBe(0);
    checkEqual(run(project, cache), run(project));
  });

  it('does not publish partial entries after an incomplete graph fails', () => {
    const project = scene(),
      cache = new GraphFieldCache();
    project.graph.nodes[1] = node('shape', 'blend');
    project.graph.edges[0].targetHandle = 'a';
    expect(() => run(project, cache)).toThrow('both A and B');
    expect(cache.bytes).toBe(0);
    expect(cache.size).toBe(0);
  });

  it('accepts unfinished disconnected nodes and preserves committed cache after structural failures', () => {
    const project = scene(),
      cache = new GraphFieldCache();
    project.graph.nodes[3] = node('disconnected', 'blend');
    const original = run(project, cache);
    project.graph.edges.push({ id: 'cycle', source: 'out', target: 'source' });
    expect(() => run(project, cache)).toThrow();
    project.graph.edges.pop();
    const recovered = run(project, cache);
    checkEqual(recovered, original);
    expect(recovered.diagnostics?.cacheHits).toBe(3);
  });

  it('invalidates one branch and descendants while retaining the independent branch', () => {
    const project = scene(),
      cache = new GraphFieldCache();
    project.graph.nodes[1] = node('shape', 'blend');
    project.graph.nodes[3] = node('other', 'noise', { mode: 'ridged' });
    project.graph.edges[0].targetHandle = 'a';
    project.graph.edges.push({ id: 'c', source: 'other', target: 'shape', targetHandle: 'b' });
    run(project, cache);
    project.graph.nodes[3].params.scale = 6;
    const next = run(project, cache);
    expect(next.diagnostics?.nodes.find((entry) => entry.nodeId === 'source')?.status).toBe('hit');
    expect(
      next.diagnostics?.nodes
        .filter((entry) => entry.status === 'computed')
        .map((entry) => entry.nodeId),
    ).toEqual(['other', 'shape', 'out']);
    checkEqual(next, run(project));
  });

  it('matches an independent uncached evaluation under seeded random branched-DAG edits', () => {
    const project = scene(),
      cache = new GraphFieldCache(96 * 1024);
    project.graph.nodes = [
      node('a', 'noise', { noiseModel: 'v2' }),
      node('b', 'noise'),
      node('c', 'noise', { mode: 'ridged' }),
      node('shapeA', 'remap'),
      node('shapeB', 'terrace'),
      node('mix', 'blend'),
      node('mask', 'mask'),
      node('out', 'output'),
      node('unfinished', 'blend'),
    ];
    project.graph.edges = [
      { id: 'e1', source: 'a', target: 'shapeA' },
      { id: 'e2', source: 'b', target: 'shapeB' },
      { id: 'e3', source: 'shapeA', target: 'mix', targetHandle: 'a' },
      { id: 'e4', source: 'shapeB', target: 'mix', targetHandle: 'b' },
      { id: 'e5', source: 'c', target: 'mask' },
      { id: 'e6', source: 'mask', target: 'mix', targetHandle: 'mask' },
      { id: 'e7', source: 'mix', target: 'out' },
    ];
    let seed = 0x4f12abcd;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let edit = 0; edit < 80; edit++) {
      const id = ['a', 'b', 'c'][Math.floor(random() * 3)];
      const source = project.graph.nodes.find((value) => value.id === id)!;
      source.params.seed = Math.floor(random() * 8);
      const shape = project.graph.nodes.find((value) => value.id === 'shapeA')!;
      shape.params.brightness = Math.round(random() * 8) / 20;
      shape.bypassed = random() < 0.2;
      const mixNode = project.graph.nodes.find((value) => value.id === 'mix')!;
      mixNode.params.mode = ['mix', 'add', 'multiply', 'min', 'max'][Math.floor(random() * 5)];
      mixNode.params.amount = Math.floor(random() * 8) / 8;
      project.graph.edges.find((edge) => edge.id === 'e4')!.sourceHandle =
        random() < 0.1 ? 'flow' : 'height';
      if (random() < 0.25) project.graph.nodes.reverse();
      if (random() < 0.25) project.graph.edges.reverse();
      const preview = random() < 0.2 ? 'shapeB' : undefined;
      checkEqual(run(project, cache, preview), run(project, undefined, preview));
      expect(cache.bytes).toBeLessThanOrEqual(cache.budgetBytes);
    }
  });

  it('matches uncached CPU output through deterministic repeated DAG mutations', () => {
    const project = scene(),
      cache = new GraphFieldCache(64 * 1024);
    for (let i = 0; i < 40; i++) {
      project.graph.nodes[0].params.mode = ['ridged', 'fbm', 'wave'][i % 3];
      project.graph.nodes[1].params.steps = 2 + (i % 19);
      project.graph.nodes[1].bypassed = i % 7 === 0;
      project.graph.edges[0].sourceHandle = i % 9 === 0 ? 'wear' : 'height';
      project.seed = i % 4;
      checkEqual(run(project, cache), run(project));
    }
  });
});

class FakeWorker implements TerrainWorkerPort {
  onmessage: TerrainWorkerPort['onmessage'] = null;
  onerror: TerrainWorkerPort['onerror'] = null;
  requests: GenerateRequest[] = [];
  terminated = false;
  postMessage(request: GenerateRequest) {
    this.requests.push(request);
  }
  terminate() {
    this.terminated = true;
  }
  reply(message: WorkerResponse) {
    this.onmessage?.({ data: message } as MessageEvent<WorkerResponse>);
  }
}

describe('persistent worker scheduling', () => {
  const setup = () => {
    const workers: FakeWorker[] = [];
    const client = new TerrainComputeClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    const callbacks = { progress: vi.fn(), result: vi.fn(), error: vi.fn() };
    return { client, workers, callbacks };
  };

  it('retains completed workers, uses fresh request IDs and releases on disposal', () => {
    const { client, workers, callbacks } = setup();
    const project = scene(),
      result = run(project);
    client.generate(project, undefined, callbacks);
    workers[0].reply({ type: 'result', id: workers[0].requests[0].id, result });
    client.generate(project, undefined, callbacks);
    expect(workers).toHaveLength(1);
    expect(workers[0].requests[1].id).not.toBe(workers[0].requests[0].id);
    client.dispose();
    expect(workers[0].terminated).toBe(true);
  });

  it('terminates noncooperative work and rejects old epochs after replacement and cancellation', () => {
    const { client, workers, callbacks } = setup();
    const project = scene(),
      result = run(project);
    client.generate(project, undefined, callbacks);
    client.generate(project, 'source', callbacks);
    expect(workers).toHaveLength(2);
    expect(workers[0].terminated).toBe(true);
    workers[0].reply({ type: 'result', id: workers[0].requests[0].id, result });
    expect(callbacks.result).not.toHaveBeenCalled();
    client.cancel();
    workers[1].reply({ type: 'result', id: workers[1].requests[0].id, result });
    expect(callbacks.result).not.toHaveBeenCalled();
    client.generate(project, undefined, callbacks);
    workers[2].reply({ type: 'result', id: workers[2].requests[0].id, result });
    expect(callbacks.result).toHaveBeenCalledOnce();
  });

  it('preserves idle caches on cancel and recovers from worker errors', () => {
    const { client, workers, callbacks } = setup();
    const project = scene();
    client.generate(project, undefined, callbacks);
    workers[0].reply({ type: 'error', id: workers[0].requests[0].id, message: 'Invalid graph' });
    client.cancel();
    expect(workers[0].terminated).toBe(false);
    client.generate(project, undefined, callbacks);
    workers[0].onerror?.({ message: 'Worker crashed' } as ErrorEvent);
    expect(workers[0].terminated).toBe(true);
    client.generate(project, undefined, callbacks);
    expect(workers).toHaveLength(2);
    client.clearCache();
    expect(workers[1].terminated).toBe(true);
  });
});
