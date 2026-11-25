import { describe, expect, it } from 'vitest';
import { Noise } from './noise';
import { evaluateGraph } from './index';
import { createNode, noiseParamVisible } from '../model/registry';
import { createProject } from '../model/presets';
import { parseProject } from '../model/project';

describe('versioned procedural noise', () => {
  it('bounds corrected Perlin and avoids clipping across dense seeded grids', () => {
    let oldOvershoots = 0;
    for (const seed of [1, 42, 48271]) {
      const noise = new Noise(seed, 'v2');
      const legacy = new Noise(seed, 'legacy');
      let minimum = Infinity, maximum = -Infinity;
      for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
        const u = 17.319 + (x / 127 - 0.5) * 24;
        const v = 8.173 + (y / 127 - 0.5) * 24;
        const sample = noise.perlin(u, v);
        if (Math.abs(legacy.perlin(u, v)) > 1) oldOvershoots++;
        minimum = Math.min(minimum, sample);
        maximum = Math.max(maximum, sample);
        if (Math.abs(sample) > 1) throw new Error('Corrected Perlin exceeded unit range');
      }
      expect(minimum).toBeLessThan(-0.4);
      expect(maximum).toBeGreaterThan(0.4);
    }
    expect(oldOvershoots).toBeGreaterThan(0);
  });

  it('uses every Wave fractal control in corrected sampling but preserves legacy Wave', () => {
    const modern = new Noise(42, 'v2'), legacy = new Noise(42, 'legacy');
    const sample = (noise: Noise, octaves: number, persistence: number, lacunarity: number, warp = 0.6) =>
      noise.sample('wave', 1.23, 2.345, octaves, persistence, lacunarity, warp);
    const base = sample(modern, 6, 0.5, 2.05);
    expect(Math.abs(sample(modern, 1, 0.5, 2.05) - base)).toBeGreaterThan(0.0001);
    expect(Math.abs(sample(modern, 6, 0.8, 2.05) - base)).toBeGreaterThan(0.0001);
    expect(Math.abs(sample(modern, 6, 0.5, 3.5) - base)).toBeGreaterThan(0.0001);
    expect(sample(legacy, 1, 0.2, 1.4)).toBe(sample(legacy, 10, 0.85, 3.5));
    expect(sample(modern, 1, 0.2, 1.4, 0)).toBeCloseTo(
      (Math.sin(1.23 * Math.PI * 2) + 1) * 0.5, 12);
  });

  it('makes Naki zero warp an exact unwarped lobe field with continuous displacement', () => {
    const noise = new Noise(42, 'v2'), legacy = new Noise(42, 'legacy');
    const x = 1.23, y = 2.345, octaves = 6, persistence = 0.5, lacunarity = 2.05;
    const expected = (n: Noise, u: number, v: number) => 0.5 + 0.5 * Math.sin(
      n.simplex(u, v) * 3.5 +
      n.fractal(u * 1.7, v * 1.7, octaves, persistence, lacunarity) * 2);
    const sample = (n: Noise, warp: number) =>
      n.sample('naki', x, y, octaves, persistence, lacunarity, warp);
    expect(sample(noise, 0)).toBeCloseTo(expected(noise, x, y), 12);
    expect(Math.abs(sample(noise, 0.000001) - sample(noise, 0))).toBeLessThan(0.0001);
    expect(Math.abs(sample(noise, 0.6) - sample(noise, 0))).toBeGreaterThan(0.0001);
    expect(sample(legacy, 0)).toBeCloseTo(expected(legacy,
      x + legacy.simplex(x * 0.55 + 11.4, y * 0.55) * 0.4,
      y + legacy.value(x * 0.8, y * 0.8 + 5.7) * 0.4), 12);
  });

  it('compresses strong turbulence and Voronoi ridges without flat maximum plateaus', () => {
    for (const family of ['turbulence', 'voronoi-edge']) {
      let legacyClipped = 0;
      for (const seed of [1, 42, 48271]) for (const frequency of [3.4, 12]) {
        const modern = new Noise(seed, 'v2'), legacy = new Noise(seed, 'legacy');
        let min = Infinity, max = -Infinity, difference = 0;
        for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
          const u = (x / 127 - 0.5) * frequency + 17.319;
          const v = (y / 127 - 0.5) * frequency + 8.173;
          const sample = modern.sample(family, u, v, 1, 0.5, 2.05, 0.6);
          if (legacy.sample(family, u, v, 1, 0.5, 2.05, 0.6) === 1) legacyClipped++;
          min = Math.min(min, sample);
          max = Math.max(max, sample);
          difference += Math.abs(sample - modern.sample('ridged', u, v, 1, 0.5, 2.05, 0.6));
        }
        expect(min).toBeGreaterThanOrEqual(0);
        expect(max).toBeLessThan(1);
        expect(max - min).toBeGreaterThan(0.3);
        expect(difference / (128 * 128)).toBeGreaterThan(0.04);
      }
      expect(legacyClipped).toBeGreaterThan(0);
    }
  });

  it('migrates unversioned saved nodes to legacy without changing their field', () => {
    const project = createProject();
    const source = createNode('noise', { x: 0, y: 0 }, 'source');
    const output = createNode('output', { x: 200, y: 0 }, 'out');
    // This test exercises the preserved v2 implementation, not new-node defaults.
    source.params.noiseModel = 'v2';
    source.params.mode = 'wave';
    project.graph = {
      nodes: [source, output],
      edges: [{ id: 'e', source: 'source', target: 'out', sourceHandle: 'height', targetHandle: 'in' }],
    };
    expect(source.params.noiseModel).toBe('v2');
    const corrected = evaluateGraph(project, { resolution: 64 }).field.height;
    delete source.params.noiseModel;
    const original = evaluateGraph(project, { resolution: 64 }).field.height;
    const migrated = parseProject(JSON.parse(JSON.stringify(project)));
    expect(migrated.graph.nodes[0].params.noiseModel).toBe('legacy');
    expect(evaluateGraph(migrated, { resolution: 64 }).field.height).toEqual(original);
    expect(corrected).not.toEqual(original);
    migrated.graph.nodes[0].params.noiseModel = 'v2';
    expect(parseProject(JSON.parse(JSON.stringify(migrated)))).toEqual(migrated);
    expect(evaluateGraph(migrated, { resolution: 64 }).field.height).toEqual(corrected);
  });

  it('exposes fractal and warp controls only for the noise families that use them', () => {
    const source = createNode('noise', { x: 0, y: 0 }, 'source');
    source.params.noiseModel = 'v2';
    for (const mode of ['perlin', 'simplex', 'voronoi', 'voronoi-edge', 'cellular']) {
      source.params.mode = mode;
      expect(noiseParamVisible(source, 'octaves')).toBe(false);
      expect(noiseParamVisible(source, 'persistence')).toBe(false);
      expect(noiseParamVisible(source, 'lacunarity')).toBe(false);
      expect(noiseParamVisible(source, 'warp')).toBe(false);
    }
    source.params.mode = 'wave';
    expect(noiseParamVisible(source, 'octaves')).toBe(true);
    expect(noiseParamVisible(source, 'warp')).toBe(true);
    source.params.noiseModel = 'legacy';
    expect(noiseParamVisible(source, 'octaves')).toBe(false);
    expect(noiseParamVisible(source, 'warp')).toBe(true);
  });
});
