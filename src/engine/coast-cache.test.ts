import { describe, expect, it } from 'vitest';
import { evaluateGraph } from './index';
import { GraphFieldCache } from './compute/cache';
import { semanticProjectSignature } from './plan/graph';
import { describeWorldGraph } from './world';
import { createWorldDefinition } from '../model/world';
import { encodeSamples, type HeightRaster } from '../model/heightRaster';
import type { TerrainNode, TerrainProject } from '../model/types';

function source(samples: number[]): HeightRaster {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, i) => view.setUint16(i * 2, sample, true));
  return { name: 'grid.r16', width: 2, height: 2, format: 'u16le', data: encodeSamples(bytes) };
}

function scene(): TerrainProject {
  const node = (id: string, kind: TerrainNode['kind'], params: TerrainNode['params'] = {}): TerrainNode =>
    ({ id, label: id, kind, params, position: { x: 0, y: 0 } });
  return {
    version: 1, name: 'Coastal cache integration', presetId: 'test',
    seed: 42, resolution: 32, worldSize: 1000, heightScale: 500,
    graph: {
      nodes: [
        { ...node('import', 'heightImport'), raster: source([0, 65535, 0, 65535]) },
        node('coast', 'coast', { seaLevel: 0.5 }),
        node('out', 'output'),
        node('shore', 'maskOutput'),
        node('water', 'maskOutput'),
      ],
      edges: [
        { id: 'a', source: 'import', target: 'coast' },
        { id: 'b', source: 'coast', target: 'out' },
        { id: 'c', source: 'coast', sourceHandle: 'shore', target: 'shore' },
        { id: 'd', source: 'coast', sourceHandle: 'water', target: 'water' },
      ],
    },
  };
}
const run = (project: TerrainProject, cache?: GraphFieldCache, previewNodeId?: string) =>
  evaluateGraph(project, { resolution: project.resolution, previewNodeId }, cache);

describe('coastal stages with persistent graph compute', () => {
  it('retains both fixed-range coastal ports across warm-cache previews', () => {
    const project = scene();
    const cache = new GraphFieldCache();
    run(project, cache);
    for (const port of ['shore', 'water']) {
      const expected = run(project, undefined, port);
      expect(expected.field.height.some((v) => v > 0)).toBe(true);
      const cached = run(project, cache, port);
      expect(cached.field.height).toEqual(expected.field.height);
      expect(cached.diagnostics?.nodes.find((n) => n.nodeId === 'coast')?.status).toBe('hit');
    }
    expect(cache.bytes).toBeGreaterThanOrEqual(3 * 32 * 32 * 4);
    project.graph.nodes[1].bypassed = true;
    expect(run(project, cache, 'water').field.height.every((v) => v === 0)).toBe(true);
  });

  it('invalidates terrain and dependent masks when the imported raster changes', () => {
    const project = scene();
    const cache = new GraphFieldCache();
    const previousSignature = semanticProjectSignature(project);
    const previous = run(project, cache, 'water');
    project.graph.nodes[0] = { ...project.graph.nodes[0], raster: source([65535, 65535, 65535, 65535]) };
    expect(semanticProjectSignature(project)).not.toBe(previousSignature);
    const result = run(project, cache, 'water');
    expect(result.field.height).not.toEqual(previous.field.height);
    expect(result.field.height).toEqual(run(project, undefined, 'water').field.height);
    expect(result.diagnostics?.cacheHits).toBe(0);
  });

  it('reports the new single-domain stages as unsupported by World tiles before evaluating', () => {
    const project = scene();
    const { capability } = describeWorldGraph(project, createWorldDefinition(project));
    expect(capability.supported).toBe(false);
    expect(capability.reason).toMatch(/single-domain Terrain workspace/);
  });
});
