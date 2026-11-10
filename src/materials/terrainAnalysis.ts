import type { HeightField, TerrainProject } from '../model/types';

/**
 * Spatial scales are distances on the terrain, not texture pixels. A radius
 * contributes only when it spans at least two source cells (Nyquist guard).
 * Reusing the AO horizons for landform analysis avoids a second texture-sized
 * set of intermediate arrays at 2K.
 */
export const AO_RADII_METERS = [50, 150, 425] as const;

const clamp = (value: number, low = 0, high = 1) =>
  Math.min(high, Math.max(low, value));

export interface TerrainFactors {
  /** Tangent of the physical slope, in meters per meter. */
  grade: number;
  slopeDegrees: number;
  /** -1 = south-facing, +1 = north-facing; zero on flats. */
  northness: number;
  /** Positive in valleys; negative on convex crests. Dimensionless. */
  landform: number;
  /** Horizon-corrected local ambient occlusion, in [0, 1]. */
  occlusion: number;
}

/** Bilinear sampling in pixel coordinates; fractional radii retain world scale. */
function elevationAt(height: Float32Array, n: number, x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const tx = x - x0, ty = y - y0;
  const i = y0 * n + x0;
  const nx = x0 < n - 1 ? 1 : 0;
  const ny = y0 < n - 1 ? n : 0;
  const a = height[i] + (height[i + nx] - height[i]) * tx;
  const b = height[i + ny] + (height[i + ny + nx] - height[i + ny]) * tx;
  return a + (b - a) * ty;
}

/**
 * A robust scale for *relative* erosion diagnostics. The particle solver's
 * wear/deposition units are not calibrated soil depths; fixed thresholds would
 * silently change their significance across very different terrain projects.
 *
 * This streaming logarithmic histogram approximates the 90th percentile of
 * positive samples, with constant 64-bin memory and no sorting/copies.
 */
export function diagnosticReference(values: Float32Array): number {
  const bins = new Uint32Array(64);
  let positives = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) throw new Error('Invalid erosion diagnostic for PBR synthesis.');
    if (value <= 0) continue;
    const index = Math.min(63, Math.max(0, Math.floor((Math.log10(value) + 8) * 6.4)));
    bins[index]++;
    positives++;
  }
  if (positives === 0) return 1;
  const target = Math.ceil(positives * 0.9);
  let total = 0;
  for (let i = 0; i < bins.length; i++) {
    total += bins[i];
    if (total >= target) return 10 ** (-8 + (i + 1) / 6.4);
  }
  return 1;
}

/**
 * Local physical slope, north/south aspect, signed multi-scale landform and
 * plane-corrected horizon occlusion. On an affine tilted plane every symmetric
 * height residual is zero; a valley has positive residual and a ridge negative.
 *
 * At the tile border only complete +/- pairs are considered for curvature,
 * avoiding artificial valleys where out-of-bounds samples would be clamped.
 * A caller can reuse 'out' for every pixel to avoid per-pixel object allocation.
 */
export function createTerrainAnalyzer(field: HeightField, project: TerrainProject) {
  const n = field.resolution;
  const heights = field.height;
  const cell = project.worldSize / (n - 1);
  const scale = project.heightScale;
  return (x: number, y: number, out: TerrainFactors = {
    grade: 0, slopeDegrees: 0, northness: 0, landform: 0, occlusion: 1,
  }): TerrainFactors => {
    const i = y * n + x;
    const l = Math.max(0, x - 1), r = Math.min(n - 1, x + 1);
    const t = Math.max(0, y - 1), b = Math.min(n - 1, y + 1);
    const gx = (heights[y * n + r] - heights[y * n + l]) * scale / ((r - l || 1) * cell);
    const gy = (heights[b * n + x] - heights[t * n + x]) * scale / ((b - t || 1) * cell);
    const grade = Math.hypot(gx, gy);
    const h = heights[i] * scale;
    let horizon = 0, landform = 0, landformWeight = 0;

    for (const meters of AO_RADII_METERS) {
      const radius = meters / cell;
      if (radius < 2) continue; // no inventing sub-Nyquist topographic features
      // Both directions must be present for curvature to cancel a plane.
      const weight = Math.sqrt(AO_RADII_METERS[0] / meters);
      if (x >= radius && x + radius <= n - 1) {
        const plus = elevationAt(heights, n, x + radius, y) * scale - h - gx * meters;
        const minus = elevationAt(heights, n, x - radius, y) * scale - h + gx * meters;
        horizon += clamp(plus / meters * 1.8) + clamp(minus / meters * 1.8);
        landform += (plus + minus) / (2 * meters) * weight;
        landformWeight += weight;
      }
      if (y >= radius && y + radius <= n - 1) {
        const plus = elevationAt(heights, n, x, y + radius) * scale - h - gy * meters;
        const minus = elevationAt(heights, n, x, y - radius) * scale - h + gy * meters;
        horizon += clamp(plus / meters * 1.8) + clamp(minus / meters * 1.8);
        landform += (plus + minus) / (2 * meters) * weight;
        landformWeight += weight;
      }
    }
    out.grade = grade;
    out.slopeDegrees = Math.atan(grade) * 180 / Math.PI;
    // Rows increase southward. A downhill-facing-north surface climbs south.
    out.northness = grade > 1e-7 ? gy / grade : 0;
    out.landform = landformWeight ? landform / landformWeight : 0;
    out.occlusion = clamp(1 - 2.2 * horizon / (AO_RADII_METERS.length * 4), 0.45, 1);
    return out;
  };
}
