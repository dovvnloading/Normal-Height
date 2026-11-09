import { describe, expect, it } from 'vitest';
import type { TerrainNode, TerrainProject } from '../src/model/types';
import { evaluateGraph, hydraulicErosion, thermalErosion, validateGraph } from '../src/engine';

const node = (
  id: string,
  kind: TerrainNode['kind'],
  params: TerrainNode['params'] = {},
): TerrainNode => ({ id, kind, label: id, params, position: { x: 0, y: 0 } });
const project = (
  nodes: TerrainNode[] = [node('range', 'mountain'), node('out', 'output')],
): TerrainProject => ({
  version: 1,
  name: 'Test terrain',
  seed: 1492,
  resolution: 64,
  worldSize: 4000,
  heightScale: 1800,
  presetId: 'test',
  graph: {
    nodes,
    edges: nodes.slice(1).map((value, i) => ({
      id: `e${i}`,
      source: nodes[i].id,
      target: value.id,
      sourceHandle: 'height',
      targetHandle: 'in',
    })),
  },
});
const sum = (values: Float32Array) => values.reduce((total, value) => total + value, 0);
const settings = {
  droplets: 100000,
  lifetime: 100,
  inertia: 0.15,
  capacity: 5,
  erosion: 0.4,
  deposition: 0.3,
  evaporation: 0.02,
  radius: 2,
  gravity: 4,
  seed: 44,
  multiscale: true,
};

describe('terrain evaluation', () => {
  it('reproduces seeded output independently of node positions and reports bounded samples', () => {
    const scene = project(),
      first = evaluateGraph(scene, { resolution: 48 });
    scene.graph.nodes[0].position = { x: 800, y: -400 };
    const repeated = evaluateGraph(scene, { resolution: 48 });
    expect(repeated.field.height).toEqual(first.field.height);
    expect(first.field.height.every(Number.isFinite)).toBe(true);
    expect(first.stats.max - first.stats.min).toBeGreaterThan(0.2);
    expect(first.thumbnails.range).toHaveLength(48 * 48);
    scene.seed++;
    expect(evaluateGraph(scene, { resolution: 48 }).field.height).not.toEqual(first.field.height);
  });

  it('implements distinct spatial noise families, including Naki-inspired and wave', () => {
    const modes = [
      'perlin',
      'simplex',
      'fbm',
      'ridged',
      'billow',
      'turbulence',
      'voronoi',
      'voronoi-edge',
      'cellular',
      'wave',
      'warped',
      'naki',
    ];
    const maps = modes.map(
      (mode) =>
        evaluateGraph(project([node('noise', 'noise', { mode }), node('out', 'output')]), {
          resolution: 32,
        }).field.height,
    );
    for (let i = 0; i < maps.length; i++) {
      expect(maps[i].every(Number.isFinite)).toBe(true);
      for (let j = i + 1; j < maps.length; j++)
        expect(sum(maps[i].map((v, k) => Math.abs(v - maps[j][k])))).toBeGreaterThan(2);
    }
  });

  it('previews the selected node without requiring unfinished downstream nodes', () => {
    const scene = project([node('noise', 'noise'), node('blend', 'blend'), node('out', 'output')]);
    scene.graph.edges[0].targetHandle = 'a';
    expect(() => evaluateGraph(scene, { resolution: 32 })).toThrow('both A and B');
    const preview = evaluateGraph(scene, { resolution: 32, previewNodeId: 'noise' });
    expect(preview.outputNodeId).toBe('noise');
    expect(Object.keys(preview.thumbnails)).toEqual(['noise']);
  });

  it('rejects cyclic graphs and multiple sources on one input', () => {
    const scene = project([node('a', 'remap'), node('b', 'remap'), node('out', 'output')]);
    scene.graph.edges.push({ id: 'cycle', source: 'b', target: 'a', targetHandle: 'in' });
    expect(validateGraph(scene.graph)).toMatch(/cycle/);
    scene.graph.edges = [
      { id: 'one', source: 'a', target: 'out' },
      { id: 'two', source: 'b', target: 'out' },
    ];
    expect(validateGraph(scene.graph)).toMatch(/already has a connection/);
  });

  it('routes the flow output as a scalar field and preserves bypass behavior', () => {
    const scene = project([
      node('range', 'mountain'),
      node('rain', 'hydraulic', { droplets: 100000 }),
      node('out', 'output'),
    ]);
    const erosion = evaluateGraph(scene, { resolution: 48, previewNodeId: 'rain' });
    scene.graph.edges[1].sourceHandle = 'flow';
    const flow = evaluateGraph(scene, { resolution: 48 });
    expect(flow.field.height).toEqual(erosion.field.flow);
    expect(Math.max(...flow.field.height)).toBeCloseTo(1);
    scene.graph.edges[1].sourceHandle = 'height';
    scene.graph.nodes[1].bypassed = true;
    const original = evaluateGraph(scene, { resolution: 48, previewNodeId: 'range' });
    expect(evaluateGraph(scene, { resolution: 48 }).field.height).toEqual(original.field.height);
  });

  it('honors a connected zero mask for hydraulic and blend nodes', () => {
    const scene = project([
      node('range', 'mountain'),
      node('rain', 'hydraulic'),
      node('out', 'output'),
    ]);
    scene.graph.nodes.push(node('zero', 'noise', { amplitude: 0, offset: 0 }));
    scene.graph.edges.push({ id: 'mask', source: 'zero', target: 'rain', targetHandle: 'mask' });
    const before = evaluateGraph(scene, { resolution: 32, previewNodeId: 'range' });
    const masked = evaluateGraph(scene, { resolution: 32 });
    expect(masked.field.height).toEqual(before.field.height);
    expect(masked.stats.eroded).toBe(0);
    scene.graph.nodes[1] = node('rain', 'blend', { amount: 1 });
    scene.graph.edges[0].targetHandle = 'a';
    scene.graph.edges.push({ id: 'b', source: 'zero', target: 'rain', targetHandle: 'b' });
    expect(evaluateGraph(scene, { resolution: 32 }).field.height).toEqual(before.field.height);
  });

  it('keeps wear and deposition spatially aligned when a downstream warp changes the terrain', () => {
    const scene = project([
      node('range', 'mountain'),
      node('rain', 'hydraulic', { droplets: 120000 }),
      node('warp', 'warp', { strength: 1.2, scale: 4.5, seed: 18 }),
      node('out', 'output'),
    ]);
    const before = evaluateGraph(scene, { resolution: 48, previewNodeId: 'rain' });
    const warped = evaluateGraph(scene, { resolution: 48 });
    for (const channel of ['wear', 'deposition'] as const) {
      const maximum = Math.max(...before.field[channel]);
      expect(maximum).toBeGreaterThan(0);
      expect(
        sum(warped.field[channel].map((value, i) => Math.abs(value - before.field[channel][i]))),
      ).toBeGreaterThan(0.01);
      // Routing the same diagnostic through the public height input gives an
      // independent observable for how that image should be spatially warped.
      scene.graph.edges[1].sourceHandle = channel;
      const diagnosticAsHeight = evaluateGraph(scene, { resolution: 48 });
      const maximumError = Math.max(
        ...warped.field[channel].map((value, i) =>
          Math.abs(value - diagnosticAsHeight.field.height[i] * maximum),
        ),
      );
      expect(maximumError).toBeLessThan(0.0000002);
    }
  });

  it('blends diagnostics from both simulated sources, including local mask influence', () => {
    const scene = project([
      node('range', 'mountain'),
      node('rainA', 'hydraulic', { seed: 8 }),
      node('rainB', 'hydraulic', { seed: 37 }),
      node('mix', 'blend', { amount: 0.6 }),
      node('weight', 'noise', { amplitude: 0, offset: 0.5 }),
      node('out', 'output'),
    ]);
    scene.graph.edges = [
      { id: 'a', source: 'range', target: 'rainA' },
      { id: 'b', source: 'range', target: 'rainB' },
      { id: 'c', source: 'rainA', target: 'mix', targetHandle: 'a' },
      { id: 'd', source: 'rainB', target: 'mix', targetHandle: 'b' },
      { id: 'mask', source: 'weight', target: 'mix', targetHandle: 'mask' },
      { id: 'out', source: 'mix', target: 'out' },
    ];
    const a = evaluateGraph(scene, { resolution: 32, previewNodeId: 'rainA' }),
      b = evaluateGraph(scene, { resolution: 32, previewNodeId: 'rainB' });
    const blended = evaluateGraph(scene, { resolution: 32 });
    for (const channel of ['wear', 'deposition'] as const) {
      const error = Math.max(
        ...blended.field[channel].map((value, i) =>
          Math.abs(value - (a.field[channel][i] * 0.7 + b.field[channel][i] * 0.3)),
        ),
      );
      expect(error).toBeLessThan(0.0000001);
    }
    expect(blended.stats.eroded).toBeCloseTo(sum(blended.field.wear), 6);
    expect(blended.stats.deposited).toBeCloseTo(sum(blended.field.deposition), 6);
  });

  it('rejects excessive high-resolution graphs before generation and recommends a usable resolution', () => {
    const scene = project([
      node('range', 'mountain'),
      ...Array.from({ length: 40 }, (_, i) => node(`shape${i}`, 'remap')),
      node('out', 'output'),
    ]);
    let updates = 0;
    expect(() =>
      evaluateGraph(scene, {
        resolution: 2048,
        onProgress: () => {
          updates++;
        },
      }),
    ).toThrow(/512 MiB.*Choose 1024/);
    expect(updates).toBe(0);
    // The same valid graph can still be evaluated at a smaller working size.
    expect(evaluateGraph(scene, { resolution: 32 }).field.height).toHaveLength(32 * 32);
  });
});

describe('material transport', () => {
  it('carves terrain, transports sediment, remains deterministic, and accounts for escaped material', () => {
    const n = 48;
    const input = evaluateGraph(project(), { resolution: n, previewNodeId: 'range' }).field.height;
    const result = hydraulicErosion(input, n, settings);
    expect(result.height).not.toEqual(input);
    expect(result.height).toEqual(hydraulicErosion(input, n, settings).height);
    expect(result.eroded).toBeGreaterThan(0.1);
    expect(result.deposited).toBeGreaterThan(0);
    expect(result.exportedSediment).toBeGreaterThanOrEqual(0);
    expect(result.flow.some((v) => v > 0)).toBe(true);
    expect(result.wear.some((v) => v > 0)).toBe(true);
    expect(result.deposition.some((v) => v > 0)).toBe(true);
    expect(
      Math.abs(sum(input) - sum(result.height) - (result.eroded - result.deposited)),
    ).toBeLessThan(0.0001);
    expect(Math.abs(result.eroded - result.deposited - result.exportedSediment)).toBeLessThan(
      0.0001,
    );
    expect(result.height.every(Number.isFinite)).toBe(true);
  });

  it('preserves sediment mass during thermal settling while reducing excessive slopes', () => {
    const n = 32,
      input = new Float32Array(n * n);
    input[(n / 2) * n + n / 2] = 1;
    const result = thermalErosion(input, n, 30, 0.001, 0.6);
    expect(sum(result)).toBeCloseTo(sum(input), 5);
    expect(Math.max(...result)).toBeLessThan(0.3);
    expect(Math.min(...result)).toBeGreaterThanOrEqual(0);
  });
});
