import { describe, expect, it } from 'vitest';
import { evaluateGraph, Noise } from '../src/engine';
import { clamp } from '../src/engine/noise';
import { createNode } from '../src/model/registry';
import { createProject } from '../src/model/presets';

describe('domain warp tile coordinates', () => {
  it('samples the same physical displacement at matching working/export coordinates', () => {
    const project = createProject();
    const source = createNode('noise', { x: 0, y: 0 }, 'source');
    // A known smooth analytic source, tilted in both x and y so the test
    // observes both components of the displacement. No fractal phase warp.
    source.params = {
      ...source.params, mode: 'wave', scale: 0.25, rotation: 30, stretch: 1,
      warp: 0, amplitude: 0.5, offset: 0.1,
    };
    const warp = createNode('warp', { x: 200, y: 0 }, 'warp');
    warp.params = { ...warp.params, scale: 12, strength: 1.3, octaves: 3, seed: 37 };
    const output = createNode('output', { x: 400, y: 0 }, 'out');
    project.graph = {
      nodes: [source, warp, output],
      edges: [
        { id: 'source-warp', source: 'source', target: 'warp' },
        { id: 'warp-out', source: 'warp', target: 'out' },
      ],
    };
    const noise = new Noise((project.seed + 37) >>> 0);
    const angle = Math.PI / 6;
    const expected = (x: number, y: number) => {
      const u = x * 12, v = y * 12;
      const sx = clamp(x + noise.fractal(u + 12.7, v + 1.9, 3) * 1.3 * 0.16);
      const sy = clamp(y + noise.fractal(u + 2.3, v + 41.9, 3) * 1.3 * 0.16);
      const phase = ((sx - 0.5) * Math.cos(angle) - (sy - 0.5) * Math.sin(angle))
        * 0.25 + 17.319;
      return 0.1 + 0.5 * (Math.sin(phase * Math.PI * 2) + 1) * 0.5;
    };
    // Nested endpoint-inclusive grids have exactly matching world samples.
    // Only interpolation of the smooth input can introduce a small error.
    const points = [0, 0.25, 0.5, 0.75, 1];
    for (const n of [129, 513, 1025]) {
      const result = evaluateGraph(project, { resolution: n }).field.height;
      for (const y of points) for (const x of points) {
        const actual = result[y * (n - 1) * n + x * (n - 1)];
        expect(Math.abs(actual - expected(x, y))).toBeLessThan(0.00002);
      }
    }
    warp.params.strength = 0;
    const unwarped = evaluateGraph(project, { resolution: 33, previewNodeId: source.id });
    expect(evaluateGraph(project, { resolution: 33 }).field.height).toEqual(unwarped.field.height);
  });
});
