import { describe, expect, it } from 'vitest';
import type { TerrainNode, TerrainProject } from '../src/model/types';
import { createWorldDefinition, normalizeWorldDefinition, validateWorldDefinition } from '../src/model/world';
import { describeWorldGraph, generateWorldRegion, prepareWorldEvaluation, sampleArea, sampleOwner, worldCoordinate, worldTile, listWorldTiles } from '../src/engine/world';
import type { WorldSampleGrid } from '../src/engine/world';

const node = (id: string, kind: TerrainNode['kind'], params: TerrainNode['params'] = {}): TerrainNode =>
  ({ id, kind, label: id, params, position: { x: 0, y: 0 } });
function project(extra: TerrainNode[] = []): TerrainProject {
  const nodes = [node('source', 'noise', { noiseModel: 'v3', kernel: 'perlin', fractal: 'fbm', octaves: 3, sampling: 'point' }), ...extra, node('out', 'output')];
  return { version: 1, name: 'World oracle', seed: 15, resolution: 64, worldSize: 4000, heightScale: 1800, presetId: 'test',
    graph: { nodes, edges: nodes.slice(1).map((n, i) => ({ id: `e${i}`, source: nodes[i].id, target: n.id, targetHandle: n.kind === 'blend' ? 'a' : 'in' })) } };
}
function definition(scene = project()) {
  const world = createWorldDefinition(scene);
  world.domain.cellsX = 67; world.domain.cellsZ = 39;
  world.domain.depth = 2400; world.domain.originX = -1731; world.domain.originZ = -911;
  world.tileCells = 32; world.globalResolution = 64;
  return world;
}
const whole = (world: ReturnType<typeof definition>): WorldSampleGrid => ({ startX: 0, startZ: 0, cellsX: world.domain.cellsX, cellsZ: world.domain.cellsZ, samplesX: world.domain.cellsX + 1, samplesZ: world.domain.cellsZ + 1 });
function expectCrop(full: Float32Array, width: number, part: Float32Array, region: WorldSampleGrid) {
  for (let z = 0; z < region.samplesZ; z++) for (let x = 0; x < region.samplesX; x++)
    expect(part[z * region.samplesX + x]).toBe(full[(region.startZ + z) * width + region.startX + x]);
}

describe('World domain contracts', () => {
  it('validates before allocation and preserves explicit interval counts', () => {
    const world = definition();
    expect(validateWorldDefinition(world)).toBeNull();
    expect(normalizeWorldDefinition(world, project())).toEqual(world);
    expect(normalizeWorldDefinition(world, project()).domain).not.toBe(world.domain);
    expect(validateWorldDefinition({ ...world, domain: { ...world.domain, cellsX: 1.5 } })).toMatch(/integer/);
    expect(validateWorldDefinition({ ...world, domain: { ...world.domain, width: Infinity } })).toMatch(/finite/);
    expect(() => normalizeWorldDefinition({ ...world, version: 9 }, project())).toThrow(/schema/);
  });
  it('owns shared borders once and integrates exact rectangular physical area', () => {
    const world = definition(), d = world.domain;
    expect(sampleOwner(world, 32, 32)).toEqual({ level: 0, x: 0, z: 0 });
    expect(sampleOwner(world, 33, 32)).toEqual({ level: 0, x: 1, z: 0 });
    let area = 0;
    for (let j = 0; j <= d.cellsZ; j++) for (let i = 0; i <= d.cellsX; i++) area += sampleArea(d, i, j);
    expect(area).toBeCloseTo(d.width * d.depth, 5);
    expect(worldCoordinate(d, d.cellsX, d.cellsZ)).toEqual({ x: d.originX + d.width, z: d.originZ + d.depth });
  });
});

describe('native World sampling', () => {
  it('stitches shuffled rectangular partial tiles byte-exactly, including corners', async () => {
    const scene = project([node('remap', 'remap', { contrast: 1.7, gamma: 0.8 }), node('terrace', 'terrace', { steps: 9 })]);
    const world = definition(scene), evaluation = await prepareWorldEvaluation(scene, world);
    try {
      const full = await evaluation.sampleRegion(whole(world));
      for (const key of listWorldTiles(world).reverse()) {
        const region = worldTile(world, key).grid, tile = await evaluation.sampleRegion(region);
        expectCrop(full.heights, full.width, tile.heights, region);
      }
      expect(full.stages.every((s) => s.mode === 'native')).toBe(true);
    } finally { evaluation.dispose(); }
  });
  it('queries physical slope halos across internal tile boundaries', async () => {
    const scene = project([node('warp', 'warp', { strength: 0.24 }), node('slope', 'mask', { mode: 'slope', low: 0.05, high: 0.9 })]);
    const world = definition(scene), evaluation = await prepareWorldEvaluation(scene, world);
    try {
      const full = await evaluation.sampleRegion(whole(world));
      for (const key of listWorldTiles(world)) {
        const region = worldTile(world, key).grid;
        expectCrop(full.heights, full.width, (await evaluation.sampleRegion(region)).heights, region);
      }
    } finally { evaluation.dispose(); }
  });
  it('uses a common integer numerator for exact export strips and signed ROI halos', async () => {
    const scene = project(), world = definition(scene), evaluation = await prepareWorldEvaluation(scene, world);
    try {
      const nx = 81, nz = 45;
      const full = await evaluation.sampleRegion({ ...whole(world), samplesX: nx, samplesZ: nz,
        outputCellsX: nx - 1, outputCellsZ: nz - 1 });
      for (let start = 0; start < nz; start += 7) {
        const count = Math.min(7, nz - start), startZ = start / (nz - 1) * world.domain.cellsZ;
        const span = (start + count - 1) / (nz - 1) * world.domain.cellsZ - startZ;
        const tile = await evaluation.sampleRegion({ startX: 0, startZ, cellsX: world.domain.cellsX, cellsZ: span,
          samplesX: nx, samplesZ: count, outputCellsX: nx - 1, outputCellsZ: nz - 1, outputSampleOffsetZ: start });
        expect(tile.heights).toEqual(full.heights.slice(start * nx, (start + count) * nx));
      }
      const halo = await evaluation.sampleRegion({ startX: 9, startZ: 9, cellsX: 4, cellsZ: 4, samplesX: 5, samplesZ: 5,
        outputCellsX: 2, outputCellsZ: 2, outputSampleOffsetX: -1, outputSampleOffsetZ: -1,
        outputOriginX: 10, outputOriginZ: 10, outputExtentX: 2, outputExtentZ: 2 });
      expect(halo.heights).toEqual((await evaluation.sampleRegion({ startX: 9, startZ: 9, cellsX: 4, cellsZ: 4, samplesX: 5, samplesZ: 5 })).heights);
    } finally { evaluation.dispose(); }
  });
  it('anchors meter-scale noise to Cartesian coordinates as the world moves', async () => {
    const scene = project(); Object.assign(scene.graph.nodes[0].params, { scaleMode: 'world', featureSize: 1200 });
    const world = definition(scene), before = await generateWorldRegion(scene, world, whole(world));
    const dx = world.domain.width / world.domain.cellsX;
    const moved = structuredClone(world); moved.domain.originX += dx;
    const after = await generateWorldRegion(scene, moved, whole(moved));
    let error = 0;
    for (let z = 0; z < before.height; z++) for (let x = 0; x < before.width - 1; x++)
      error = Math.max(error, Math.abs(after.heights[z * after.width + x] - before.heights[z * before.width + x + 1]));
    expect(error).toBeLessThan(1e-7);
  });
  it('keeps coincident unfiltered LOD samples identical and reports filtered spacing', async () => {
    const scene = project(), world = definition(scene);
    world.domain.cellsX = 64; world.domain.cellsZ = 64;
    const evaluation = await prepareWorldEvaluation(scene, world);
    try {
      const fine = await evaluation.sampleRegion(whole(world));
      const coarse = await evaluation.sampleRegion({ ...whole(world), samplesX: 33, samplesZ: 33 });
      for (let z = 0; z < 33; z++) for (let x = 0; x < 33; x++) expect(coarse.heights[z * 33 + x]).toBe(fine.heights[z * 2 * 65 + x * 2]);
      expect(coarse.spacingX).toBe(fine.spacingX * 2);
    } finally { evaluation.dispose(); }
  });
  it('periodizes the whole rectangular meter-space field, not each internal tile', async () => {
    const scene = project(); Object.assign(scene.graph.nodes[0].params, { scaleMode: 'world', featureSize: 750 });
    const world = definition(scene); world.domain.boundary = 'periodic';
    const output = await generateWorldRegion(scene, world, whole(world));
    for (let x = 0; x < output.width; x++) expect(output.heights[x]).toBe(output.heights[(output.height - 1) * output.width + x]);
    for (let z = 0; z < output.height; z++) expect(output.heights[z * output.width]).toBe(output.heights[z * output.width + output.width - 1]);
  });
  it('returns independent snapshots, rejects oversized allocation, and cancels atomically', async () => {
    const scene = project(), world = definition(scene), evaluation = await prepareWorldEvaluation(scene, world);
    try {
      const output = await evaluation.sampleRegion(whole(world)), baseline = output.heights.slice(); output.heights.fill(99);
      expect((await evaluation.sampleRegion(whole(world))).heights).toEqual(baseline);
      await expect(evaluation.sampleRegion({ ...whole(world), samplesX: 8192, samplesZ: 8192 })).rejects.toThrow(/128 MiB/);
      const controller = new AbortController();
      await expect(evaluation.sampleRegion(whole(world), { signal: controller.signal, onProgress: () => controller.abort() })).rejects.toThrow(/cancelled/);
      expect((await evaluation.sampleRegion(whole(world))).heights).toEqual(baseline);
    } finally { evaluation.dispose(); }
    await expect(evaluation.sampleRegion(whole(world))).rejects.toThrow(/disposed/);
  });
});

describe('global World context', () => {
  it('refuses unqualified rectangular global physics instead of stretching a square solve', async () => {
    const scene = project([node('thermal', 'thermal', { iterations: 2 })]), world = definition(scene);
    expect(describeWorldGraph(scene, world).capability.supported).toBe(false);
    await expect(prepareWorldEvaluation(scene, world)).rejects.toThrow(/square-domain/);
    scene.graph.nodes[1].bypassed = true;
    expect(describeWorldGraph(scene, world).capability.supported).toBe(true);
  });
  it('reuses one whole-domain erosion context and preserves exact tile borders', async () => {
    const scene = project([node('thermal', 'thermal', { iterations: 4, strength: 0.4, talus: 0.001 })]);
    const world = definition(scene); world.domain.depth = world.domain.width;
    const evaluation = await prepareWorldEvaluation(scene, world);
    try {
      const full = await evaluation.sampleRegion(whole(world));
      for (const key of listWorldTiles(world).reverse()) {
        const region = worldTile(world, key).grid;
        expectCrop(full.heights, full.width, (await evaluation.sampleRegion(region)).heights, region);
      }
      expect(full.stages.find((s) => s.nodeId === 'thermal')).toMatchObject({ mode: 'reconstructed', simulationResolution: 64, spacingX: 4000 / 63 });
      expect(full.stages.find((s) => s.nodeId === 'source')?.mode).toBe('native');
    } finally { evaluation.dispose(); }
  });
});
