import { describe, expect, it } from 'vitest';
import { hydraulicErosion } from './erosion';
import type { ErosionSettings } from './erosion';
import { reconstructionWeight } from './erosionMask';

const settings: ErosionSettings = {
  droplets: 250000, lifetime: 85, inertia: 0.18, capacity: 10,
  erosion: 0.62, deposition: 0.33, evaporation: 0.018, radius: 3,
  gravity: 4, seed: 147, multiscale: false, cycles: 12,
  worldSize: 4800, heightScale: 1800, featureMeters: 180,
  hillslope: 0, bedrockPreserve: false,
};
const terrain = (n: number) => {
  const result = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = x / (n - 1), v = y / (n - 1);
    result[y * n + x] = 0.88 - 0.65 * v +
      0.47 * (u - 0.5) ** 2 + 0.025 * Math.cos(15 * u) * Math.sin(9 * v);
  }
  return result;
};

describe('erosion mask reconstruction', () => {
  it('attenuates only excess interpolated permission and never amplifies a delta', () => {
    expect(reconstructionWeight(0, 0.25)).toBe(0);
    expect(reconstructionWeight(0.5, 0.5)).toBe(1);
    expect(reconstructionWeight(0.25, 0.25)).toBe(1);
    expect(reconstructionWeight(0.25, 0.5)).toBe(0.5);
    expect(reconstructionWeight(0.5, 0.25)).toBe(1);
    expect(reconstructionWeight(1, 0.25)).toBe(1);
  });

  for (const method of ['landscape', 'fluid'] as const) {
    it(`${method}: reconstructs the measured physical net change for fractional masks`, () => {
      const n = 65, source = terrain(n);
      const options = { ...settings, method };
      const unmasked = hydraulicErosion(source, n, options);
      const perSample = options.worldSize! ** 2 * options.heightScale! / (n * n);
      for (const opacity of [0, 0.25, 0.5, 1]) {
        const result = hydraulicErosion(source, n, options, new Float32Array(n * n).fill(opacity));
        if (opacity === 0) expect(result.height).toEqual(source);
        else {
          const budget = result.sedimentBudget!;
          expect(budget.erodedVolumeM3).toBeGreaterThan(0);
          const measured = budget.erodedVolumeM3 - budget.depositedVolumeM3;
          // Same-resolution, unsmoothed, single-stage simulation: the actual
          // output delta must agree with the independently accumulated ledger.
          const reconstructed = (result.eroded - result.deposited) * perSample;
          expect(Math.abs(reconstructed - measured)).toBeLessThan(
            Math.max(1, budget.erodedVolumeM3) * 0.00001);
          expect(Math.abs(budget.balanceErrorM3)).toBeLessThan(
            Math.max(1, budget.erodedVolumeM3) * 0.02);
          if (result.waterBudget) expect(Math.abs(result.waterBudget.balanceErrorM3))
            .toBeLessThan(result.waterBudget.rainfallVolumeM3 * 0.002);
        }
        if (opacity === 1) expect(result.height).toEqual(unmasked.height);
      }
    });

    it(`${method}: retains protected cells through coarse-to-fine and export reconstruction`, () => {
      const n = 513, source = terrain(n);
      const mask = new Float32Array(n * n);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++)
        mask[y * n + x] = Math.min(0.5, Math.max(0, (x / (n - 1) - 0.35) * 4));
      const result = hydraulicErosion(source, n, {
        ...settings, method, cycles: 4, multiscale: true, worldSize: 12000,
        bedrockPreserve: true,
      }, mask);
      expect(result.height.every(Number.isFinite)).toBe(true);
      expect(result.eroded + result.deposited).toBeGreaterThan(0.01);
      for (let i = 0; i < mask.length; i++)
        if (mask[i] === 0 && result.height[i] !== source[i])
          throw new Error(`Protected cell ${i} changed during reconstruction`);
      const budget = result.sedimentBudget!;
      expect(Math.abs(budget.balanceErrorM3)).toBeLessThan(
        Math.max(1, budget.erodedVolumeM3) * 0.02);
      if (result.waterBudget) expect(Math.abs(result.waterBudget.balanceErrorM3))
        .toBeLessThan(result.waterBudget.rainfallVolumeM3 * 0.002);
    }, 30000);
  }
});
