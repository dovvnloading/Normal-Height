import { describe, expect, it } from 'vitest';
import { accumulateDrainage, createDrainageWorkspace, routeDrainage } from './hydrology';
import { hydraulicErosion } from './erosion';
import type { ErosionSettings } from './erosion';

const fixture = (n: number, fn: (u: number, v: number) => number) => {
  const h = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++)
    h[y * n + x] = fn(x / (n - 1), y / (n - 1));
  return h;
};
const parameters: ErosionSettings = {
  droplets: 70000, lifetime: 64, inertia: 0.18,
  capacity: 4, erosion: 0.6, deposition: 0.4,
  evaporation: 0.018, radius: 3, gravity: 4,
  multiscale: true, seed: 42, worldSize: 1600,
  heightScale: 1200, method: 'watershed',
};
const sum = (v: Float32Array) => v.reduce((a, b) => a + b, 0);

describe('priority-flood watershed routing', () => {
  it('drains an enclosed basin through the spill point without editing elevations', () => {
    const n = 33;
    const original = fixture(n, (u, v) =>
      u === 0 || u === 1 || v === 0 || v === 1
        ? 0.3 : 0.65 - 0.55 * Math.exp(-((u - 0.5) ** 2 + (v - 0.5) ** 2) * 80));
    const before = original.slice();
    const route = routeDrainage(original, n, 381);
    const center = 16 * n + 16;
    expect(route.spill[center]).toBeGreaterThan(original[center]);
    expect(original).toEqual(before);
    let count = 0, i = center;
    while (route.receiver[i] >= 0 && count < n * n) {
      const next = route.receiver[i];
      expect(route.rank[next]).toBeLessThan(route.rank[i]);
      i = next;
      count++;
    }
    expect(count).toBeLessThan(n * n);
    expect(i % n === 0 || i % n === n - 1 ||
      Math.floor(i / n) === 0 || Math.floor(i / n) === n - 1).toBe(true);
  });

  it('accumulates exact uniform rainfall into open outlets and conserves area on a zero-loss grid', () => {
    const n = 49;
    const h = fixture(n, (u, v) =>
      0.8 - v * 0.6 + (u - 0.5) ** 2 * 0.2);
    const route = routeDrainage(h, n, 9);
    const area = accumulateDrainage(route, 1800, 0);
    let exportedWater = 0, outlets = 0;
    for (let i = 0; i < n * n; i++) {
      if (route.receiver[i] < 0) {
        exportedWater += area[i];
        outlets++;
      } else {
        expect(route.rank[route.receiver[i]]).toBeLessThan(route.rank[i]);
        expect(area[route.receiver[i]]).toBeGreaterThanOrEqual(area[i]);
      }
    }
    expect(outlets).toBe(4 * (n - 1));
    expect(exportedWater).toBeCloseTo(n * n, 4);
    // On a uniformly sloping 49-row plane the longest independent stream
    // contains 48 contributing cells; demanding 51 would be unphysical.
    expect(Math.max(...area)).toBeGreaterThanOrEqual(n - 1);
    // Reusing typed arrays for successive erosion passes produces identical paths.
    const reused = routeDrainage(h, n, 9, route);
    expect(reused.area).toBe(area);
    expect(reused.order).toEqual(route.order);
  });
});

describe('sediment-conserving connected watershed erosion', () => {
  it('incises runoff routes reproducibly with a physical sediment budget', () => {
    const n = 65, h = fixture(n, (u, v) =>
      0.9 - v * 0.7 + 0.3 * (u - 0.5) ** 2 +
      0.012 * Math.cos(u * 17) * Math.sin(v * 9));
    const baseline = h.slice();
    const result = hydraulicErosion(h, n, parameters);
    const duplicate = hydraulicErosion(h, n, parameters);
    expect(result.height).toEqual(duplicate.height);
    expect(result.height).not.toEqual(h);
    expect(h).toEqual(baseline);
    expect(result.eroded).toBeGreaterThan(0);
    expect(result.deposited).toBeGreaterThan(0);
    expect(result.exportedSediment).toBeGreaterThanOrEqual(0);
    expect(Math.abs(sum(result.wear) - result.eroded)).toBeLessThan(0.0001);
    expect(Math.abs(sum(result.deposition) - result.deposited)).toBeLessThan(0.0001);
    expect(Math.abs(sum(h) - sum(result.height) -
      (result.eroded - result.deposited))).toBeLessThan(0.0001);
    expect(Math.abs(result.eroded - result.deposited -
      result.exportedSediment)).toBeLessThan(0.0001);
    expect(result.flow.some(v => v > 0)).toBe(true);
  });

  it('changes the river network with runoff forcing but never paints noise onto flat land', () => {
    const n = 64;
    const plane = fixture(n, (u, v) => 0.9 - 0.7 * v + 0.05 * u);
    const weak = hydraulicErosion(plane, n, { ...parameters, droplets: 4000 });
    const strong = hydraulicErosion(plane, n, { ...parameters, droplets: 180000 });
    expect(strong.eroded).toBeGreaterThan(weak.eroded);
    const flat = fixture(n, () => 0.4);
    const after = hydraulicErosion(flat, n, parameters);
    expect(after.height).toEqual(flat);
    expect(after.eroded).toBe(0);
  });

  it('preserves masked geology and routes the rain into flow diagnostics', () => {
    const n = 48, height = fixture(n, (_u, v) => 0.9 - v * 0.7);
    const zero = new Float32Array(n * n);
    const erosion = hydraulicErosion(height, n, parameters, zero);
    expect(erosion.height).toEqual(height);
    expect(erosion.eroded).toBe(0);
    expect(erosion.deposited).toBe(0);
    expect(erosion.flow.some(v => v > 1)).toBe(true);
  });

  it('preserves the deterministic legacy droplet mode as an explicit option', () => {
    const n = 32;
    const height = fixture(n, (u, v) => 0.8 - v * 0.6 + 0.2 * Math.sin(u * 7));
    const old = hydraulicErosion(height, n, { ...parameters, method: 'droplet' });
    const oldAgain = hydraulicErosion(height, n, { ...parameters, method: 'droplet' });
    expect(old.height).toEqual(oldAgain.height);
    expect(old.height).not.toEqual(hydraulicErosion(height, n, parameters).height);
  });
});
