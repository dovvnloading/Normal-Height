import { describe, expect, it } from 'vitest';
import { hydraulicErosion } from './erosion';
import type { ErosionSettings } from './erosion';

function field(n: number, f: (x: number, y: number) => number): Float32Array {
  const z = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++)
    z[y * n + x] = f(x / (n - 1), y / (n - 1));
  return z;
}

const params: ErosionSettings = {
  method: 'fluid', droplets: 100000, lifetime: 64, inertia: 0.18,
  capacity: 4.5, erosion: 0.48, deposition: 0.32,
  evaporation: 0.018, radius: 3, gravity: 4, seed: 1819,
  multiscale: true, worldSize: 4000, heightScale: 1600,
  cycles: 18, featureMeters: 140, hillslope: 0.14, bankAngle: 42,
};

function total(v: Float32Array) {
  let sum = 0;
  for (const x of v) sum += x;
  return sum;
}

describe('conservative coupled fluid-grid erosion', () => {
  it('leaves a perfectly flat DEM unchanged even under variable rainfall', () => {
    const n = 48, z = new Float32Array(n * n).fill(0.42);
    const copy = z.slice();
    const out = hydraulicErosion(z, n, params);
    expect(out.height).toEqual(copy);
    expect(z).toEqual(copy);
    expect(out.eroded).toBe(0);
    expect(out.deposited).toBe(0);
    expect(out.flow.some(f => f > 0)).toBe(true);
  });

  it('is seeded, physically modifies valleys, and accounts for signed mass changes', () => {
    const n = 96;
    const source = field(n, (x, y) =>
      0.91 - y * 0.62 + (x - 0.54) ** 2 * 0.35 +
      Math.cos(x * 15 + y * 2) * Math.sin(y * 8) * 0.025);
    const snapshot = source.slice();
    const first = hydraulicErosion(source, n, params);
    const second = hydraulicErosion(source, n, params);
    expect(first.height).toEqual(second.height);
    expect(first.flow).toEqual(second.flow);
    expect(source).toEqual(snapshot);
    expect(first.height.every(Number.isFinite)).toBe(true);
    expect(first.eroded).toBeGreaterThan(0.01);
    expect(Math.abs(total(first.wear) - first.eroded)).toBeLessThan(0.00001);
    expect(Math.abs(total(first.deposition) - first.deposited)).toBeLessThan(0.00001);
    expect(Math.abs(total(source) - total(first.height) -
      (first.eroded - first.deposited))).toBeLessThan(0.0005);
    expect(first.exportedSediment).toBeCloseTo(
      Math.max(0, first.eroded - first.deposited), 5);
  });

  it('does not change masked rock but still computes water transport', () => {
    const n = 65;
    const z = field(n, (x, y) =>
      0.7 - y * 0.55 + 0.3 * (x - 0.5) ** 2);
    const blocked = hydraulicErosion(z, n, params, new Float32Array(n * n));
    expect(blocked.height).toEqual(z);
    expect(blocked.eroded).toBe(0);
    expect(blocked.deposited).toBe(0);
    expect(blocked.flow.some(q => q > 0)).toBe(true);
  });

  it('responds to rainfall forcing with larger incision and keeps peak morphology', () => {
    const n = 96;
    const z = field(n, (x, y) => 0.18 +
      0.65 * Math.exp(-((x - 0.52) ** 2 * 6 +
        (y - 0.47) ** 2 * 13)) *
      (0.85 + 0.15 * Math.cos(x * 27) * Math.cos(y * 11)));
    const light = hydraulicErosion(z, n, { ...params, droplets: 8000 });
    const rain = hydraulicErosion(z, n, { ...params, droplets: 190000 });
    expect(rain.eroded).toBeGreaterThan(light.eroded);
    expect(Math.max(...rain.height)).toBeGreaterThan(Math.max(...z) * 0.56);
  });

  it('preserves previous erosion methods as independent, selectable algorithms', () => {
    const n = 64, z = field(n, (x, y) =>
      0.8 - 0.6 * y + 0.28 * (x - 0.5) ** 2);
    const fluid = hydraulicErosion(z, n, params);
    const original = hydraulicErosion(z, n, { ...params, method: 'landscape' });
    const legacy = hydraulicErosion(z, n, { ...params, method: 'droplet' });
    expect(fluid.height).not.toEqual(original.height);
    expect(fluid.height).not.toEqual(legacy.height);
  });
});
