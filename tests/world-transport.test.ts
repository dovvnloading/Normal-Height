import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD_TRANSPORT, createWorldDefinition } from '../src/model/world';
import { routeWorldDrainage, simulateWorldTransport } from '../src/engine/world/hydrology';
import type { TransportGrid } from '../src/engine/world/hydrology';
import { generateWorldRegion, prepareWorldEvaluation } from '../src/engine/world';
import type { TerrainProject } from '../src/model/types';

const grid: TransportGrid = {
  width: 17,
  height: 11,
  widthMeters: 160,
  depthMeters: 100,
  boundary: 'closed',
};
const terrain = () =>
  Float64Array.from({ length: grid.width * grid.height }, (_, i) => {
    const x = i % grid.width,
      z = Math.floor(i / grid.width);
    return 40 + (grid.height - z) * 1.2 + Math.abs(x - 8) * 0.8 + Math.sin(x * 0.7 + z * 0.5) * 0.1;
  });
const settings = {
  ...DEFAULT_WORLD_TRANSPORT,
  enabled: true,
  iterations: 16,
  rainfall: 0.3,
  conductivity: 2,
  thermal: 0.1,
  talusDegrees: 5,
};

describe('globally coupled World reference', () => {
  it('routes a cross-tile valley to true boundary outlets without interior sinks', () => {
    const open = { ...grid, boundary: 'open' as const },
      drainage = routeWorldDrainage(terrain(), open);
    for (let z = 1; z < grid.height - 1; z++)
      for (let x = 1; x < grid.width - 1; x++) {
        let i = z * grid.width + x,
          hops = 0;
        expect(drainage.receiver[i]).toBeGreaterThanOrEqual(0);
        while (drainage.receiver[i] >= 0 && hops++ < grid.width * grid.height)
          i = drainage.receiver[i];
        expect(hops).toBeLessThan(grid.width * grid.height);
        const xx = i % grid.width,
          zz = Math.floor(i / grid.width);
        expect(xx === 0 || zz === 0 || xx === grid.width - 1 || zz === grid.height - 1).toBe(true);
      }
    let total = 0;
    for (let i = 0; i < drainage.receiver.length; i++)
      if (drainage.receiver[i] < 0) total += drainage.contributingAreaM2[i];
    expect(total).toBeCloseTo(grid.widthMeters * grid.depthMeters, 8);
  });
  it('keeps a closed basin closed and computes one deterministic global catchment', () => {
    const heights = terrain();
    heights[5 * grid.width + 8] = -10;
    const drainage = routeWorldDrainage(heights, grid),
      sink = drainage.receiver.findIndex((index) => index < 0);
    expect(sink).toBe(5 * grid.width + 8);
    expect(drainage.outletCount).toBe(1);
    expect(drainage.contributingAreaM2[sink]).toBeCloseTo(grid.widthMeters * grid.depthMeters, 8);
    expect(routeWorldDrainage(heights, grid)).toEqual(drainage);
  });
  it('exchanges shared faces identically under reversed tile order and different partitions', async () => {
    const original = terrain(),
      before = original.slice();
    const a = await simulateWorldTransport(original, grid, settings, { tileCells: 4 });
    const b = await simulateWorldTransport(original, grid, settings, {
      tileCells: 4,
      tileOrder: 'reverse',
    });
    const whole = await simulateWorldTransport(original, grid, settings, { tileCells: 64 });
    expect(original).toEqual(before);
    for (const key of [
      'height',
      'flow',
      'waterDepth',
      'suspendedSediment',
      'wear',
      'deposition',
    ] as const) {
      expect(a[key]).toEqual(b[key]);
      expect(a[key]).toEqual(whole[key]);
    }
    expect(a.budget.sharedFaceWaterVolumeM3).toBeGreaterThan(0);
    expect(a.budget.exportedWaterVolumeM3).toBe(0);
    expect(a.budget.exportedSedimentVolumeM3).toBe(0);
    expect(Math.abs(a.budget.waterResidualM3)).toBeLessThan(a.budget.rainfallVolumeM3 * 1e-12);
    expect(Math.abs(a.budget.solidResidualM3)).toBeLessThan(1e-7);
  });
  it('accounts for true boundary export and evaporation without losing suspended solids', async () => {
    const result = await simulateWorldTransport(
      terrain(),
      { ...grid, boundary: 'open' },
      settings,
      { tileCells: 3 },
    );
    expect(result.budget.exportedWaterVolumeM3).toBeGreaterThan(0);
    expect(result.budget.exportedSedimentVolumeM3).toBeGreaterThan(0);
    expect(result.budget.erodedVolumeM3).toBeGreaterThan(0);
    expect(result.budget.evaporationVolumeM3).toBeGreaterThan(0);
    expect(Math.abs(result.budget.waterResidualM3)).toBeLessThan(
      result.budget.rainfallVolumeM3 * 1e-12,
    );
    expect(Math.abs(result.budget.solidResidualM3)).toBeLessThan(1e-7);
    expect(result.waterDepth.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
    expect(result.suspendedSediment.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
  });
  it('has exact zero-effect identity and respects finite bedrock cover', async () => {
    const original = terrain();
    const dry = await simulateWorldTransport(original, grid, {
      ...settings,
      rainfall: 0,
      erosion: 0,
      thermal: 0,
    });
    expect(dry.height).toEqual(original);
    expect(dry.budget.waterResidualM3).toBe(0);
    expect(dry.budget.solidResidualM3).toBe(0);
    const rock = await simulateWorldTransport(original, grid, { ...settings, soilDepth: 0 });
    expect(rock.height).toEqual(original);
    expect(rock.budget.erodedVolumeM3).toBe(0);
    expect(rock.budget.thermalMovedVolumeM3).toBe(0);
  });
  it('cancels at iteration barriers without mutating authored fields', async () => {
    const original = terrain(),
      before = original.slice(),
      controller = new AbortController();
    await expect(
      simulateWorldTransport(original, grid, settings, {
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    ).rejects.toThrow(/cancelled/);
    expect(original).toEqual(before);
  });
});

describe('transport in World graph builds', () => {
  const scene: TerrainProject = {
    version: 1,
    name: 'Transport graph',
    seed: 61,
    resolution: 64,
    worldSize: 4000,
    heightScale: 1600,
    presetId: 'test',
    graph: {
      nodes: [
        {
          id: 'noise',
          kind: 'noise',
          label: 'Ridges',
          params: {
            noiseModel: 'v3',
            kernel: 'perlin',
            fractal: 'ridged',
            octaves: 2,
            sampling: 'point',
          },
          position: { x: 0, y: 0 },
        },
        { id: 'out', kind: 'output', label: 'Terrain', params: {}, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: 'edge', source: 'noise', target: 'out' }],
    },
  };
  it('reconstructs one rectangular simulation with exact region/whole output identity', async () => {
    const world = createWorldDefinition(scene);
    world.domain.depth = 2500;
    world.domain.cellsX = 64;
    world.domain.cellsZ = 40;
    world.globalResolution = 64;
    world.transport = { ...DEFAULT_WORLD_TRANSPORT, enabled: true, iterations: 3 };
    const full = await generateWorldRegion(scene, world, {
      startX: 0,
      startZ: 0,
      cellsX: 64,
      cellsZ: 40,
      samplesX: 65,
      samplesZ: 41,
    });
    const roi = await generateWorldRegion(scene, world, {
      startX: 32,
      startZ: 10,
      cellsX: 20,
      cellsZ: 20,
      samplesX: 21,
      samplesZ: 21,
    });
    for (let z = 0; z < 21; z++)
      for (let x = 0; x < 21; x++) {
        expect(roi.heights[z * 21 + x]).toBe(full.heights[(z + 10) * 65 + x + 32]);
        expect(roi.flow[z * 21 + x]).toBe(full.flow[(z + 10) * 65 + x + 32]);
      }
    expect(full.transportBudget).toEqual(roi.transportBudget);
    expect(full.stages.at(-1)).toMatchObject({
      nodeId: 'world-transport',
      mode: 'reconstructed',
      simulationResolution: 64,
      spacingX: 4000 / 63,
      spacingZ: 2500 / 63,
    });
    expect(Math.abs(full.transportBudget!.solidResidualM3)).toBeLessThan(1e-4);
  });
  it('retains exact source output when optional transport has zero effect', async () => {
    const world = createWorldDefinition(scene);
    world.globalResolution = 64;
    const region = { startX: 0, startZ: 0, cellsX: 1024, cellsZ: 1024, samplesX: 33, samplesZ: 33 };
    const before = await generateWorldRegion(scene, world, region);
    world.transport = {
      ...DEFAULT_WORLD_TRANSPORT,
      enabled: true,
      iterations: 1,
      rainfall: 0,
      erosion: 0,
      thermal: 0,
    };
    const after = await generateWorldRegion(scene, world, region);
    expect(after.heights).toEqual(before.heights);
    world.domain.boundary = 'periodic';
    await expect(generateWorldRegion(scene, world, region)).rejects.toThrow(/periodic/);
  });
  it('rejects cancellation at the final reconstruction barrier and remains reusable', async () => {
    const world = createWorldDefinition(scene);
    world.globalResolution = 64;
    world.transport = { ...DEFAULT_WORLD_TRANSPORT, enabled: true, iterations: 1 };
    const evaluation = await prepareWorldEvaluation(scene, world),
      controller = new AbortController(),
      region = { startX: 0, startZ: 0, cellsX: 1024, cellsZ: 1024, samplesX: 17, samplesZ: 17 };
    try {
      await expect(
        evaluation.sampleRegion(region, {
          signal: controller.signal,
          onProgress: (progress) => {
            if (progress === 1) controller.abort();
          },
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      const recovered = await evaluation.sampleRegion(region);
      expect(recovered.heights).toHaveLength(region.samplesX * region.samplesZ);
      expect(recovered.heights.every(Number.isFinite)).toBe(true);
    } finally {
      evaluation.dispose();
    }
  });
  it('leaves scalar/intermediate previews before the post-graph transport stage', async () => {
    const world = createWorldDefinition(scene);
    world.globalResolution = 64;
    const region = { startX: 0, startZ: 0, cellsX: 1024, cellsZ: 1024, samplesX: 17, samplesZ: 17 };
    const before = await generateWorldRegion(scene, world, region, { previewNodeId: 'noise' });
    world.transport = { ...DEFAULT_WORLD_TRANSPORT, enabled: true, iterations: 1 };
    const after = await generateWorldRegion(scene, world, region, { previewNodeId: 'noise' });
    expect(after.heights).toEqual(before.heights);
    expect(after.transportBudget).toBeUndefined();
    expect(after.stages.some((stage) => stage.nodeId === 'world-transport')).toBe(false);
  });
});
