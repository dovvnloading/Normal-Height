import { describe, expect, it } from 'vitest';
import { STUDIO_DEFAULTS, STUDIO_KERNELS } from '../../model/noiseStudio';
import type { StudioKernel } from '../../model/noiseStudio';
import { createKernel } from './kernels';
import { perlinGradient } from './perlin';
import FastNoiseLite, { NoiseType } from './vendor/FastNoiseLite';

const coordinates = [
  [0.37, -1.91],
  [-24.9, 19.13],
  [123.456, -78.125],
  [0, 0],
  [-0.00001, 0.99999],
];
// Values evaluated directly by the unmodified upstream TS file at pinned
// commit 785f37a9ad76e283586a379675085f2063ae03f7, frequency=1, seed=-1.
const referenceVectors: [StudioKernel, number[]][] = [
  [
    'opensimplex2s',
    [-0.2434478954668881, -0.06702973431160106, -0.19157471372140703, 0, -0.013812851648350269],
  ],
  [
    'opensimplex2',
    [-0.5240449050544347, -0.11595213526560118, -0.10054498275312501, 0, 0.17628645207667112],
  ],
  [
    'perlin',
    [-0.2979854342152799, -0.200333815292992, 0.4161336374921484, 0, -0.000007710794858490063],
  ],
  [
    'value',
    [
      -0.4732827041937043, -0.8046659653147202, -0.39429202064483554, 0.4988906276412308,
      0.3853222598022258,
    ],
  ],
  [
    'value-cubic',
    [
      -0.3526813878591027, -0.33198499737255366, -0.2606508717403571, 0.22172916784054703,
      0.1712533059469994,
    ],
  ],
];

describe('pinned FastNoiseLite kernels', () => {
  it.each(referenceVectors)('%s matches fixed independent upstream vectors', (kernel, expected) => {
    const n = createKernel({ ...STUDIO_DEFAULTS, kernel }, 0xffffffff);
    coordinates.forEach(([x, y], i) => expect(n.sample(x, y)).toBeCloseTo(expected[i], 14));
  });

  it('OpenSimplex2 and OpenSimplex2S are distinct algorithms, not renamed legacy simplex', () => {
    const a = createKernel({ ...STUDIO_DEFAULTS, kernel: 'opensimplex2' }, 1337);
    const b = createKernel({ ...STUDIO_DEFAULTS, kernel: 'opensimplex2s' }, 1337);
    expect(Math.abs(a.sample(0.13, 0.47) - b.sample(0.13, 0.47))).toBeGreaterThan(0.05);
  });

  it('analytic Perlin values and derivatives match the independent vendor interpolant', () => {
    const h = 0.00001;
    for (const seed of [0, 1, 123456789, 0xffffffff]) {
      const reference = new FastNoiseLite(seed | 0);
      reference.SetFrequency(1);
      reference.SetNoiseType(NoiseType.Perlin);
      for (let i = 0; i < 80; i++) {
        const x = i % 10 === 0 ? i - 40 : Math.sin(i * 3.71) * 47.3;
        const y = i % 11 === 0 ? i - 30 : Math.cos(i * 7.97) * 43.7;
        const g = perlinGradient(seed, x, y);
        expect(g.value).toBeCloseTo(reference.GetNoise(x, y), 13);
        expect(g.dx).toBeCloseTo(
          (reference.GetNoise(x + h, y) - reference.GetNoise(x - h, y)) / (2 * h),
          7,
        );
        expect(g.dy).toBeCloseTo(
          (reference.GetNoise(x, y + h) - reference.GetNoise(x, y - h)) / (2 * h),
          7,
        );
      }
    }
  });
});

describe('studio kernels', () => {
  it.each(STUDIO_KERNELS)('%s is bounded, deterministic, and controlled by its seed', (kernel) => {
    const a = createKernel({ ...STUDIO_DEFAULTS, kernel }, 18427);
    const b = createKernel({ ...STUDIO_DEFAULTS, kernel }, 18427);
    const c = createKernel({ ...STUDIO_DEFAULTS, kernel }, 775123);
    let difference = 0,
      span = 0;
    const first = a.sample(-3.31, 7.73);
    for (let i = 0; i < 40; i++) {
      const x = Math.sin(i * 1.293 + 0.17) * 8,
        y = Math.cos(i * 4.713) * 8;
      const v = a.sample(x, y);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(-1.0000000001);
      expect(v).toBeLessThanOrEqual(1.0000000001);
      expect(v).toBe(b.sample(x, y));
      difference += Math.abs(v - c.sample(x, y));
      span += Math.abs(v - first);
    }
    expect(difference).toBeGreaterThan(0.1);
    expect(span).toBeGreaterThan(0.1);
  });

  it('Gaussian grain has a bell-shaped distribution distinct from uniform white noise', () => {
    const white = createKernel({ ...STUDIO_DEFAULTS, kernel: 'white' }, 1337);
    const gaussian = createKernel({ ...STUDIO_DEFAULTS, kernel: 'gaussian' }, 1337);
    let wMean = 0,
      gMean = 0,
      wSquare = 0,
      gSquare = 0;
    for (let i = 0; i < 4096; i++) {
      const w = white.sample((i % 64) + 0.25, Math.floor(i / 64) + 0.25);
      const g = gaussian.sample((i % 64) + 0.25, Math.floor(i / 64) + 0.25);
      wMean += w;
      gMean += g;
      wSquare += w * w;
      gSquare += g * g;
    }
    expect(Math.abs(wMean / 4096)).toBeLessThan(0.03);
    expect(Math.abs(gMean / 4096)).toBeLessThan(0.03);
    expect(wSquare / 4096).toBeCloseTo(1 / 3, 1);
    expect(gSquare / 4096).toBeCloseTo(1 / 9, 1);
    expect(gSquare).toBeLessThan(wSquare * 0.45);
  });

  it('numerical derivatives match independent central differences on continuous custom fields', () => {
    for (const kernel of [
      'opensimplex2s',
      'value-cubic',
      'gabor',
      'sparse',
      'crater',
      'dunes',
    ] as const) {
      const n = createKernel({ ...STUDIO_DEFAULTS, kernel }, 561);
      const h = 0.00001,
        x = 0.372,
        y = -0.827;
      const g = n.gradient(x, y);
      expect(g.dx).toBeCloseTo((n.sample(x + h, y) - n.sample(x - h, y)) / (2 * h), 5);
      expect(g.dy).toBeCloseTo((n.sample(x, y + h) - n.sample(x, y - h)) / (2 * h), 5);
    }
  });

  it('discontinuous inputs explicitly disable derivative feedback', () => {
    for (const kernel of ['white', 'gaussian', 'cellular', 'wave'] as const) {
      const n = createKernel(
        { ...STUDIO_DEFAULTS, kernel, cellularReturn: 'cell', waveProfile: 'saw' },
        5,
      );
      expect(n.derivative).toBe('discontinuous');
      expect(n.gradient(0.99999, 2.7).dx).toBe(0);
      expect(n.gradient(0.99999, 2.7).dy).toBe(0);
    }
  });

  it('true cellular edges are explicitly Euclidean irrespective of the hidden metric', () => {
    const euclidean = createKernel(
      {
        ...STUDIO_DEFAULTS,
        kernel: 'cellular',
        cellularReturn: 'edge',
        cellularMetric: 'euclidean',
      },
      56,
    );
    const manhattan = createKernel(
      {
        ...STUDIO_DEFAULTS,
        kernel: 'cellular',
        cellularReturn: 'edge',
        cellularMetric: 'manhattan',
      },
      56,
    );
    for (const [x, y] of coordinates) expect(euclidean.sample(x, y)).toBe(manhattan.sample(x, y));
  });

  it('smooth cellular remapping preserves variation below zero distance instead of clipping plateaus', () => {
    const n = createKernel(
      {
        ...STUDIO_DEFAULTS,
        kernel: 'cellular',
        cellularReturn: 'smooth',
        cellularJitter: 0,
        cellularSmoothness: 1,
      },
      5,
    );
    const a = n.sample(0.5, 0.5),
      b = n.sample(0.5001, 0.5);
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
  });
});
