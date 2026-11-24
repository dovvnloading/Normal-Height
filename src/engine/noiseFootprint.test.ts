import { describe, expect, it } from 'vitest';
import { Noise, randomGenerator } from './noise';
import { evaluateGraph } from './index';
import { createNode } from '../model/registry';
import { createProject } from '../model/presets';

describe('resolution-aware procedural fractals', () => {
  it('preserves resolved layers and their original amplitude normalization', () => {
    const noise = new Noise(42, 'v2');
    expect(noise.fractal(1.23, 2.345, 3, 0.5, 2, 'fbm', 0, 0.01))
      .toBe(noise.fractal(1.23, 2.345, 3, 0.5, 2));
    const weights = Array.from({ length: 10 }, (_, i) => 0.85 ** i)
      .reduce((a, b) => a + b, 0);
    expect(noise.fractal(1.23, 2.345, 10, 0.85, 3.5, 'fbm', 0, 0.19))
      .toBeCloseTo(noise.perlin(1.23, 2.345) / weights, 12);
    expect(noise.fractal(1.23, 2.345, 10, 0.85, 3.5, 'fbm', 0, 0.5)).toBe(0);
    const legacy = new Noise(42, 'legacy');
    for (const mode of ['fbm', 'ridged', 'billow', 'turbulence', 'wave', 'warped', 'naki'])
      expect(legacy.sample(mode, 1.23, 2.345, 10, 0.85, 3.5, 0.8, 0.5))
        .toBe(legacy.sample(mode, 1.23, 2.345, 10, 0.85, 3.5, 0.8));
  });

  const configurations = [
    { mode: 'fbm', rotation: 0, stretch: 1, warp: 0, maxErrorRatio: 0.65 },
    { mode: 'fbm', rotation: 27, stretch: 2, warp: 0, maxErrorRatio: 0.85 },
    { mode: 'warped', rotation: 27, stretch: 1.4, warp: 0.8, maxErrorRatio: 0.85 },
  ] as const;
  for (const config of configurations) {
    it(`reduces footprint aliasing in ${config.mode}, rotation ${config.rotation}, stretch ${config.stretch}`, () => {
      const project = createProject();
      project.seed = 1;
      const source = createNode('noise', { x: 0, y: 0 }, 'source');
      const output = createNode('output', { x: 200, y: 0 }, 'out');
      source.params = {
        ...source.params, noiseModel: 'v2', mode: config.mode,
        scale: 24, octaves: 10, persistence: 0.85, lacunarity: 3.5,
        amplitude: 1, offset: 0, seed: 0, rotation: config.rotation,
        stretch: config.stretch, warp: config.warp,
      };
      project.graph = {
        nodes: [source, output],
        edges: [{ id: 'e', source: 'source', target: 'out', sourceHandle: 'height', targetHandle: 'in' }],
      };
      const noise = new Noise(1, 'v2');
      const angle = config.rotation * Math.PI / 180;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      for (const n of [128, 256, 1024]) {
        const actual = evaluateGraph(project, { resolution: n }).field.height;
        const random = randomGenerator(445);
        const continuous = (x: number, y: number) => {
          const px = (x / (n - 1) - 0.5) * 24;
          const py = (y / (n - 1) - 0.5) * 24;
          const u = (px * cos - py * sin) / config.stretch + 17.319;
          const v = (px * sin + py * cos) * config.stretch + 8.173;
          return noise.sample(config.mode, u, v, 10, 0.85, 3.5, config.warp);
        };
        let directError = 0, filteredError = 0;
        // Integrate the unfiltered continuous field over each sampled texel.
        // Stratified jitter prevents the reference's regular sampling lattice
        // from coherently aliasing the extreme high-frequency octaves.
        for (let j = 1; j <= 8; j++) for (let i = 1; i <= 8; i++) {
          const x = Math.floor(i * (n - 1) / 9), y = Math.floor(j * (n - 1) / 9);
          let reference = 0;
          for (let sy = 0; sy < 32; sy++) for (let sx = 0; sx < 32; sx++)
            reference += continuous(x + (sx + random()) / 32 - 0.5, y + (sy + random()) / 32 - 0.5);
          reference /= 1024;
          directError += (continuous(x, y) - reference) ** 2;
          filteredError += (actual[y * n + x] - reference) ** 2;
        }
        expect(Math.sqrt(filteredError / directError)).toBeLessThan(config.maxErrorRatio);
        if (n === 128)
          expect(evaluateGraph(project, { resolution: n }).field.height).toEqual(actual);
      }
    }, 30000);
  }
});
