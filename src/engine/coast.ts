import { lowerParabolicEnvelope } from './distanceTransform';
import { smoothstep } from './noise';

export const COAST_DEFAULTS = {
  seaLevel: 0.18,
  beachWidth: 180,
  shelfWidth: 400,
  beachSlope: 4,
  shelfSlope: 2,
  strength: 0.85,
  includeLakes: false,
};

export type CoastSettings = typeof COAST_DEFAULTS & {
  worldSize: number;
  /** Physical north/south extent. Omitted for the legacy square Terrain domain. */
  worldDepth?: number;
  heightScale: number;
};

/** Fill below-level cells reachable from any tile edge via a shared side. */
function classifyWater(
  input: Float32Array,
  water: Float32Array,
  queue: Int32Array,
  n: number,
  level: number,
  includeLakes: boolean,
): number {
  let count = 0;
  if (includeLakes) {
    for (let i = 0; i < input.length; i++) {
      if (input[i] <= level) {
        water[i] = 1;
        count++;
      }
    }
    return count;
  }

  function enqueue(i: number) {
    if (water[i] === 0 && input[i] <= level) {
      water[i] = 1;
      queue[count++] = i;
    }
  }
  for (let p = 0; p < n; p++) {
    enqueue(p);
    enqueue((n - 1) * n + p);
    enqueue(p * n);
    enqueue(p * n + n - 1);
  }
  for (let head = 0; head < count; head++) {
    const i = queue[head];
    const x = i % n;
    if (x > 0) enqueue(i - 1);
    if (x + 1 < n) enqueue(i + 1);
    if (i >= n) enqueue(i - n);
    if (i + n < input.length) enqueue(i + n);
  }
  return count;
}

/**
 * Squared Euclidean distance to all waterline crossings on horizontal or
 * vertical grid edges. Interpolate each crossing on the source heights. First
 * find the closest crossing along each scanline, then minimize along the
 * perpendicular axis. Every pass is linear in the number of samples.
 */
function distancesToCrossings(
  input: Float32Array,
  water: Float32Array,
  n: number,
  level: number,
  horizontal: boolean,
  distances: Float32Array,
  depthRatio: number,
): void {
  const stride = horizontal ? 1 : n;
  const lineStep = horizontal ? n : 1;
  const alongWeight = horizontal ? 1 : depthRatio * depthRatio;
  const acrossWeight = horizontal ? depthRatio * depthRatio : 1;
  const missing = 4 * n * n * Math.max(1, depthRatio * depthRatio);
  for (let line = 0; line < n; line++) {
    const start = line * lineStep;
    let crossing = -Infinity;
    for (let p = 0; p < n; p++) {
      const i = start + p * stride;
      if (p > 0 && water[i] !== water[i - stride]) {
        const before = input[i - stride];
        crossing = p - 1 + (level - before) / (input[i] - before);
      }
      distances[i] = Math.min(missing, (p - crossing) ** 2 * alongWeight);
    }
    crossing = Infinity;
    for (let p = n - 1; p >= 0; p--) {
      const i = start + p * stride;
      if (p + 1 < n && water[i] !== water[i + stride]) {
        crossing = p + (level - input[i]) / (input[i + stride] - input[i]);
      }
      distances[i] = Math.min(distances[i], (crossing - p) ** 2 * alongWeight);
    }
  }

  const costs = new Float64Array(n);
  const result = new Float64Array(n);
  const sites = new Int32Array(n);
  const bounds = new Float64Array(n + 1);
  for (let line = 0; line < n; line++) {
    const start = line * stride;
    for (let p = 0; p < n; p++) costs[p] = distances[start + p * lineStep];
    lowerParabolicEnvelope(costs, result, sites, bounds, acrossWeight);
    for (let p = 0; p < n; p++) distances[start + p * lineStep] = result[p];
  }
}

/**
 * Grade a dry beach and submerged shelf in project meters. Profile targets
 * stay on their original side of sea level, preserving water connectivity.
 * Unselected inland depressions retain their original elevations. The two
 * distance rasters and flood queue reuse output storage (12 bytes/cell plus
 * O(n) line work), independent of shoreline complexity or shelf width.
 */
export function shapeCoast(input: Float32Array, n: number, settings: CoastSettings) {
  if (!Number.isInteger(n) || n < 2 || n > 2048 || input.length !== n * n) {
    throw new Error('Coastal shaping needs a square terrain with 2–2048 samples per side.');
  }
  const depth = settings.worldDepth ?? settings.worldSize;
  if (
    ![settings.worldSize, depth, settings.heightScale].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  ) {
    throw new Error('Coastal shaping needs positive terrain dimensions in meters.');
  }
  const level = Math.fround(settings.seaLevel);
  const height = new Float32Array(input.length);
  const shore = new Float32Array(input.length);
  const water = new Float32Array(input.length);
  const wetCount = classifyWater(
    input,
    water,
    new Int32Array(height.buffer),
    n,
    level,
    settings.includeLakes,
  );
  if (
    wetCount === 0 ||
    wetCount === input.length ||
    (settings.beachWidth === 0 && settings.shelfWidth === 0)
  ) {
    height.set(input);
    return { height, shore, water };
  }

  const depthRatio = depth / settings.worldSize;
  distancesToCrossings(input, water, n, level, true, height, depthRatio);
  distancesToCrossings(input, water, n, level, false, shore, depthRatio);

  const cellMeters = settings.worldSize / (n - 1);
  // Leave at least one Float32 increment above the level for dry samples.
  const dryFloor = level + Math.max(2 ** -149, Math.abs(level) * 2 ** -23);
  const beachGrade = Math.tan((settings.beachSlope * Math.PI) / 180) / settings.heightScale;
  const shelfGrade = -Math.tan((settings.shelfSlope * Math.PI) / 180) / settings.heightScale;
  for (let i = 0; i < input.length; i++) {
    const distance = Math.sqrt(Math.min(height[i], shore[i])) * cellMeters;
    const wet = water[i] === 1;
    const width = wet ? settings.shelfWidth : settings.beachWidth;
    shore[i] = 0;
    height[i] = input[i];
    if (distance >= width || (!wet && input[i] <= level)) continue;

    // A constant-grade beach or shelf along the waterline, with a smooth
    // return to the authored relief over the outer half of the band.
    const influence = 1 - smoothstep(width * 0.5, width, distance);
    shore[i] = influence;
    const target = wet
      ? level + distance * shelfGrade
      : Math.max(Math.min(input[i], dryFloor), level + distance * beachGrade);
    const weight = influence * settings.strength;
    height[i] = (1 - weight) * input[i] + weight * target;
  }
  return { height, shore, water };
}
