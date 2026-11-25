import { describe, expect, it } from 'vitest';
import { cellularSample, smoothCellular, type CellMetric } from './cellular';
import { hash32, spatialHash } from './math';

interface Site { x: number; y: number; distance: number; id: number }
const metrics: CellMetric[] = ['euclidean', 'manhattan', 'chebyshev'];

/**
 * Independent geometric oracle: enumerate and sort a deliberately wider 15x15
 * neighborhood. Share only feature generation, never search/pruning logic.
 */
function wideSites(seed: number, x: number, y: number, jitter: number, metric: CellMetric): Site[] {
  const sites: Site[] = [];
  for (let cy = Math.floor(y) - 7; cy <= Math.floor(y) + 7; cy++) {
    for (let cx = Math.floor(x) - 7; cx <= Math.floor(x) + 7; cx++) {
      const sx = cx + 0.5 + jitter * (spatialHash(seed, cx, cy, 1) - 0.5);
      const sy = cy + 0.5 + jitter * (spatialHash(seed, cx, cy, 2) - 0.5);
      const dx = Math.abs(sx - x), dy = Math.abs(sy - y);
      const distance = metric === 'euclidean' ? Math.sqrt(dx * dx + dy * dy)
        : metric === 'manhattan' ? dx + dy : Math.max(dx, dy);
      sites.push({ x: sx, y: sy, distance, id: spatialHash(seed, cx, cy, 3) });
    }
  }
  return sites.sort((a, b) => a.distance - b.distance);
}

function wideEdge(sites: Site[]): number {
  const a = sites[0];
  let closest = Infinity;
  for (let i = 1; i < sites.length; i++) {
    const b = sites[i];
    const separation = Math.hypot(a.x - b.x, a.y - b.y);
    if (separation === 0) continue;
    // Squared distance difference is independent of the implementation's
    // midpoint/dot-product formula and its triangle-inequality pruning.
    closest = Math.min(closest, (b.distance ** 2 - a.distance ** 2) / (2 * separation));
  }
  return closest;
}

function wideSmooth(sites: Site[], softness: number): number {
  // Independent bisection of the implicit blend equation; the engine uses a
  // sorted active-set quadratic solution.
  let low = sites[0].distance, high = low + softness;
  for (let iteration = 0; iteration < 55; iteration++) {
    const mid = (low + high) * 0.5;
    let total = 0;
    for (const site of sites) total += Math.max(0, mid - site.distance) ** 2;
    if (total > softness ** 2) high = mid;
    else low = mid;
  }
  return (low + high) * 0.5 - softness;
}

describe('Studio cellular geometry against a wide independent oracle', () => {
  for (const metric of metrics) {
    it(`finds nearest sites and values for ${metric} at all jitter limits`, () => {
      for (const jitter of [0, 0.53, 1]) {
        for (let index = 0; index < 240; index++) {
          const seed = hash32(index * 99391);
          const x = (spatialHash(seed, index, 0) - 0.5) * 40;
          const y = (spatialHash(seed, index, 1) - 0.5) * 40;
          const sites = wideSites(seed, x, y, jitter, metric);
          const result = cellularSample(seed, x, y, jitter, metric, metric === 'euclidean');
          expect(result.f1).toBeCloseTo(sites[0].distance, 12);
          expect(result.f2).toBeCloseTo(sites[1].distance, 12);
          // At exact ties either equally close site's ID is geometrically valid.
          expect(sites.some(site => site.id === result.id && Math.abs(site.distance - sites[0].distance) < 1e-12)).toBe(true);
          if (metric === 'euclidean') expect(result.edge).toBeCloseTo(wideEdge(sites), 12);
        }
      }
    });

    it(`remains correct across negative and positive cell boundaries for ${metric}`, () => {
      for (const boundary of [-17, -1, 0, 1, 31]) {
        for (const delta of [-1e-9, 0, 1e-9]) {
          for (const jitter of [0, 0.1, 1]) {
            const x = boundary + delta, y = -boundary + 0.271;
            const sites = wideSites(0xffffffff, x, y, jitter, metric);
            const result = cellularSample(0xffffffff, x, y, jitter, metric, metric === 'euclidean');
            expect(result.f1).toBeCloseTo(sites[0].distance, 12);
            expect(result.f2).toBeCloseTo(sites[1].distance, 12);
            if (metric === 'euclidean') expect(result.edge).toBeCloseTo(wideEdge(sites), 12);
          }
        }
      }
    });
  }

  it('includes a second-nearest site outside the initial 3x3 neighborhood', () => {
    const result = cellularSample(357776260, -12.732245121051209, 10.958899715915322, 1, 'manhattan');
    // The winning second site is in cell (-13, 12), two rows from the query.
    expect(result.f1).toBeCloseTo(0.970207484571846, 13);
    expect(result.f2).toBeCloseTo(1.1528879442320896, 13);
  });

  it('continues the boundary search after F1 and F2 have been found', () => {
    const result = cellularSample(1166048181, 8.827889962121844, 9.239692389965057, 1, 'euclidean', true);
    expect(result.edge).toBeCloseTo(0.07161623429217648, 13);
    expect(result.edge).not.toBeCloseTo(result.f2 - result.f1, 3);
  });

  it('returns the actual Euclidean boundary distance on a regular lattice', () => {
    const center = cellularSample(1234, 0.5, 0.5, 0, 'euclidean', true);
    expect(center.f1).toBe(0);
    expect(center.f2).toBe(1);
    expect(center.edge).toBe(0.5);
    expect(cellularSample(1234, 0.75, 0.8, 0, 'euclidean', true).edge).toBeCloseTo(0.2, 14);
    expect(cellularSample(1234, -1, 0.7, 0, 'euclidean', true).edge).toBe(0);
  });

  it('uses Euclidean boundary geometry independently of the distance-output metric', () => {
    for (const metric of metrics) {
      const result = cellularSample(72, -0.34, 0.77, 0.8, metric, true);
      const euclidean = wideSites(72, -0.34, 0.77, 0.8, 'euclidean');
      expect(result.edge).toBeCloseTo(wideEdge(euclidean), 13);
    }
  });
});

describe('symmetric smooth cellular blending', () => {
  for (const metric of metrics) {
    it(`matches the independently solved implicit blend for ${metric}`, () => {
      for (const seed of [0, 1234567, 0xffffffff]) {
        for (const jitter of [0, 0.43, 1]) {
          for (const softness of [0.01, 0.4, 1]) {
            const x = -1.127, y = 2.383;
            const sites = wideSites(seed, x, y, jitter, metric);
            const expected = wideSmooth(sites, softness);
            expect(smoothCellular(seed, x, y, jitter, metric, softness)).toBeCloseTo(expected, 11);
          }
        }
      }
    });

    it(`has no evaluation-window seam and reduces exactly to F1 at zero softness for ${metric}`, () => {
      const epsilon = 1e-7;
      for (const boundary of [-8, -1, 0, 1, 9]) {
        const left = smoothCellular(0x87654321, boundary - epsilon, 0.238, 1, metric, 1);
        const right = smoothCellular(0x87654321, boundary + epsilon, 0.238, 1, metric, 1);
        // Each distance is 1-Lipschitz along an axis; so is this smooth blend.
        expect(Math.abs(left - right)).toBeLessThan(2.1 * epsilon);
        expect(smoothCellular(17, boundary + 0.37, -0.681, 0.73, metric, 0))
          .toBe(cellularSample(17, boundary + 0.37, -0.681, 0.73, metric).f1);
      }
    });
  }

  it('clamps jitter consistently for feature support and generated positions', () => {
    for (const metric of metrics) {
      for (const [input, clamped] of [[-3, 0], [4, 1]]) {
        expect(cellularSample(77, -0.22, 0.91, input, metric, true))
          .toEqual(cellularSample(77, -0.22, 0.91, clamped, metric, true));
        expect(smoothCellular(77, -0.22, 0.91, input, metric, 0.6))
          .toBe(smoothCellular(77, -0.22, 0.91, clamped, metric, 0.6));
      }
    }
  });
});
