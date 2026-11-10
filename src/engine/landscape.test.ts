import { describe, expect, it } from 'vitest';
import { hydraulicErosion } from './erosion';
import type { ErosionSettings } from './erosion';
import { createDrainageWorkspace, routeDrainage } from './hydrology';
import { accumulateMultiFlow } from './landscapeFlow';

const field = (n: number, f: (u: number, v: number) => number) => {
  const data = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++)
    data[y * n + x] = f(x / (n - 1), y / (n - 1));
  return data;
};
const sum = (data: Float32Array) =>
  data.reduce((total, value) => total + value, 0);
const params: ErosionSettings = {
  method: 'landscape', seed: 147, droplets: 100000, lifetime: 85,
  inertia: 0.18, capacity: 5, erosion: 0.62, deposition: 0.33,
  evaporation: 0.018, radius: 3, gravity: 4, multiscale: true,
  worldSize: 4800, heightScale: 1800, cycles: 28,
  featureMeters: 180, hillslope: 0.38, bankAngle: 38,
};

describe('multi-flow rainfall', () => {
  it('conserves rainfall at outlets without transmission loss', () => {
    const n = 49;
    const z = field(n, (u, v) => 0.82 - 0.5 * v + 0.14 * (u - 0.5) ** 2);
    const work = routeDrainage(z, n, 42, createDrainageWorkspace(n));
    const rain = new Float32Array(n * n).fill(1);
    const runoff = accumulateMultiFlow(z, work, rain, 1800, 0);
    let outflow = 0;
    for (let i = 0; i < n * n; i++)
      if (work.receiver[i] < 0) outflow += runoff[i];
    expect(outflow).toBeCloseTo(n * n, 3);
    expect(runoff.some(q => q > 10)).toBe(true);
  });

  it('loses discharge with physical-distance transmission losses', () => {
    const n = 49, z = field(n, (u, v) => 0.8 - 0.5 * v + 0.12 * u);
    const before = z.slice();
    const work = routeDrainage(z, n, 4);
    const rain = new Float32Array(n * n).fill(1);
    const zeroLoss = accumulateMultiFlow(z, work, rain, 1800, 0).slice();
    const lossy = accumulateMultiFlow(z, work, rain, 1800, 0.1);
    let a = 0, b = 0;
    for (let i = 0; i < n * n; i++) if (work.receiver[i] < 0) {
      a += zeroLoss[i];
      b += lossy[i];
    }
    expect(b).toBeLessThan(a);
    expect(z).toEqual(before);
  });
});

describe('multi-scale landscape evolution', () => {
  it('is deterministic, incises convergent terrain and conserves exported mass', () => {
    const n = 129;
    const z = field(n, (u, v) => 0.88 - 0.65 * v +
      0.47 * (u - 0.5) ** 2 + 0.025 * Math.cos(15 * u) * Math.sin(v * 9));
    const source = z.slice();
    const a = hydraulicErosion(z, n, params);
    const b = hydraulicErosion(z, n, params);
    expect(a.height).toEqual(b.height);
    expect(a.flow).toEqual(b.flow);
    expect(z).toEqual(source);
    expect(a.eroded).toBeGreaterThan(0.01);
    expect(a.height.every(Number.isFinite)).toBe(true);
    expect(a.flow.every(Number.isFinite)).toBe(true);
    expect(Math.abs(sum(z) - sum(a.height) -
      (a.eroded - a.deposited))).toBeLessThan(0.001);
    expect(Math.abs(a.eroded - a.deposited - a.exportedSediment)).toBeLessThan(0.001);
  });

  it('does not invent rivers on flat terrain, and obeys a zero mask', () => {
    const n = 65, flat = field(n, () => 0.38);
    const a = hydraulicErosion(flat, n, params);
    expect(a.height).toEqual(flat);
    expect(a.eroded).toBe(0);
    const valley = field(n, (u, v) => 0.72 - 0.4 * v +
      0.28 * (u - 0.5) ** 2);
    const b = hydraulicErosion(valley, n, params, new Float32Array(n * n));
    expect(b.height).toEqual(valley);
    expect(b.eroded).toBe(0);
    expect(b.deposited).toBe(0);
    expect(b.flow.some(q => q > 0)).toBe(true);
  });

  it('preserves broad valley structure across source resolutions', () => {
    const shape = (u: number, v: number) => 0.88 - 0.68 * v +
      0.38 * (u - 0.51) ** 2 + 0.04 * Math.sin(u * 9 + v * 3);
    const low = hydraulicErosion(field(65, shape), 65, params);
    const high = hydraulicErosion(field(129, shape), 129, params);
    expect(low.eroded).toBeGreaterThan(0);
    expect(high.eroded).toBeGreaterThan(0);
    expect(Math.abs(low.height[35 * 65 + 32] - high.height[70 * 129 + 64]))
      .toBeLessThan(0.12);
  });

  it('retains previous watershed and particle solvers for A/B testing', () => {
    // A resolved valley is required for any of these geomorphic methods to
    // act: a tiny 48², nearly featureless test field is not a useful A/B target.
    const n = 129, z = field(n, (u, v) => 0.88 - 0.65 * v +
      0.47 * (u - 0.5) ** 2 + 0.025 * Math.cos(15 * u) * Math.sin(v * 9));
    const old = hydraulicErosion(z, n, { ...params, method: 'droplet' });
    const legacyWatershed = hydraulicErosion(z, n, { ...params, method: 'watershed' });
    const latest = hydraulicErosion(z, n, params);
    expect(latest.height).not.toEqual(old.height);
    expect(latest.height).not.toEqual(legacyWatershed.height);
  });
});
