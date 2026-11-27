import { describe, expect, it } from 'vitest';
import type { TerrainProject } from '../src/model/types';
import { DEFAULT_GENESIS, GENESIS_ALGORITHM_VERSION } from '../src/model/genesis';
import {
  createWorldDefinition,
  DEFAULT_WORLD_TRANSPORT,
  normalizeWorldDefinition,
  validateWorldDefinition,
} from '../src/model/world';
import { parseProject } from '../src/model/project';
import { serializeProjectFile } from '../src/model/projectStorage';
import {
  describeWorldGraph,
  generateWorldRegion,
  prepareWorldEvaluation,
} from '../src/engine/world';
import { GENESIS_CHANNELS } from '../src/engine/world/types';
import { worldEvaluationSignature } from '../src/engine/worldPreviewPlan';
import { createWorldRegionStore } from '../src/engine/worldStore';
import { MemoryWorldRegionStorage } from '../src/engine/worldStore/storage';
import type { StoredRegion } from '../src/engine/worldStore/storage';
import {
  regionArrays,
  regionBytes,
  regionChecksum,
  validRegion,
} from '../src/engine/worldStore/codec';
import { WorldPreviewSession } from '../src/engine/worldPreviewSession';
import type { WorldWorkerResponse } from '../src/hooks/worldProtocol';
import { checkWorldExportBudget } from '../src/export/worldExport';

function fixture() {
  const project: TerrainProject = {
    version: 1,
    name: 'Genesis integration',
    seed: 71,
    resolution: 64,
    worldSize: 4000,
    heightScale: 1200,
    presetId: 'custom',
    graph: {
      nodes: [
        {
          id: 'source',
          kind: 'noise',
          label: 'Native ridge source',
          position: { x: 0, y: 0 },
          params: {
            noiseModel: 'v3',
            kernel: 'perlin',
            fractal: 'ridged',
            octaves: 3,
            sampling: 'point',
          },
        },
        { id: 'output', kind: 'output', label: 'Terrain', position: { x: 240, y: 0 }, params: {} },
      ],
      edges: [{ id: 'source-output', source: 'source', target: 'output', targetHandle: 'in' }],
    },
  };
  const world = createWorldDefinition(project);
  world.domain = {
    ...world.domain,
    width: 4000,
    depth: 2500,
    cellsX: 128,
    cellsZ: 80,
    boundary: 'open',
  };
  world.globalResolution = 64;
  world.genesis = {
    ...DEFAULT_GENESIS,
    enabled: true,
    iterations: 2,
    durationYears: 4000,
    upliftMeters: 60,
  };
  const grid = { startX: 0, startZ: 0, cellsX: 128, cellsZ: 80, samplesX: 129, samplesZ: 81 };
  return { project, world, grid };
}

describe('World Genesis integration', () => {
  it('preserves legacy fields and signatures when Genesis is absent or disabled', async () => {
    const { project, world, grid } = fixture();
    const plain = { ...world, genesis: undefined };
    const disabled = { ...world, genesis: { ...world.genesis!, enabled: false } };
    const a = await generateWorldRegion(project, plain, grid);
    const b = await generateWorldRegion(project, disabled, grid);
    for (const key of ['heights', 'flow', 'wear', 'deposition'] as const)
      expect(b[key]).toEqual(a[key]);
    expect(b.genesis).toBeUndefined();
    expect(b.stages).toEqual(a.stages);
    expect(worldEvaluationSignature(project, plain)).toBe(
      worldEvaluationSignature(project, disabled),
    );
    expect(worldEvaluationSignature(project, world)).not.toBe(
      worldEvaluationSignature(project, plain),
    );
  });

  it('persists the explicit version and rejects malformed or future settings', () => {
    const { project, world } = fixture();
    const restored = parseProject(
      JSON.parse(serializeProjectFile({ ...project, version: 2, world })),
    );
    expect(restored.world?.genesis).toEqual(world.genesis);
    const owned = normalizeWorldDefinition(world, project);
    owned.genesis!.upliftMeters++;
    expect(owned.genesis).not.toEqual(world.genesis);
    expect(
      validateWorldDefinition({ ...world, genesis: { ...world.genesis, version: 2 } }),
    ).toMatch(/version/);
    expect(
      validateWorldDefinition({ ...world, genesis: { ...world.genesis, erosionRate: NaN } }),
    ).toMatch(/erosionRate/);
    expect(
      validateWorldDefinition({ ...world, genesis: { ...world.genesis, iterations: 1.5 } }),
    ).toMatch(/integer/);
  });

  it('shares one rectangular history across full fields, arbitrary crops and adjacent tile borders', async () => {
    const { project, world, grid } = fixture();
    const prepared = await prepareWorldEvaluation(project, world);
    try {
      const full = await prepared.sampleRegion(grid);
      const crop = await prepared.sampleRegion({
        startX: 32,
        startZ: 20,
        cellsX: 48,
        cellsZ: 30,
        samplesX: 49,
        samplesZ: 31,
      });
      for (let z = 0; z < crop.height; z++)
        for (let x = 0; x < crop.width; x++) {
          const a = z * crop.width + x,
            b = (z + 20) * full.width + x + 32;
          for (const key of ['heights', 'flow', 'wear', 'deposition'] as const)
            expect(crop[key][a]).toBe(full[key][b]);
          for (const key of GENESIS_CHANNELS)
            expect(crop.genesis![key][a]).toBe(full.genesis![key][b]);
        }
      const stage = full.stages.find((s) => s.nodeId === 'world-genesis')!;
      expect(stage).toMatchObject({
        algorithmVersion: GENESIS_ALGORITHM_VERSION,
        mode: 'reconstructed',
        samplesX: 64,
      });
      expect(stage.samplesZ).toBeLessThan(stage.samplesX);
      expect(stage.spacingX).toBeCloseTo(world.domain.width / (stage.samplesX - 1));
      expect(stage.spacingZ).toBeCloseTo(world.domain.depth / (stage.samplesZ - 1));
      expect(full.genesis!.report).toEqual(crop.genesis!.report);
      expect(prepared.genesisReport).toEqual(full.genesis!.report);
      expect(full.genesis!.incision.some((value) => value > 0)).toBe(true);
      expect(full.genesis!.drainageArea.every((value) => value > 0)).toBe(true);
      expect(full.genesis!.lithology.every((value) => Number.isInteger(value) && value <= 3)).toBe(
        true,
      );
      // A client is allowed to edit its result; no array or report may alias prepared state.
      full.genesis!.hardness.fill(-1);
      full.genesis!.report.limitations.length = 0;
      const repeat = await prepared.sampleRegion({
        startX: 32,
        startZ: 20,
        cellsX: 48,
        cellsZ: 30,
        samplesX: 49,
        samplesZ: 31,
      });
      expect(repeat.genesis).toEqual(crop.genesis);
    } finally {
      prepared.dispose();
    }
  });

  it('owns an immutable formation snapshot and ignores Genesis in intermediate fields', async () => {
    const { project, world, grid } = fixture();
    const plain = { ...world, genesis: undefined };
    const before = await generateWorldRegion(project, plain, grid, { previewNodeId: 'source' });
    const after = await generateWorldRegion(project, world, grid, { previewNodeId: 'source' });
    expect(after.heights).toEqual(before.heights);
    expect(after.genesis).toBeUndefined();
    expect(after.stages.some((stage) => stage.kind === 'world-genesis')).toBe(false);
    const prepared = await prepareWorldEvaluation(project, world);
    try {
      const first = await prepared.sampleRegion(grid);
      world.genesis!.upliftMeters += 300;
      project.seed++;
      const next = await prepared.sampleRegion(grid);
      expect(next.heights).toEqual(first.heights);
      expect(next.genesis).toEqual(first.genesis);
    } finally {
      prepared.dispose();
    }
  });

  it('keeps formation diagnostics upstream of optional conservative water transport', async () => {
    const { project, world, grid } = fixture();
    const formation = await generateWorldRegion(project, world, grid);
    world.transport = { ...DEFAULT_WORLD_TRANSPORT, enabled: true, iterations: 2, rainfall: 0.2 };
    const transported = await generateWorldRegion(project, world, grid);
    expect(transported.transportBudget).toBeDefined();
    for (const key of GENESIS_CHANNELS)
      expect(transported.genesis![key]).toEqual(formation.genesis![key]);
    expect(transported.stages.slice(-2).map((stage) => stage.kind)).toEqual([
      'world-genesis',
      'world-transport',
    ]);
  });

  it('rejects unsupported periodic worlds and excessive whole-domain allocations before solving', async () => {
    const { project, world, grid } = fixture();
    world.domain.boundary = 'periodic';
    expect(describeWorldGraph(project, world).capability.supported).toBe(false);
    await expect(generateWorldRegion(project, world, grid)).rejects.toThrow(/periodic/);
    world.domain.boundary = 'open';
    world.domain.depth = world.domain.width;
    world.globalResolution = 1024;
    expect(describeWorldGraph(project, world).capability).toMatchObject({ supported: false });
    expect(() =>
      checkWorldExportBudget({
        project,
        world,
        samplesX: 33,
        samplesZ: 33,
        format: 'raw32',
        profile: 'generic',
        sink: 'file',
        memoryBudgetBytes: 2048 * 1024 * 1024,
      }),
    ).toThrow(/128 MiB/);
    await expect(generateWorldRegion(project, world, grid)).rejects.toThrow(/128 MiB/);
  });

  it('cancels during formation and after the final diagnostic yield without publishing partial results', async () => {
    const { project, world, grid } = fixture();
    const controller = new AbortController();
    await expect(
      prepareWorldEvaluation(project, world, {
        signal: controller.signal,
        onProgressDetail: (progress) => {
          if (progress.nodeId === 'world-genesis') controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    const prepared = await prepareWorldEvaluation(project, world);
    try {
      const late = new AbortController();
      await expect(
        prepared.sampleRegion(grid, {
          signal: late.signal,
          onProgressDetail: (progress) => {
            if (progress.stage === 'Sampling geological fields' && progress.progress === 1)
              late.abort();
          },
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      const retried = await prepared.sampleRegion(grid);
      expect(retried.heights.every(Number.isFinite)).toBe(true);
    } finally {
      prepared.dispose();
    }
  });

  it('preflights disconnected mask preparation before admitting an export', () => {
    const { project, world } = fixture();
    world.genesis!.enabled = false;
    world.globalResolution = 1024;
    world.domain.depth = world.domain.width;
    project.graph.nodes.push(
      {
        id: 'mask-source',
        kind: 'mountain',
        label: 'Expensive mask source',
        params: { profile: 'orogenic' },
        position: { x: 0, y: 200 },
      },
      {
        id: 'mask',
        kind: 'mask',
        label: 'Mask branch',
        params: { mode: 'height' },
        position: { x: 200, y: 200 },
      },
    );
    project.graph.edges.push({ id: 'mask-edge', source: 'mask-source', target: 'mask' });
    expect(describeWorldGraph(project, world).capability.supported).toBe(true);
    expect(() =>
      checkWorldExportBudget({
        project,
        world,
        samplesX: 33,
        samplesZ: 33,
        format: 'raw32',
        profile: 'generic',
        sink: 'file',
        memoryBudgetBytes: 2048 * 1024 * 1024,
        masks: [{ nodeId: 'mask', name: 'expensive' }],
      }),
    ).toThrow(/Mask.*128 MiB/);
  });
});

class InspectableStorage extends MemoryWorldRegionStorage {
  corrupt(key: string, change: (record: StoredRegion) => void) {
    change(this.records.get(key)!);
  }
}

describe('Genesis ownership and cache contracts', () => {
  it('accounts for, hashes, clones and validates all formation fields and report metadata', async () => {
    const { project, world } = fixture();
    const result = await generateWorldRegion(project, world, {
      startX: 0,
      startZ: 0,
      cellsX: 128,
      cellsZ: 80,
      samplesX: 17,
      samplesZ: 11,
    });
    expect(validRegion(result)).toBe(true);
    const storage = new InspectableStorage();
    const store = await createWorldRegionStore({ storage });
    try {
      await store.put('genesis', result);
      const saved = (await store.get('genesis'))!;
      expect(regionBytes('genesis', result)).toBeGreaterThan(
        regionBytes('genesis', { ...result, genesis: undefined }) + 17 * 11 * 21,
      );
      expect(regionArrays(result)).toHaveLength(10);
      const checksum = regionChecksum(result);
      for (const broken of [
        { algorithmVersion: GENESIS_ALGORITHM_VERSION },
        { ...result.genesis!.report, levels: undefined },
        { ...result.genesis!.report, width: 0 },
        { ...result.genesis!.report, incisedVolumeM3: NaN },
      ]) {
        const malformed = structuredClone(result);
        Object.assign(malformed.genesis!, { report: broken });
        expect(validRegion(malformed)).toBe(false);
      }
      for (const key of GENESIS_CHANNELS) {
        const value = structuredClone(result);
        value.genesis![key][0] += key === 'lithology' ? 1 : 0.01;
        expect(regionChecksum(value)).not.toBe(checksum);
      }
      result.genesis!.hardness.fill(0);
      expect((await store.get('genesis'))!.genesis).toEqual(saved.genesis);
      const transferred = (await store.get('genesis'))!;
      structuredClone(transferred, {
        transfer: regionArrays(transferred).map((array) => array.buffer as ArrayBuffer),
      });
      expect((await store.get('genesis'))!.genesis).toEqual(saved.genesis);
      storage.corrupt('genesis', (record) => {
        record.result.genesis!.report.limitations.push('corrupt');
      });
      expect(await store.get('genesis')).toBeNull();
      saved.genesis!.drainageArea[0] = NaN;
      await store.put('invalid', saved);
      expect(store.stats().rejectedWrites).toBe(1);
    } finally {
      await store.close();
    }
  });

  it('transfers diagnostic ownership while retaining the prepared formation for later regions', async () => {
    const { project, world } = fixture();
    const session = new WorldPreviewSession();
    const results: Extract<WorldWorkerResponse, { type: 'result' }>[] = [];
    const errors: string[] = [];
    const request = {
      type: 'preview' as const,
      project,
      world,
      grid: { startX: 0, startZ: 0, cellsX: 128, cellsZ: 80, samplesX: 17, samplesZ: 11 },
    };
    const publish = (message: WorldWorkerResponse, transfer: Transferable[] = []) => {
      if (message.type === 'result') {
        expect(transfer).toHaveLength(10);
        results.push(structuredClone(message, { transfer }));
      } else if (message.type === 'error') errors.push(message.message);
    };
    try {
      await session.run({ ...request, id: 1 }, publish);
      await session.run({ ...request, id: 2 }, publish);
      expect(errors).toEqual([]);
      expect(results).toHaveLength(2);
      expect(results[1].preparedReused).toBe(true);
      expect(results[1].result.genesis).toEqual(results[0].result.genesis);
    } finally {
      session.dispose();
    }
  });
});
