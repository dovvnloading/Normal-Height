import type { HeightField, TerrainProject } from '../model/types';
import { heightFieldGrid, type FieldGrid } from '../engine/fields';

/**
 * Spatial scales are distances on the terrain, not texture pixels. A radius
 * contributes only when it spans at least two source cells (Nyquist guard).
 * Reusing the AO horizons for landform analysis avoids a second texture-sized
 * set of intermediate arrays at 2K.
 */
export const AO_RADII_METERS = [50, 150, 425] as const;

const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));

export interface TerrainFactors {
  /** Tangent of the physical slope, in meters per meter. */
  grade: number;
  /** Eastward and southward physical height gradients (m/m). */
  gradientX: number;
  gradientY: number;
  slopeDegrees: number;
  /** -1 = south-facing, +1 = north-facing; zero on flats. */
  northness: number;
  /** Positive in valleys; negative on convex crests. Dimensionless. */
  landform: number;
  /** Horizon-corrected local ambient occlusion, in [0, 1]. */
  occlusion: number;
}

/** Bilinear sampling in pixel coordinates; fractional radii retain world scale. */
function elevationAt(height: Float32Array, n: number, rows: number, x: number, y: number): number {
  const x0 = Math.floor(x),
    y0 = Math.floor(y);
  const tx = x - x0,
    ty = y - y0;
  const i = y0 * n + x0;
  const nx = x0 < n - 1 ? 1 : 0;
  const ny = y0 < rows - 1 ? n : 0;
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
export function createDiagnosticAccumulator() {
  const bins = new Uint32Array(64);
  let positives = 0;
  return {
    add(value: number) {
      if (!Number.isFinite(value)) throw new Error('Invalid erosion diagnostic for PBR synthesis.');
      if (value <= 0) return;
      const index = Math.min(63, Math.max(0, Math.floor((Math.log10(value) + 8) * 6.4)));
      bins[index]++;
      positives++;
    },
    reference() {
      if (positives === 0) return 1;
      const target = Math.ceil(positives * 0.9);
      let total = 0;
      for (let i = 0; i < bins.length; i++) {
        total += bins[i];
        if (total >= target) return 10 ** (-8 + (i + 1) / 6.4);
      }
      return 1;
    },
  };
}

export function diagnosticReference(values: Float32Array): number {
  const accumulator = createDiagnosticAccumulator();
  for (const value of values) accumulator.add(value);
  return accumulator.reference();
}

/**
 * Twice the cosine-weighted blocked irradiance along a vertical azimuth slice,
 * before normal normalization. Integrate (sin(e) - t cos(e)) cos(e) from
 * the local tangent atan(t) to the maximum sampled horizon atan(h).
 */
function blockedSlice(t: number, h: number): number {
  if (h <= t) return 0;
  return (h * (h - t)) / (1 + h * h) - t * Math.atan2(h - t, 1 + h * t);
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
export function createTerrainAnalyzer(
  field: HeightField,
  project: TerrainProject,
  geometry?: FieldGrid,
) {
  const grid = geometry ?? heightFieldGrid(field, project);
  const n = grid.width,
    rows = grid.height;
  const heights = field.height;
  const cellX = grid.spacingX,
    cellZ = grid.spacingZ;
  const scale = grid.heightScale;
  const diag = Math.SQRT1_2;
  const axes = [
    [1, 0],
    [diag, diag],
    [0, 1],
    [-diag, diag],
  ].map(([ux, uy]) => ({
    ux,
    uy,
    probes: AO_RADII_METERS.filter((m) => m / Math.max(cellX, cellZ) >= 2).map((m) => ({
      dx: (ux * m) / cellX,
      dy: (uy * m) / cellZ,
      invMeters: 1 / m,
      weight: Math.sqrt(AO_RADII_METERS[0] / m),
    })),
  }));
  return (
    x: number,
    y: number,
    out: TerrainFactors = {
      grade: 0,
      gradientX: 0,
      gradientY: 0,
      slopeDegrees: 0,
      northness: 0,
      landform: 0,
      occlusion: 1,
    },
  ): TerrainFactors => {
    const i = y * n + x;
    const l = Math.max(0, x - 1),
      r = Math.min(n - 1, x + 1);
    const t = Math.max(0, y - 1),
      b = Math.min(rows - 1, y + 1);
    const gx = ((heights[y * n + r] - heights[y * n + l]) * scale) / ((r - l || 1) * cellX);
    const gy = ((heights[b * n + x] - heights[t * n + x]) * scale) / ((b - t || 1) * cellZ);
    const grade = Math.hypot(gx, gy);
    const h = heights[i] * scale;
    let blocked = 0,
      landform = 0,
      landformWeight = 0;
    for (const { ux, uy, probes } of axes) {
      const tangent = gx * ux + gy * uy;
      let forward = tangent,
        backward = -tangent;
      for (const { dx, dy, invMeters, weight } of probes) {
        const px = x + dx,
          py = y + dy,
          mx = x - dx,
          my = y - dy;
        const hasFront = px >= 0 && py >= 0 && px <= n - 1 && py <= rows - 1;
        const hasBack = mx >= 0 && mx <= n - 1 && my >= 0 && my <= rows - 1;
        const front = hasFront
          ? (elevationAt(heights, n, rows, px, py) * scale - h) * invMeters
          : tangent;
        const back = hasBack
          ? (elevationAt(heights, n, rows, mx, my) * scale - h) * invMeters
          : -tangent;
        forward = Math.max(forward, front);
        backward = Math.max(backward, back);
        if (hasFront && hasBack) {
          landform += 0.5 * (front + back) * weight;
          landformWeight += weight;
        }
      }
      blocked += blockedSlice(tangent, forward) + blockedSlice(-tangent, backward);
    }
    out.grade = grade;
    out.gradientX = gx;
    out.gradientY = gy;
    out.slopeDegrees = (Math.atan(grade) * 180) / Math.PI;
    // Rows increase southward. A downhill-facing-north surface climbs south.
    out.northness = grade > 1e-7 ? gy / grade : 0;
    out.landform = landformWeight ? landform / landformWeight : 0;
    out.occlusion = clamp(1 - blocked / (8 * Math.sqrt(1 + grade * grade)));
    return out;
  };
}
