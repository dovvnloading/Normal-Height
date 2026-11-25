import { sampleWorldProbe, worldGridBounds } from './worldViewMath';
import type { WorldRegion, WorldSnapshot } from './worldViewMath';

export interface WorldAnalysis {
  count: number;
  min: number;
  max: number;
  mean: number;
  meanSlope: number;
  maxSlope: number;
  histogram: number[];
}

/** Inspect only real completed samples. Selection statistics never extrapolate
 * a refined field beyond its physical footprint. */
export function analyzeWorld(
  snapshot: WorldSnapshot,
  region?: WorldRegion | null,
): WorldAnalysis | null {
  const { result: field, world, grid } = snapshot;
  const area = region ?? grid;
  const x0 = Math.max(
    0,
    Math.ceil(((area.startX - grid.startX) / grid.cellsX) * (field.width - 1)),
  );
  const z0 = Math.max(
    0,
    Math.ceil(((area.startZ - grid.startZ) / grid.cellsZ) * (field.height - 1)),
  );
  const x1 = Math.min(
    field.width - 1,
    Math.floor(((area.startX + area.cellsX - grid.startX) / grid.cellsX) * (field.width - 1)),
  );
  const z1 = Math.min(
    field.height - 1,
    Math.floor(((area.startZ + area.cellsZ - grid.startZ) / grid.cellsZ) * (field.height - 1)),
  );
  if (x0 > x1 || z0 > z1) return null;
  let min = Infinity,
    max = -Infinity,
    sum = 0,
    count = 0,
    slopeSum = 0,
    maxSlope = 0;
  const h = (x: number, z: number) =>
    field.heights[z * field.width + x] * world.domain.heightScale + world.domain.datum;
  for (let z = z0; z <= z1; z++)
    for (let x = x0; x <= x1; x++) {
      const value = h(x, z);
      if (!Number.isFinite(value)) continue;
      min = Math.min(min, value);
      max = Math.max(max, value);
      sum += value;
      count++;
      const left = Math.max(0, x - 1),
        right = Math.min(field.width - 1, x + 1);
      const north = Math.max(0, z - 1),
        south = Math.min(field.height - 1, z + 1);
      const dx = (h(right, z) - h(left, z)) / Math.max(1e-12, (right - left) * field.spacingX);
      const dz = (h(x, south) - h(x, north)) / Math.max(1e-12, (south - north) * field.spacingZ);
      const slope = (Math.atan(Math.hypot(dx, dz)) * 180) / Math.PI;
      slopeSum += slope;
      maxSlope = Math.max(maxSlope, slope);
    }
  if (!count) return null;
  const histogram = Array<number>(24).fill(0),
    span = Math.max(1e-12, max - min);
  for (let z = z0; z <= z1; z++)
    for (let x = x0; x <= x1; x++) {
      const value = h(x, z);
      if (Number.isFinite(value))
        histogram[Math.min(23, Math.max(0, Math.floor(((value - min) / span) * 24)))]++;
    }
  return { count, min, max, mean: sum / count, meanSlope: slopeSum / count, maxSlope, histogram };
}

export interface WorldProfilePoint {
  distance: number;
  elevation: number;
}
export function worldElevationProfile(
  snapshot: WorldSnapshot,
  region?: WorldRegion | null,
  axis: 'x' | 'z' = 'x',
  samples = 80,
): WorldProfilePoint[] {
  const bounds = worldGridBounds(snapshot.world, region ?? snapshot.grid);
  const length = axis === 'x' ? bounds.width : bounds.depth;
  const count = Math.max(2, Math.min(512, Math.round(samples)));
  const points: WorldProfilePoint[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const probe = sampleWorldProbe(
      snapshot,
      bounds.x + bounds.width * (axis === 'x' ? t : 0.5),
      bounds.z + bounds.depth * (axis === 'z' ? t : 0.5),
    );
    if (probe) points.push({ distance: t * length, elevation: probe.elevation });
  }
  return points;
}

export function snapshotContainsRegion(snapshot: WorldSnapshot, region: WorldRegion) {
  const grid = snapshot.grid;
  return (
    region.startX >= grid.startX &&
    region.startZ >= grid.startZ &&
    region.startX + region.cellsX <= grid.startX + grid.cellsX &&
    region.startZ + region.cellsZ <= grid.startZ + grid.cellsZ
  );
}
