import { describe, expect, it } from 'vitest';
import { createWorldDefinition } from '../src/model/world';
import { encodeSamples, type HeightRaster } from '../src/model/heightRaster';
import type { TerrainNode, TerrainProject } from '../src/model/types';
import { COAST_DEFAULTS, shapeCoast } from '../src/engine/coast';
import { sampleImportedHeight } from '../src/engine/heightImport';
import {
  describeWorldGraph,
  generateWorldRegion,
  listWorldTiles,
  prepareWorldEvaluation,
  worldTile,
} from '../src/engine/world';
import type { WorldSampleGrid } from '../src/engine/world';

const node = (
  id: string,
  kind: TerrainNode['kind'],
  params: TerrainNode['params'] = {},
): TerrainNode => ({ id, kind, label: id, params, position: { x: 0, y: 0 } });

function raster(
  width: number,
  height: number,
  values: number[],
  format: HeightRaster['format'] = 'u16le',
): HeightRaster {
  const bytes = new Uint8Array(values.length * (format === 'f32le' ? 4 : 2));
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) =>
    format === 'f32le'
      ? view.setFloat32(index * 4, value, true)
      : view.setUint16(index * 2, value, true),
  );
  return { name: 'Survey', width, height, format, data: encodeSamples(bytes) };
}

function scene(source = raster(3, 2, [0, 12000, 24000, 30000, 42000, 54000])): TerrainProject {
  return {
    version: 1,
    name: 'World node parity',
    seed: 42,
    resolution: 65,
    worldSize: 1000,
    heightScale: 1000,
    presetId: 'test',
    graph: {
      nodes: [{ ...node('source', 'heightImport'), raster: source }, node('out', 'output')],
      edges: [{ id: 'height', source: 'source', target: 'out' }],
    },
  };
}

function definition(project: TerrainProject) {
  const world = createWorldDefinition(project);
  Object.assign(world.domain, {
    cellsX: 67,
    cellsZ: 39,
    depth: 1600,
    originX: -1800,
    originZ: 970,
  });
  world.globalResolution = 65;
  world.tileCells = 32;
  return world;
}

const whole = (world: ReturnType<typeof definition>): WorldSampleGrid => ({
  startX: 0,
  startZ: 0,
  cellsX: world.domain.cellsX,
  cellsZ: world.domain.cellsZ,
  samplesX: world.domain.cellsX + 1,
  samplesZ: world.domain.cellsZ + 1,
});

function addCoast(project: TerrainProject, params: TerrainNode['params'] = {}) {
  project.graph.nodes.splice(1, 0, node('coast', 'coast', { seaLevel: 0.5, ...params }));
  project.graph.edges = [
    { id: 'to-coast', source: 'source', target: 'coast' },
    { id: 'to-output', source: 'coast', target: 'out' },
  ];
  for (const channel of ['shore', 'water']) {
    project.graph.nodes.push(node(channel, 'maskOutput'));
    project.graph.edges.push({
      id: `to-${channel}`,
      source: 'coast',
      sourceHandle: channel,
      target: channel,
    });
  }
}

async function assertStitches(
  project: TerrainProject,
  world: ReturnType<typeof definition>,
  previewNodeId?: string,
) {
  const prepared = await prepareWorldEvaluation(project, world, { previewNodeId });
  try {
    const full = await prepared.sampleRegion(whole(world));
    for (const key of listWorldTiles(world).reverse()) {
      const grid = worldTile(world, key).grid;
      const tile = await prepared.sampleRegion(grid);
      for (let z = 0; z < grid.samplesZ; z++)
        for (let x = 0; x < grid.samplesX; x++)
          expect(tile.heights[z * tile.width + x]).toBe(
            full.heights[(grid.startZ + z) * full.width + grid.startX + x],
          );
    }
    return full;
  } finally {
    prepared.dispose();
  }
}

describe('World original-raster sources', () => {
  it('samples a rectangular survey in physical coordinates and stitches partial tiles exactly', async () => {
    const project = scene();
    project.graph.nodes[0].params = { gain: 1.4, offsetMeters: 10 };
    const world = definition(project);
    const full = await assertStitches(project, world);
    for (let z = 0; z < full.height; z++)
      for (let x = 0; x < full.width; x++) {
        const raw = (24000 * x) / (full.width - 1) + (30000 * z) / (full.height - 1);
        expect(full.heights[z * full.width + x]).toBeCloseTo((raw * 1.4) / 65535 + 0.01, 6);
      }
    expect(full.stages.every((stage) => stage.mode === 'native')).toBe(true);
  });

  it('preserves float-meter gain, offset, north/south orientation and rectangular aspect', async () => {
    const values = Array.from(
      { length: 12 },
      (_, i) => -250 + (i % 4) * 30 + Math.floor(i / 4) * 70,
    );
    const project = scene(raster(4, 3, values, 'f32le'));
    project.graph.nodes[0].params = { gain: 0.7, offsetMeters: -20, flipY: true };
    const world = definition(project);
    world.domain.datum = 75;
    const full = await generateWorldRegion(project, world, whole(world));
    for (let z = 0; z < full.height; z++)
      for (let x = 0; x < full.width; x++) {
        const meters = -250 + (90 * x) / (full.width - 1) + 140 * (1 - z / (full.height - 1));
        // The graph stores height relative to the world datum, which exporters
        // apply once. Import gain/offset have the same meaning as Terrain.
        expect(full.heights[z * full.width + x]).toBeCloseTo((meters * 0.7 - 20) / 1000, 7);
      }
  });

  it('owns an immutable decoded snapshot and rejects missing, malformed and over-budget imports', async () => {
    const project = scene();
    const world = definition(project);
    const prepared = await prepareWorldEvaluation(project, world);
    const before = await prepared.sampleRegion(whole(world));
    project.graph.nodes[0].params.gain = 0;
    project.graph.nodes[0].raster = raster(2, 2, [65535, 65535, 65535, 65535]);
    expect((await prepared.sampleRegion(whole(world))).heights).toEqual(before.heights);
    prepared.dispose();
    delete project.graph.nodes[0].raster;
    await expect(prepareWorldEvaluation(project, world)).rejects.toThrow(/Choose a heightmap/);
    project.graph.nodes[0].raster = { ...raster(2, 2, [0, 0, 0, 0]), data: 'invalid' };
    await expect(prepareWorldEvaluation(project, world)).rejects.toThrow(/length/);
    const oversized = {
      name: 'large',
      width: 2048,
      height: 2048,
      format: 'f32le',
      data: '',
    } as const;
    project.graph.nodes = [
      { ...node('a', 'heightImport'), raster: oversized },
      { ...node('b', 'heightImport'), raster: oversized },
      node('blend', 'blend'),
      node('out', 'output'),
    ];
    project.graph.edges = [
      { id: 'a', source: 'a', target: 'blend', targetHandle: 'a' },
      { id: 'b', source: 'b', target: 'blend', targetHandle: 'b' },
      { id: 'out', source: 'blend', target: 'out' },
    ];
    await expect(prepareWorldEvaluation(project, world)).rejects.toThrow(/16 MiB/);
  });

  it('does not silently interpret unequal survey borders as a periodic world', () => {
    const project = scene(),
      world = definition(project);
    world.domain.boundary = 'periodic';
    expect(describeWorldGraph(project, world).capability.reason).toMatch(/opposite borders/);
    expect(describeWorldGraph(project, world).capability.supported).toBe(false);
  });
});

describe('World coastal and named-mask parity', () => {
  it('matches the shared physical coast solver at reference samples, including rectangular distance', async () => {
    const project = scene(raster(2, 2, [0, 0, 65535, 65535]));
    const params = { strength: 1, beachWidth: 180, shelfWidth: 300, beachSlope: 6, shelfSlope: 3 };
    addCoast(project, params);
    const world = definition(project);
    world.domain.cellsX = world.domain.cellsZ = 64;
    const input = sampleImportedHeight(project.graph.nodes[0], 65, world.domain.heightScale);
    const oracle = shapeCoast(input, 65, {
      ...COAST_DEFAULTS,
      ...params,
      seaLevel: 0.5,
      worldSize: world.domain.width,
      worldDepth: world.domain.depth,
      heightScale: world.domain.heightScale,
    });
    for (const [target, values] of [
      [undefined, oracle.height],
      ['shore', oracle.shore],
      ['water', oracle.water],
    ] as const) {
      const actual = await generateWorldRegion(project, world, whole(world), {
        previewNodeId: target,
      });
      let maximumError = 0;
      actual.heights.forEach((value, i) => {
        maximumError = Math.max(maximumError, Math.abs(value - values[i]));
      });
      expect(maximumError).toBeLessThan(1e-6);
    }
    const report = describeWorldGraph(project, world);
    expect(report.capability.supported).toBe(true);
    expect(report.capability.native).toBe(false);
    expect(report.stages.find((stage) => stage.kind === 'coast')?.reason).toMatch(/65 × 65/);
    expect(report.capability.warnings.join(' ')).toMatch(/Narrow channels/);
  });

  it('keeps inland lakes disconnected from ocean across internal tile edges and exports fixed masks', async () => {
    const values = Array.from({ length: 65 * 65 }, (_, i) => {
      const x = i % 65,
        z = Math.floor(i / 65);
      return x < 12 || (x >= 28 && x <= 44 && z >= 20 && z <= 44) ? 100 : 900;
    });
    const project = scene(raster(65, 65, values, 'f32le'));
    addCoast(project);
    const world = definition(project);
    world.domain.cellsX = world.domain.cellsZ = 128;
    const terrain = await assertStitches(project, world);
    const shore = await assertStitches(project, world, 'shore');
    const water = await assertStitches(project, world, 'water');
    const lake = 64 * water.width + 64;
    expect(terrain.heights[lake]).toBe(Math.fround(0.1));
    expect(shore.heights[lake]).toBe(0);
    expect(water.heights[lake]).toBe(0);
    expect(water.heights[64 * water.width + 8]).toBe(1);
    expect(water.heights.every((value) => value === 0 || value === 1)).toBe(true);
    expect(shore.heights.every((value) => value >= 0 && value <= 1)).toBe(true);
    expect(water.flow.every((value) => value === 0)).toBe(true);
    project.graph.nodes.find((value) => value.id === 'coast')!.params.includeLakes = true;
    const included = await generateWorldRegion(project, world, whole(world), {
      previewNodeId: 'water',
    });
    expect(included.heights[lake]).toBe(1);
  });

  it('preserves source elevations at zero coastal strength and zeros coastal ports on bypass', async () => {
    const project = scene(raster(2, 2, [0, 65535, 0, 65535]));
    const world = definition(project);
    const original = await generateWorldRegion(project, world, whole(world));
    addCoast(project, { strength: 0 });
    const untouched = await generateWorldRegion(project, world, whole(world));
    expect(untouched.heights).toEqual(original.heights);
    const mask = await generateWorldRegion(project, world, whole(world), {
      previewNodeId: 'shore',
    });
    expect(mask.heights.some((value) => value > 0)).toBe(true);
    project.graph.nodes.find((value) => value.kind === 'coast')!.bypassed = true;
    for (const previewNodeId of ['shore', 'water']) {
      const result = await generateWorldRegion(project, world, whole(world), { previewNodeId });
      expect(result.heights.every((value) => value === 0)).toBe(true);
    }
    expect((await generateWorldRegion(project, world, whole(world))).heights).toEqual(
      original.heights,
    );
  });

  it('always clamps named outputs, even when bypassed, without per-tile normalization', async () => {
    const project = scene(raster(2, 2, [-500, 1500, -500, 1500], 'f32le'));
    const output = node('mask', 'maskOutput');
    output.bypassed = true;
    project.graph.nodes.push(output);
    project.graph.edges.push({ id: 'mask', source: 'source', target: 'mask' });
    const world = definition(project);
    const result = await assertStitches(project, world, 'mask');
    for (let x = 0; x < result.width; x++)
      expect(result.heights[x]).toBeCloseTo(
        Math.max(0, Math.min(1, -0.5 + (2 * x) / (result.width - 1))),
        7,
      );
    expect(result.flow.every((value) => value === 0)).toBe(true);
    expect(result.wear.every((value) => value === 0)).toBe(true);
    expect(result.deposition.every((value) => value === 0)).toBe(true);
  });
});
