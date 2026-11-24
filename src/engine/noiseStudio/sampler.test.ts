import { describe, expect, it } from 'vitest';
import type { ParamValue } from '../../model/types';
import { STUDIO_DEFAULTS, resolveNoiseSeed } from '../../model/noiseStudio';
import { createStudioSampler, generateStudioNoise } from './index';
import { createDomainWarper } from './warp';
import { createOutputShaper, evaluateCurve } from './curve';

const params = (overrides: Record<string, ParamValue> = {}): Record<string, ParamValue> => ({
  ...STUDIO_DEFAULTS,
  amplitude: 1,
  offset: 0,
  ...overrides,
});
const probe = (p: Record<string, ParamValue>, seed = 181): number[] => {
  const n = createStudioSampler(p, seed, 4000);
  return Array.from({ length: 15 }, (_, i) =>
    n.sample(i * 0.071 - 0.17, i * 0.129 - 0.41, 1 / 511),
  );
};

describe('seed and coordinate contract', () => {
  it('linked, fixed, named and fully uint32 locked seeds behave reproducibly', () => {
    expect(probe(params(), 1)).not.toEqual(probe(params(), 2));
    expect(probe(params({ seedMode: 'fixed' }), 1)).toEqual(
      probe(params({ seedMode: 'fixed' }), 2),
    );
    expect(probe(params({ seedText: 'granite' }))).not.toEqual(
      probe(params({ seedText: 'Granite' })),
    );
    const p = params({ seedText: 'north', seed: 8181 });
    const seed = resolveNoiseSeed(p, 131);
    const locked = { ...p, seedLocked: true, lockedSeed: seed };
    expect(probe(p, 131)).toEqual(probe(locked, 9821));
    expect(probe(params({ seedLocked: true, lockedSeed: 0xffffffff }), 1)).toEqual(
      probe(params({ seedLocked: true, lockedSeed: 0xffffffff }), 2),
    );
    expect(probe(params({ seedLocked: true, lockedSeed: 0xffffffff }))).not.toEqual(
      probe(params({ seedLocked: true, lockedSeed: 0x7fffffff })),
    );
  });

  it('feature size in world meters preserves samples at common centered world positions', () => {
    const p = params({ scaleMode: 'world', featureSize: 500, sampling: 'point' });
    const a = createStudioSampler(p, 93, 4000),
      b = createStudioSampler(p, 93, 8000);
    expect(a.sample(0.67, 0.31)).toBeCloseTo(b.sample(0.585, 0.405), 13);
    const tileA = createStudioSampler(params({ scaleMode: 'tile' }), 93, 4000);
    const tileB = createStudioSampler(params({ scaleMode: 'tile' }), 93, 8000);
    expect(tileA.sample(0.67, 0.31)).toBe(tileB.sample(0.67, 0.31));
  });

  it('rotation, independent frequencies, offset and seed all affect the field', () => {
    const base = probe(params());
    const changes: Record<string, ParamValue>[] = [
      { rotation: 37 },
      { scaleX: 1.7 },
      { scaleY: 0.6 },
      { offsetX: -0.79 },
      { offsetY: 1.73 },
      { seed: 7 },
    ];
    for (const change of changes)
      expect(probe(params(change))).not.toEqual(base);
  });
});

describe('independent, progressive and curl domain distortion', () => {
  it('zero warp amplitude is bit-exact identity for every warp mode', () => {
    const original = probe(params({ warpType: 'none' }));
    for (const warpType of ['independent', 'progressive', 'curl']) {
      expect(
        probe(
          params({
            warpType,
            warpAmplitude: 0,
            warpFrequency: 7.9,
            warpOctaves: 6,
            warpSeedMode: 'fixed',
            warpSeed: 15919,
          }),
        ),
      ).toEqual(original);
    }
  });

  it('all three warp paths are distinct and separately seedable', () => {
    const base = probe(params());
    const independent = probe(params({ warpType: 'independent' }));
    const progressive = probe(params({ warpType: 'progressive' }));
    const curl = probe(params({ warpType: 'curl' }));
    expect(independent).not.toEqual(base);
    expect(progressive).not.toEqual(independent);
    expect(curl).not.toEqual(independent);
    expect(curl).not.toEqual(progressive);
    expect(probe(params({ warpType: 'independent', warpSeed: 91 }))).not.toEqual(independent);
  });

  it('a fixed warp stream is independent of the source seed, while derived stream follows it', () => {
    const settings = {
      ...STUDIO_DEFAULTS,
      warpType: 'independent' as const,
      warpSeed: 153,
      warpSeedMode: 'fixed' as const,
    };
    const a = createDomainWarper(settings, 13)!,
      b = createDomainWarper(settings, 81)!;
    expect(a.warp(-0.51, 0.69, 0)).toEqual(b.warp(-0.51, 0.69, 0));
    const c = createDomainWarper({ ...settings, warpSeedMode: 'derived' }, 13)!;
    const d = createDomainWarper({ ...settings, warpSeedMode: 'derived' }, 81)!;
    expect(c.warp(-0.51, 0.69, 0)).not.toEqual(d.warp(-0.51, 0.69, 0));
  });

  it('the curl displacement is numerically divergence-free before applying it as a mapping', () => {
    const n = createDomainWarper(
      { ...STUDIO_DEFAULTS, warpType: 'curl', warpKernel: 'perlin', warpOctaves: 3 },
      13,
    )!;
    const h = 0.00001;
    for (const [x, y] of [
      [0.31, -0.27],
      [-1.37, 3.19],
      [2.29, 0.59],
    ]) {
      const xp = n.warp(x + h, y, 0),
        xm = n.warp(x - h, y, 0);
      const yp = n.warp(x, y + h, 0),
        ym = n.warp(x, y - h, 0);
      const divergence =
        (xp.x - (x + h) - (xm.x - (x - h)) + (yp.y - (y + h)) - (ym.y - (y - h))) / (2 * h);
      expect(Math.abs(divergence)).toBeLessThan(0.00001);
    }
  });
});

describe('seamless output and sampling quality', () => {
  it.each(['none', 'independent', 'progressive', 'curl'] as const)(
    '%s warp preserves opposite tile borders after every transform',
    (warpType) => {
      const n = createStudioSampler(
        params({
          tiling: 'blend',
          warpType,
          rotation: 37.2,
          scaleX: 1.73,
          scaleY: 0.61,
          offsetX: -2.71,
          offsetY: 3.19,
          warpAmplitude: 0.83,
          curve: '[[0,0.1],[0.37,0.23],[0.71,0.9],[1,1]]',
        }),
        0x1fffffff,
        4000,
      );
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        expect(n.sample(0, t, 1 / 511)).toBe(n.sample(1, t, 1 / 511));
        expect(n.sample(t, 0, 1 / 511)).toBe(n.sample(t, 1, 1 / 511));
        expect(n.sample(t, 0.31, 1 / 511)).toBeCloseTo(n.sample(t + 1, 0.31, 1 / 511), 10);
      }
    },
  );

  it('continuous fields match slopes as well as values across both tile seams', () => {
    const n = createStudioSampler(
      params({
        kernel: 'perlin',
        fractal: 'fbm',
        octaves: 3,
        tiling: 'blend',
        sampling: 'point',
        rotation: 29,
        warpType: 'progressive',
        warpAmplitude: 0.27,
      }),
      19,
      4000,
    );
    const h = 0.0000001;
    for (const t of [0.13, 0.39, 0.71, 0.91]) {
      const dx0 = (n.sample(h, t) - n.sample(0, t)) / h;
      const dx1 = (n.sample(1, t) - n.sample(1 - h, t)) / h;
      const dy0 = (n.sample(t, h) - n.sample(t, 0)) / h;
      const dy1 = (n.sample(t, 1) - n.sample(t, 1 - h)) / h;
      expect(Math.abs(dx0 - dx1)).toBeLessThan(0.001);
      expect(Math.abs(dy0 - dy1)).toBeLessThan(0.001);
    }
  });

  it.each(['filtered', 'supersample2', 'supersample4'])(
    '%s keeps seamless borders in the final sampled output',
    (sampling) => {
      const n = createStudioSampler(
        params({
          tiling: 'blend',
          sampling,
          kernel: 'cellular',
          fractal: 'none',
          cellularReturn: 'edge',
          rotation: 47,
        }),
        51,
        4000,
      );
      for (const t of [0, 0.173, 0.5, 0.891, 1]) {
        expect(n.sample(0, t, 1 / 127)).toBe(n.sample(1, t, 1 / 127));
        expect(n.sample(t, 0, 1 / 127)).toBe(n.sample(t, 1, 1 / 127));
      }
    },
  );

  it('the unfiltered reference ignores output resolution', () => {
    const n = createStudioSampler(params({ sampling: 'point' }), 73, 4000);
    expect(n.sample(0.31, 0.79, 1 / 31)).toBe(n.sample(0.31, 0.79, 1 / 4095));
    const lowFrequency = createStudioSampler(
      params({ kernel: 'perlin', fractal: 'fbm', octaves: 2, scale: 3 }),
      73,
      4000,
    );
    expect(lowFrequency.sample(0.31, 0.79, 1 / 511)).toBe(
      lowFrequency.sample(0.31, 0.79, 1 / 1023),
    );
  });

  it('supersampling integrates the shaped field with the correct subpixel footprint', () => {
    const p = params({
      kernel: 'wave',
      fractal: 'none',
      scale: 16,
      gamma: 2.3,
      contrast: 1.7,
      curve: '[[0,0],[0.4,0.1],[0.7,0.9],[1,1]]',
      sampling: 'supersample2',
    });
    const supersampled = createStudioSampler(p, 11, 4000);
    const filtered = createStudioSampler({ ...p, sampling: 'filtered' }, 11, 4000);
    const u = 0.317,
      v = 0.653,
      footprint = 1 / 63;
    let expected = 0;
    for (const dx of [-0.25, 0.25])
      for (const dy of [-0.25, 0.25])
        expected += filtered.sample(u + dx * footprint, v + dy * footprint, footprint / 2) / 4;
    expect(supersampled.sample(u, v, footprint)).toBeCloseTo(expected, 14);
  });

  it('higher sample counts converge toward a densely integrated subpixel reference', () => {
    const p = params({ kernel: 'wave', fractal: 'none', scale: 14, phaseNoise: 0 });
    const point = createStudioSampler({ ...p, sampling: 'point' }, 13, 4000);
    const filtered = createStudioSampler({ ...p, sampling: 'filtered' }, 13, 4000);
    const two = createStudioSampler({ ...p, sampling: 'supersample2' }, 13, 4000);
    const four = createStudioSampler({ ...p, sampling: 'supersample4' }, 13, 4000);
    const footprint = 1 / 32;
    let error1 = 0, error2 = 0, error4 = 0;
    for (const u of [0.137, 0.281, 0.397, 0.531, 0.713]) {
      let reference = 0;
      for (let i = 0; i < 4096; i++) reference += point.sample(u + ((i + 0.5) / 4096 - 0.5) * footprint, 0.51);
      reference /= 4096;
      error1 += (filtered.sample(u, 0.51, footprint) - reference) ** 2;
      error2 += (two.sample(u, 0.51, footprint) - reference) ** 2;
      error4 += (four.sample(u, 0.51, footprint) - reference) ** 2;
    }
    expect(error2).toBeLessThan(error1 * 0.1);
    expect(error4).toBeLessThan(error2 * 0.1);
  });

  it('arbitrary resolutions canonicalize the final periodic sample exactly, including discontinuous grain', () => {
    const resolution = 50;
    expect((resolution - 1) * (1 / (resolution - 1))).not.toBe(1);
    const field = generateStudioNoise(params({ kernel: 'white', fractal: 'none', tiling: 'blend',
      sampling: 'point', scale: 64 }), 42, resolution, 4000);
    for (let i = 0; i < resolution; i++) {
      expect(field[i * resolution]).toBe(field[i * resolution + resolution - 1]);
      expect(field[i]).toBe(field[(resolution - 1) * resolution + i]);
    }
  });

  it('full buffers and streaming samples are identical and progress is monotonic', () => {
    const p = params({
      sampling: 'supersample2',
      tiling: 'blend',
      warpType: 'independent',
      octaves: 3.4,
    });
    const progress: number[] = [];
    const field = generateStudioNoise(p, 151, 17, 4000, (value) => progress.push(value));
    const n = createStudioSampler(p, 151, 4000);
    for (let y = 0; y < 17; y++)
      for (let x = 0; x < 17; x++) {
        expect(field[y * 17 + x]).toBe(Math.fround(n.sample(x / 16, y / 16, 1 / 16)));
      }
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });
});

describe('output shaping', () => {
  it('uses exactly the editor’s piecewise-linear curve with endpoint extrapolation', () => {
    const points = [
      { x: 0, y: 0.2 },
      { x: 0.4, y: 0.8 },
      { x: 1, y: 1 },
    ];
    expect(evaluateCurve(points, 0.2)).toBeCloseTo(0.5);
    expect(evaluateCurve(points, 0.7)).toBeCloseTo(0.9);
    expect(evaluateCurve(points, -0.2)).toBeCloseTo(-0.1);
  });

  it('has a predictable levels → gamma → contrast/bias → invert → curve → amplitude order', () => {
    const n = createOutputShaper({
      ...STUDIO_DEFAULTS,
      blackPoint: 0.1,
      whitePoint: 0.9,
      gamma: 2,
      contrast: 1.5,
      bias: 0.1,
      invert: true,
      curve: '[[0,0],[0.5,0.25],[1,1]]',
      amplitude: 0.7,
      offset: -0.1,
    });
    // .3→.25→.5→.6→.4→.2→.04.
    expect(n(0.3)).toBeCloseTo(0.04, 14);
  });

  it('clamping is applied before amplitude/offset, and unclamped extrapolation remains finite', () => {
    const common = { ...STUDIO_DEFAULTS, contrast: 4, amplitude: 0.7, offset: 0.2 };
    expect(createOutputShaper({ ...common, clampOutput: true })(1)).toBeCloseTo(0.9);
    expect(createOutputShaper({ ...common, clampOutput: false })(1)).toBeCloseTo(1.95);
    const extreme = createOutputShaper({
      ...common,
      clampOutput: false,
      blackPoint: 0.5,
      whitePoint: 0.5000001,
      gamma: 0.1,
      curve: '[[0,0],[0.999,0],[1,1]]',
    });
    expect(Number.isFinite(Math.fround(extreme(1)))).toBe(true);
    expect(Number.isFinite(Math.fround(extreme(0)))).toBe(true);
  });
});
