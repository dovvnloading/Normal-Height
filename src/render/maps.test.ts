import { describe, expect, it } from 'vitest';
import type { HeightField } from '../model/types';
import { alpineMaterialVariation, colorizeMap, normalMapPixels, sampleSlope } from './maps';

function field(height: number[]): HeightField {
  const resolution = Math.sqrt(height.length);
  return {
    resolution,
    height: new Float32Array(height),
    flow: new Float32Array(height.length),
    wear: new Float32Array(height.length),
    deposition: new Float32Array(height.length),
  };
}

describe('heightfield display and normal encoding', () => {
  it('uses continuous two-dimensional material detail, not repeating one-dimensional bands', () => {
    // The previous snowline detail was sin(px * 0.83 + py * 0.47), so its
    // apparent period depended on the grid resolution and repeated exactly.
    const oldPeriod = (2 * Math.PI) / (0.83 * 511);
    let alongX = 0;
    let alongY = 0;
    let oldPeriodMismatch = 0;
    for (let i = 0; i < 24; i++) {
      const u = 0.12 + i * 0.027;
      const v = 0.18 + i * 0.019;
      const value = alpineMaterialVariation(u, v);
      expect(Number.isFinite(value)).toBe(true);
      expect(Math.abs(value)).toBeLessThanOrEqual(1);
      expect(Math.abs(alpineMaterialVariation(u + 0.0001, v) - value)).toBeLessThan(0.02);
      expect(Math.abs(alpineMaterialVariation(u, v + 0.0001) - value)).toBeLessThan(0.02);
      alongX += Math.abs(alpineMaterialVariation(u + 0.012, v) - value);
      alongY += Math.abs(alpineMaterialVariation(u, v + 0.012) - value);
      oldPeriodMismatch += Math.abs(alpineMaterialVariation(u + oldPeriod, v) - value);
    }
    expect(alongX).toBeGreaterThan(0.15);
    expect(alongY).toBeGreaterThan(0.15);
    expect(oldPeriodMismatch).toBeGreaterThan(0.15);
  });

  it('encodes a flat surface as a flat OpenGL tangent normal, including borders', () => {
    const pixels = normalMapPixels(field(new Array(9).fill(0.5)), 1000, 250);
    for (let i = 0; i < pixels.length; i += 4)
      expect([...pixels.slice(i, i + 4)]).toEqual([128, 128, 255, 255]);
  });

  it('uses physical cell spacing and correct east/north normal orientation', () => {
    const eastRamp = field([0, 0.5, 1, 0, 0.5, 1, 0, 0.5, 1]);
    const northNormal = normalMapPixels(eastRamp, 100, 100);
    // A rise of100m over100m points the surface normal west at45 degrees.
    expect([...northNormal.slice(16, 20)]).toEqual([37, 128, 218, 255]);
    expect(sampleSlope(eastRamp, 1, 1, 100, 100).degrees).toBeCloseTo(45);
    const southRamp = field([0, 0, 0, 0.5, 0.5, 0.5, 1, 1, 1]);
    const pixels = normalMapPixels(southRamp, 100, 100);
    expect([...pixels.slice(16, 20)]).toEqual([128, 218, 218, 255]);
    // The one-sided boundary gradient is the same as the central one.
    expect([...pixels.slice(0, 4)]).toEqual([...pixels.slice(16, 20)]);
  });

  it('keeps height previews on the fixed export range instead of per-image normalization', () => {
    const heightField = field([0.25, 0.5, 0.75, 1]);
    const original = heightField.height.slice();
    const pixels = colorizeMap(heightField, 'height', 1000, 250);
    expect([...pixels.filter((_, i) => i % 4 === 0)]).toEqual([64, 128, 191, 255]);
    expect(heightField.height).toEqual(original);
  });

  it('handles an empty diagnostic channel without NaN or altering the input', () => {
    const heightField = field([0.25, 0.5, 0.75, 1]);
    for (const channel of ['flow', 'wear', 'deposition', 'terrain', 'slope'] as const) {
      const pixels = colorizeMap(heightField, channel, 1000, 250);
      expect(pixels.length).toBe(16);
      expect([...pixels].every(Number.isFinite)).toBe(true);
      expect([...pixels.filter((_, i) => i % 4 === 3)]).toEqual([255, 255, 255, 255]);
    }
    expect([...heightField.wear]).toEqual([0, 0, 0, 0]);
  });
});
