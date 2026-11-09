import { sampleHeight } from './erosion';
import { clamp, smoothstep } from './noise';
import { DEFAULT_SPLINE_PATH, sampleSpline, validSplinePoint } from '../model/splines';
import type { SplinePoint } from '../model/splines';

export interface SplineSettings {
  mode: 'river' | 'ridge';
  width: number;
  strength: number;
  falloff: number;
  downhill: boolean;
}

/**
 * Shape the real Float32 heightfield along a Catmull–Rom centerline.
 *
 * Rasterization visits only pixels near the curve segments, recording the
 * nearest path location. That prevents overlapping brush stamps and banded
 * ridges, while keeping high-resolution export costs bounded by path length
 * and influence width rather than number of output pixels times all samples.
 */
export function sculptSpline(
  input: Float32Array,
  n: number,
  path: readonly SplinePoint[] = DEFAULT_SPLINE_PATH,
  settings: SplineSettings,
): Float32Array {
  if (
    !Number.isInteger(n) || n < 2 || input.length !== n * n ||
    path.length < 2 || path.length > 24 || !path.every(validSplinePoint)
  ) throw new Error('This spline has invalid points or terrain dimensions.');
  const result = input.slice();
  const strength = clamp(settings.strength, 0, 0.55);
  if (!strength) return result;
  const width = clamp(settings.width, 0.002, 0.12);
  const falloff = clamp(settings.falloff, 1.5, 6);
  const isRiver = settings.mode !== 'ridge';
  const n1 = n - 1;
  const corePixels = Math.max(0.5, width * n1);
  const influence = corePixels * falloff;
  const influence2 = influence * influence;
  const stepsPerSpan = Math.max(12, Math.min(512, Math.ceil(n1 / (2.2 * (path.length - 1)))));
  const samples = sampleSpline(path, stepsPerSpan);
  const px = samples.map((p) => ({ x: p.x * n1, y: p.y * n1 }));
  const beds = new Float32Array(px.length);
  let previous = Infinity;
  for (let i = 0; i < px.length; i++) {
    const { x, y } = px[i];
    const source = sampleHeight(input, n, x, y) - strength;
    // First -> last follows the water. A small positive grade avoids a flat
    // stream bed even where the underlying mountain surface climbs upstream.
    const segment = i
      ? Math.hypot(x - px[i - 1].x, y - px[i - 1].y)
      : 0;
    const bed = isRiver && settings.downhill
      ? Math.min(source, previous - segment * 0.000012)
      : source;
    beds[i] = bed;
    previous = bed;
  }

  const distance2 = new Float32Array(n * n);
  distance2.fill(Infinity);
  const nearestBed = isRiver ? new Float32Array(n * n) : null;

  for (let i = 0; i < px.length - 1; i++) {
    const a = px[i], b = px[i + 1];
    const vx = b.x - a.x, vy = b.y - a.y;
    const segment2 = vx * vx + vy * vy;
    const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - influence));
    const x1 = Math.min(n - 1, Math.ceil(Math.max(a.x, b.x) + influence));
    const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - influence));
    const y1 = Math.min(n - 1, Math.ceil(Math.max(a.y, b.y) + influence));
    for (let y = y0; y <= y1; y++) {
      const row = y * n;
      for (let x = x0; x <= x1; x++) {
        const projection = segment2 > 1e-10
          ? clamp(((x - a.x) * vx + (y - a.y) * vy) / segment2)
          : 0;
        const dx = x - a.x - projection * vx;
        const dy = y - a.y - projection * vy;
        const d2 = dx * dx + dy * dy;
        const index = row + x;
        if (d2 >= distance2[index] || d2 > influence2) continue;
        distance2[index] = d2;
        if (nearestBed)
          nearestBed[index] = beds[i] + (beds[i + 1] - beds[i]) * projection;
      }
    }
  }

  for (let i = 0; i < result.length; i++) {
    if (distance2[i] > influence2) continue;
    const normalized = Math.sqrt(distance2[i]) / corePixels;
    const envelope = 1 - smoothstep(falloff * 0.6, falloff, normalized);
    if (isRiver) {
      // The curved bank rises smoothly away from the watercourse. Only
      // excavation is allowed; the spline never deposits a raised dam.
      const bank = strength * 0.33 * Math.pow(normalized, 1.7);
      const bed = nearestBed![i] + bank;
      const incision = Math.min(0, bed - input[i]);
      result[i] = input[i] + incision * envelope;
    } else {
      // One influence per texel (nearest curve), rather than cumulative
      // Gaussian stamps that create obvious bumps at control points.
      const crest = 1 - smoothstep(0, falloff, normalized);
      result[i] = input[i] + strength * crest * crest;
    }
  }
  return result;
}
