import { describe, expect, it } from 'vitest';
import {
  analyzeWorld,
  snapshotContainsRegion,
  worldElevationProfile,
} from '../src/components/world/worldAnalysis';
import type { WorldSnapshot } from '../src/components/world/worldViewMath';
import { createWorldDefinition } from '../src/model/world';

function plane(): WorldSnapshot {
  const world = createWorldDefinition({ worldSize: 4, heightScale: 2 });
  world.domain.cellsX = world.domain.cellsZ = 4;
  world.domain.datum = 100;
  const heights = Float32Array.from({ length: 25 }, (_, i) => i % 5);
  const empty = new Float32Array(25);
  return {
    world,
    grid: { startX: 0, startZ: 0, cellsX: 4, cellsZ: 4, samplesX: 5, samplesZ: 5 },
    result: {
      width: 5,
      height: 5,
      heights,
      flow: empty,
      wear: empty,
      deposition: empty,
      min: 0,
      max: 4,
      stages: [],
      spacingX: 1,
      spacingZ: 1,
      duration: 0,
      backend: 'cpu-reference',
      estimatedPeakBytes: 0,
    },
  };
}
describe('world physical analysis', () => {
  it('measures actual elevation, slope and all histogram samples', () => {
    const stats = analyzeWorld(plane())!;
    expect(stats).toMatchObject({ min: 100, max: 108, mean: 104, count: 25 });
    expect(stats.meanSlope).toBeCloseTo((Math.atan(2) * 180) / Math.PI, 10);
    expect(stats.histogram.reduce((a, b) => a + b)).toBe(25);
  });
  it('constrains statistics to a selection and does not extrapolate disjoint regions', () => {
    expect(analyzeWorld(plane(), { startX: 1, startZ: 1, cellsX: 2, cellsZ: 2 })).toMatchObject({
      min: 102,
      max: 106,
      count: 9,
    });
    expect(analyzeWorld(plane(), { startX: 6, startZ: 0, cellsX: 1, cellsZ: 1 })).toBeNull();
    expect(snapshotContainsRegion(plane(), { startX: 0, startZ: 0, cellsX: 8, cellsZ: 4 })).toBe(
      false,
    );
  });
  it('profiles use metres and datum, independent of display exaggeration', () => {
    const profile = worldElevationProfile(plane(), null, 'x', 5);
    expect(profile).toEqual(
      [100, 102, 104, 106, 108].map((elevation, distance) => ({ elevation, distance })),
    );
    expect(worldElevationProfile(plane(), null, 'z', 5).map((p) => p.elevation)).toEqual([
      104, 104, 104, 104, 104,
    ]);
  });
});
