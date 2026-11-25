import { describe, expect, it } from 'vitest';
import {
  STUDIO_DEFAULTS,
  STUDIO_FRACTALS,
  STUDIO_KERNELS,
  deriveSeed,
} from '../../model/noiseStudio';
import { createFractal } from './fractal';
import FastNoiseLite, { NoiseType } from './vendor/FastNoiseLite';

function referencePerlin(seed: number, x: number, y: number): number {
  const n = new FastNoiseLite(seed | 0);
  n.SetFrequency(1);
  n.SetNoiseType(NoiseType.Perlin);
  return n.GetNoise(x, y);
}

describe('fractal synthesis', () => {
  it('fractional fBm matches independently accumulated fixed-amplitude octave weights', () => {
    const s = {
      ...STUDIO_DEFAULTS,
      kernel: 'perlin' as const,
      fractal: 'fbm' as const,
      octaves: 3.4,
      persistence: 0.61,
      lacunarity: 2.17,
      octaveRotation: 19.4,
    };
    const seed = 0xfabcde12,
      x = -0.381,
      y = 1.39;
    let sum = 0,
      total = 0;
    for (let i = 0; i < 4; i++) {
      const angle = (i * 19.4 * Math.PI) / 180,
        f = 2.17 ** i;
      const n = referencePerlin(
        i === 0 ? seed : deriveSeed(seed, 101, i),
        (x * Math.cos(angle) - y * Math.sin(angle)) * f,
        (x * Math.sin(angle) + y * Math.cos(angle)) * f,
      );
      const a = 0.61 ** i * Math.min(1, 3.4 - i);
      sum += n * a;
      total += a;
    }
    expect(createFractal(s, seed).sample(x, y, 0)).toBeCloseTo(0.5 + (0.5 * sum) / total, 14);
  });

  it('removing unresolved detail retains the authored denominator', () => {
    const s = {
      ...STUDIO_DEFAULTS,
      kernel: 'perlin' as const,
      fractal: 'fbm' as const,
      octaves: 2,
      persistence: 0.5,
      lacunarity: 4,
      octaveRotation: 0,
    };
    const seed = 13,
      x = 0.23,
      y = 0.79;
    // Footprint .2 leaves the first layer untouched; .8 fully suppresses layer2.
    const expected = 0.5 + (0.5 * referencePerlin(seed, x, y)) / 1.5;
    expect(createFractal(s, seed).sample(x, y, 0.2)).toBeCloseTo(expected, 14);
  });

  it.each(STUDIO_FRACTALS)(
    '%s changes continuously across an integer octave boundary',
    (fractal) => {
      const base = { ...STUDIO_DEFAULTS, kernel: 'perlin' as const, fractal, persistence: 0.63 };
      const low = createFractal({ ...base, octaves: 3 - 1e-7 }, 79);
      const center = createFractal({ ...base, octaves: 3 }, 79);
      const high = createFractal({ ...base, octaves: 3 + 1e-7 }, 79);
      for (const [x, y] of [
        [-0.33, 1.27],
        [0.59, -1.03],
        [7.11, 3.79],
      ]) {
        expect(low.sample(x, y, 0)).toBeCloseTo(center.sample(x, y, 0), 6);
        expect(high.sample(x, y, 0)).toBeCloseTo(center.sample(x, y, 0), 6);
      }
    },
  );

  it.each(STUDIO_FRACTALS)('%s remains finite and bounded across all base kernels', (fractal) => {
    for (const [kernel] of STUDIO_KERNELS) {
      const n = createFractal(
        {
          ...STUDIO_DEFAULTS,
          kernel,
          fractal,
          octaves: 3.7,
          persistence: 0.9,
          ridgeGain: 4,
          weightedStrength: 0.65,
        },
        0xffffffff,
      );
      for (let i = 0; i < 9; i++) {
        const value = n.sample(Math.sin(i * 1.73) * 7, Math.cos(i * 3.17) * 7, 0);
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('single-layer mode ignores unrelated fractal controls', () => {
    const a = createFractal({ ...STUDIO_DEFAULTS, fractal: 'none' }, 151);
    const b = createFractal(
      {
        ...STUDIO_DEFAULTS,
        fractal: 'none',
        octaves: 12,
        persistence: 1,
        lacunarity: 4,
        weightedStrength: 1,
        octaveRotation: -91,
      },
      151,
    );
    expect(a.sample(0.27, -2.91, 0)).toBe(b.sample(0.27, -2.91, 0));
  });

  it('canonical billow and turbulence agree after unsigned normalization without weighting', () => {
    const a = createFractal({ ...STUDIO_DEFAULTS, fractal: 'billow', weightedStrength: 0 }, 73);
    const b = createFractal({ ...STUDIO_DEFAULTS, fractal: 'turbulence', weightedStrength: 0 }, 73);
    for (let i = 0; i < 20; i++)
      expect(a.sample(i * 0.13, i * -0.19, 0)).toBeCloseTo(b.sample(i * 0.13, i * -0.19, 0), 14);
  });

  it.each(['ridged', 'billow', 'turbulence', 'pingpong', 'jordan'] as const)(
    'unresolved %s fades toward its folded mean, not the fold of zero',
    (fractal) => {
      const s = {
        ...STUDIO_DEFAULTS,
        kernel: 'perlin' as const,
        fractal,
        octaves: 1,
        pingPongStrength: 2.31,
        ridgeSharpness: 2.7,
        ridgeSoftness: 0.17,
      };
      const n = createFractal(s, 33);
      const unresolved = n.sample(0.37, -0.19, 100);
      expect(unresolved).toBe(n.sample(13.79, 9.13, 100));
      let mean = 0;
      for (let i = 0; i < 4096; i++)
        mean += n.sample(Math.sin(i * 1.713) * 100, Math.cos(i * 2.191) * 97, 0);
      expect(Math.abs(unresolved - mean / 4096)).toBeLessThan(0.025);
      expect(unresolved).toBeGreaterThan(0.02);
      expect(unresolved).toBeLessThan(0.98);
    },
  );

  it('Swiss derivative warp and Jordan damping are active controls with analytic Perlin', () => {
    const p = { ...STUDIO_DEFAULTS, kernel: 'perlin' as const, octaves: 5 };
    const swiss0 = createFractal({ ...p, fractal: 'swiss', derivativeWarp: 0 }, 183);
    const swiss1 = createFractal({ ...p, fractal: 'swiss', derivativeWarp: 0.7 }, 183);
    const jordan0 = createFractal({ ...p, fractal: 'jordan', derivativeDamping: 0 }, 183);
    const jordan1 = createFractal({ ...p, fractal: 'jordan', derivativeDamping: 2 }, 183);
    expect(Math.abs(swiss0.sample(0.43, 0.79, 0) - swiss1.sample(0.43, 0.79, 0))).toBeGreaterThan(
      0.001,
    );
    expect(jordan1.sample(0.43, 0.79, 0)).toBeLessThan(jordan0.sample(0.43, 0.79, 0));
  });
});
