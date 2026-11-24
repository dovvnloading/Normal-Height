import { clamp, spatialHash } from './math';

export type CellMetric = 'euclidean' | 'manhattan' | 'chebyshev';
export interface CellSample {
  f1: number;
  f2: number;
  id: number;
  edge: number;
}

function distance(x: number, y: number, metric: CellMetric): number {
  if (metric === 'manhattan') return Math.abs(x) + Math.abs(y);
  if (metric === 'chebyshev') return Math.max(Math.abs(x), Math.abs(y));
  return Math.hypot(x, y);
}

/** Distance to a candidate cell's possible feature-point support. */
function supportDistance(
  x: number,
  y: number,
  cx: number,
  cy: number,
  halfJitter: number,
  metric: CellMetric,
): number {
  return distance(
    Math.max(0, Math.abs(x - cx - 0.5) - halfJitter),
    Math.max(0, Math.abs(y - cy - 0.5) - halfJitter),
    metric,
  );
}

/**
 * One seeded point per cell, confined to its cell for jitter in [0, 1].
 * Search terminates from a geometric lower bound, never an assumed 3x3 window.
 * The optional edge is the true Euclidean distance to the nearest Voronoi
 * boundary, computed from perpendicular bisectors; it is not F2-F1.
 */
export function cellularSample(
  seed: number,
  x: number,
  y: number,
  jitter = 1,
  metric: CellMetric = 'euclidean',
  withEdge = false,
): CellSample {
  jitter = clamp(jitter);
  const half = jitter * 0.5;
  const ix = Math.floor(x),
    iy = Math.floor(y);
  let f1 = Infinity,
    f2 = Infinity,
    id = 0;
  let nearestX = 0,
    nearestY = 0,
    cellX = 0,
    cellY = 0;
  // At worst, the nearest two points are within the 7x7 neighborhood for
  // these metrics. The exterior lower bound usually stops at radius 1 or 2.
  for (let radius = 0; radius <= 3; radius++) {
    for (let dy = -radius; dy <= radius; dy++)
      for (let dx = -radius; dx <= radius; dx++) {
        if (radius > 0 && Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
        const cx = ix + dx,
          cy = iy + dy;
        if (supportDistance(x, y, cx, cy, half, metric) > f2) continue;
        const px = cx + 0.5 + (spatialHash(seed, cx, cy, 1) - 0.5) * jitter;
        const py = cy + 0.5 + (spatialHash(seed, cx, cy, 2) - 0.5) * jitter;
        const d = distance(px - x, py - y, metric);
        if (d < f1) {
          f2 = f1;
          f1 = d;
          nearestX = px;
          nearestY = py;
          cellX = cx;
          cellY = cy;
          id = spatialHash(seed, cx, cy, 3);
        } else if (d < f2) f2 = d;
      }
    // Distance to any possible point beyond the square we have searched.
    const outside = radius + 1 - half - Math.max(Math.abs(x - ix - 0.5), Math.abs(y - iy - 0.5));
    if (outside > f2) break;
  }
  if (!withEdge) return { f1, f2, id, edge: 0 };

  // Recompute the closest point with Euclidean metric if requested with a
  // different metric. A Voronoi bisector is meaningful only for Euclidean sites.
  if (metric !== 'euclidean')
    return { f1, f2, id, edge: cellularSample(seed, x, y, jitter, 'euclidean', true).edge };
  let edge = Infinity;
  const closest = Math.hypot(nearestX - x, nearestY - y);
  for (let radius = 0; radius <= 5; radius++) {
    for (let dy = -radius; dy <= radius; dy++)
      for (let dx = -radius; dx <= radius; dx++) {
        if (radius > 0 && Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
        const cx = ix + dx,
          cy = iy + dy;
        if (cx === cellX && cy === cellY) continue;
        // Triangle inequality gives a lower bound on bisector distance.
        if ((supportDistance(x, y, cx, cy, half, 'euclidean') - closest) * 0.5 > edge) continue;
        const px = cx + 0.5 + (spatialHash(seed, cx, cy, 1) - 0.5) * jitter;
        const py = cy + 0.5 + (spatialHash(seed, cx, cy, 2) - 0.5) * jitter;
        const sx = px - nearestX,
          sy = py - nearestY;
        const norm = Math.hypot(sx, sy);
        if (norm < 1e-12) continue;
        const bisector =
          (((nearestX + px) * 0.5 - x) * sx) / norm + (((nearestY + py) * 0.5 - y) * sy) / norm;
        edge = Math.min(edge, Math.max(0, bisector));
      }
    const outside = radius + 1 - half - Math.max(Math.abs(x - ix - 0.5), Math.abs(y - iy - 0.5));
    if ((outside - closest) * 0.5 > edge) break;
  }
  return { f1, f2, id, edge };
}

/**
 * Symmetric compact quadratic smooth minimum. Solve sum(max(s-d_i,0)^2)=k^2
 * and return s-k. This is order-independent and C1 across site contributions;
 * unlike a sequence of pairwise smooth-mins it has no grid-boundary ordering seam.
 */
export function smoothCellular(
  seed: number,
  x: number,
  y: number,
  jitter: number,
  metric: CellMetric,
  softness: number,
): number {
  jitter = clamp(jitter);
  const ix = Math.floor(x),
    iy = Math.floor(y),
    half = jitter * 0.5;
  let minimum = Infinity;
  const k = clamp(softness, 0, 1);
  if (k === 0) return cellularSample(seed, x, y, jitter, metric).f1;
  const sites: number[] = [];
  for (let dy = -3; dy <= 3; dy++)
    for (let dx = -3; dx <= 3; dx++) {
      const cx = ix + dx,
        cy = iy + dy;
      if (supportDistance(x, y, cx, cy, half, metric) > minimum + k) continue;
      const px = cx + 0.5 + (spatialHash(seed, cx, cy, 1) - 0.5) * jitter;
      const py = cy + 0.5 + (spatialHash(seed, cx, cy, 2) - 0.5) * jitter;
      const d = distance(px - x, py - y, metric);
      minimum = Math.min(minimum, d);
      sites.push(d);
    }
  sites.sort((a, b) => a - b);
  let sum = sites[0],
    squares = sites[0] * sites[0],
    count = 1;
  let s = sites[0] + k;
  for (let i = 1; i < sites.length && sites[i] < s; i++) {
    const d = sites[i];
    sum += d;
    squares += d * d;
    count++;
    s = (sum + Math.sqrt(Math.max(0, sum * sum - count * (squares - k * k)))) / count;
  }
  return s - k;
}
