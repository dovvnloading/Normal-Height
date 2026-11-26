import { describe, expect, it } from 'vitest';
import { createNode } from '../model/registry';
import type { TerrainProject } from '../model/types';
import { createWorldDefinition } from '../model/world';
import type { WorldExportOptions } from './worldExport';
import {
  planWorldExport,
  preflightWorldExport,
  worldExportSamplesZ,
  WORLD_DOWNLOAD_LIMIT_BYTES,
} from './worldExportPlan';

function options(): WorldExportOptions {
  const source = createNode('noise', { x: 0, y: 0 }, 'source');
  source.params = { ...source.params, noiseModel: 'v3' };
  const output = createNode('output', { x: 300, y: 0 }, 'out');
  const project: TerrainProject = {
    version: 1,
    name: 'Delivery plan',
    seed: 1,
    resolution: 64,
    worldSize: 8000,
    heightScale: 1000,
    presetId: 'custom',
    graph: {
      nodes: [source, output],
      edges: [{ id: 'height', source: source.id, target: output.id, targetHandle: 'in' }],
    },
  };
  const world = createWorldDefinition(project);
  world.globalResolution = 64;
  world.tileCells = 128;
  return { project, world, samplesX: 8192, samplesZ: 8192, format: 'raw32', profile: 'generic' };
}

describe('World delivery preflight', () => {
  it('calculates independent file and download budgets and proposes an executable smaller grid', () => {
    const request = options(),
      plan = planWorldExport(request);
    expect(plan.memory.error).not.toBeNull();
    expect(plan.file.error).toBeNull();
    expect(plan.memory.estimate!.archiveBytes).toBeGreaterThan(WORLD_DOWNLOAD_LIMIT_BYTES);
    expect(plan.file.estimate!.retainedArchiveBytes).toBe(0);
    expect(plan.memory.estimate!.peakBytes - plan.file.estimate!.peakBytes).toBe(
      plan.memory.estimate!.retainedArchiveBytes,
    );
    expect(plan.memory.smallerSamples).not.toBeNull();
    const smaller = plan.memory.smallerSamples!;
    expect(() =>
      preflightWorldExport({ ...request, samplesX: smaller, samplesZ: smaller, sink: 'memory' }),
    ).not.toThrow();
  });

  it('derives exact rectangular output spacing and footprint from a selected region', () => {
    const request = options();
    request.world.domain.depth = 4000;
    request.region = { startX: 256, startZ: 0, cellsX: 256, cellsZ: 512 };
    request.samplesX = 1024;
    request.samplesZ = worldExportSamplesZ(request, request.samplesX);
    const plan = planWorldExport(request);
    expect(plan.widthMeters).toBe(2000);
    expect(plan.depthMeters).toBe(2000);
    expect(request.samplesZ).toBe(1024);
    expect(plan.spacingX).toBe(2000 / 1023);
    expect(plan.spacingZ).toBe(2000 / 1023);
    expect(plan.files).toBe(plan.memory.estimate!.tileCount + 3);
  });

  it('retains engine sample-count contracts and reports actual anisotropic spacing', () => {
    const request = options();
    request.profile = 'unity';
    request.format = 'raw16';
    request.samplesX = 1025;
    request.world.domain.depth = 4000;
    request.samplesZ = worldExportSamplesZ(request, request.samplesX);
    expect(request.samplesZ).toBe(1025);
    const plan = planWorldExport(request);
    expect(plan.spacingX).toBe(8000 / 1024);
    expect(plan.spacingZ).toBe(4000 / 1024);
    expect(plan.memory.error).toBeNull();
    expect(() => preflightWorldExport({ ...request, format: 'raw32' })).toThrow(/Unity profile/);
  });

  it('does not offer a smaller grid for unsupported graphs or invalid masks', () => {
    const request = options();
    request.project.graph.nodes[0].kind = 'heightImport';
    const plan = planWorldExport(request);
    expect(plan.memory.error).not.toBeNull();
    expect(plan.file.error).not.toBeNull();
    expect(plan.memory.smallerSamples).toBeNull();
    expect(plan.file.smallerSamples).toBeNull();
    const maskRequest = options();
    maskRequest.samplesX = maskRequest.samplesZ = 256;
    maskRequest.masks = [{ nodeId: 'missing', name: 'Missing' }];
    expect(planWorldExport(maskRequest).memory.error).toMatch(/existing mask/);
  });

  it('explains reference-stage spacing independently of dense output sampling', () => {
    const request = options();
    request.project.graph.nodes[0].params.noiseModel = 'legacy';
    const plan = planWorldExport(request);
    expect(plan.referenceSpacing).toEqual([8000 / 63, 8000 / 63]);
    expect(plan.spacingX).toBeLessThan(1);
  });
});
