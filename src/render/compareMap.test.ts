import { describe, expect, it } from 'vitest';
import { buildDifferenceMap } from './compareMap';

describe('physical terrain difference maps', () => {
  it('computes zero differences from equal fields at different grid resolutions', () => {
    const current = Float32Array.from([0, .5, .5, 1]);
    const baseline = Float32Array.from([
      0, .25, .5,
      .25, .5, .75,
      .5, .75, 1,
    ]);
    const result = buildDifferenceMap({
      current, baseline, currentSize: 2, baselineSize: 3,
      currentScale: 100, baselineScale: 100, worldSize: 100, outputSize: 8,
    });
    expect(result.maxAbs).toBeLessThan(0.00001);
    expect(result.cutVolumeM3).toBeCloseTo(0, 3);
    expect(result.fillVolumeM3).toBeCloseTo(0, 3);
    expect(Array.from(result.pixels.slice(0, 4))).toEqual([39, 53, 48, 255]);
  });

  it('integrates constant positive elevation changes over the correct physical area', () => {
    const result = buildDifferenceMap({
      current: new Float32Array(4).fill(1),
      baseline: new Float32Array(4),
      currentSize: 2, baselineSize: 2, currentScale: 3,
      baselineScale: 3, worldSize: 200, outputSize: 16,
    });
    expect(result.maxAbs).toBe(3);
    expect(result.minDelta).toBe(3);
    expect(result.maxDelta).toBe(3);
    expect(result.fillVolumeM3).toBeCloseTo(3 * 200 * 200, 5);
    expect(result.cutVolumeM3).toBe(0);
  });

  it('distinguishes cut from fill using a signed comparison', () => {
    const positive = buildDifferenceMap({
      current: new Float32Array(4).fill(.2),
      baseline: new Float32Array(4).fill(.5),
      currentSize: 2, baselineSize: 2,
      currentScale: 10, baselineScale: 10, worldSize: 20, outputSize: 4,
    });
    expect(positive.minDelta).toBeCloseTo(-3);
    expect(positive.cutVolumeM3).toBeCloseTo(1200);
    expect(positive.fillVolumeM3).toBe(0);
    expect(positive.pixels[0]).toBeGreaterThan(positive.pixels[2]);
  });

  it('rejects a grid shape or unphysical comparison dimensions', () => {
    const input = {
      current: new Float32Array(4), baseline: new Float32Array(4),
      currentSize: 2, baselineSize: 2, currentScale: 1,
      baselineScale: 1, worldSize: 10, outputSize: 4,
    };
    expect(() => buildDifferenceMap({ ...input, baselineSize: 3 })).toThrow();
    expect(() => buildDifferenceMap({ ...input, worldSize: 0 })).toThrow();
  });
});
