import type { MaterialStroke, PaintPoint } from './materialPaint';
import type { BrushSymmetry } from './brushPresets';

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** Coalesced events describe the path between animation frames. The dispatched
 * event may be newer than the final coalesced sample, so retain that endpoint. */
export function pointerSamples<T extends { clientX: number; clientY: number; pressure: number }>(event: T): T[] {
  let samples: T[] = [];
  try { samples = (event as T & { getCoalescedEvents?: () => T[] }).getCoalescedEvents?.() ?? []; } catch { /* Older browsers. */ }
  const last = samples.at(-1);
  if (!last || last.clientX !== event.clientX || last.clientY !== event.clientY ||
      last.pressure !== event.pressure) samples = [...samples, event];
  return samples;
}

/** Do not use the pointer-up pressure (normally zero) to erase the end of a pen
 * stroke. Mouse/touch report synthetic pressure and keep the brush at full size. */
export function penPressure(pointerType: string, pressure: number, ending: boolean,
  previous = 1): number | undefined {
  if (pointerType !== 'pen') return undefined;
  if (ending && pressure <= 0) return previous;
  return Number.isFinite(pressure) ? clamp01(pressure) : previous;
}

/** Distance-based stabilization dampens hand jitter without tying the result to
 * display refresh rate. The release endpoint is added unsmoothed by the caller. */
export function smoothPaintPoint(previous: PaintPoint | null, point: PaintPoint,
  smoothing: number, radius: number): PaintPoint {
  if (!previous || smoothing <= 0) return { ...point };
  const distance = Math.hypot(point.u - previous.u, point.v - previous.v);
  const length = Math.max(0.00001, radius * 0.55 * clamp01(smoothing));
  const weight = Math.max(0.08, 1 - Math.exp(-distance / length));
  return {
    ...point,
    u: previous.u + (point.u - previous.u) * weight,
    v: previous.v + (point.v - previous.v) * weight,
  };
}

/** Douglas–Peucker simplification with a second error budget for pen pressure.
 * A straight line with a pressure peak must not become an even-width stroke. */
export function simplifyBrushPath(points: readonly PaintPoint[], tolerance: number,
  pressureTolerance = 0.025): PaintPoint[] {
  if (points.length <= 2 || tolerance <= 0) return points.map(point => ({ ...point }));
  const kept = new Uint8Array(points.length);
  kept[0] = kept[points.length - 1] = 1;
  const threshold = tolerance * tolerance;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    const a = points[start], b = points[end];
    const dx = b.u - a.u, dy = b.v - a.v;
    const length2 = dx * dx + dy * dy;
    let furthest = -1, largest = 1;
    for (let i = start + 1; i < end; i++) {
      const point = points[i];
      const t = length2 ? clamp01(((point.u - a.u) * dx + (point.v - a.v) * dy) / length2)
        : (i - start) / (end - start);
      const ex = point.u - a.u - dx * t, ey = point.v - a.v - dy * t;
      const predictedPressure = (a.pressure ?? 1) + ((b.pressure ?? 1) - (a.pressure ?? 1)) * t;
      const pressureError = Math.abs((point.pressure ?? 1) - predictedPressure) / pressureTolerance;
      const error = Math.max((ex * ex + ey * ey) / threshold, pressureError * pressureError);
      if (error > largest) { largest = error; furthest = i; }
    }
    if (furthest >= 0) {
      kept[furthest] = 1;
      stack.push([start, furthest], [furthest, end]);
    }
  }
  return points.filter((_, i) => kept[i]).map(point => ({ ...point }));
}

function samePoints(a: readonly PaintPoint[], b: readonly PaintPoint[]) {
  return a.length === b.length && a.every((point, i) =>
    Math.abs(point.u - b[i].u) < 0.000001 && Math.abs(point.v - b[i].v) < 0.000001);
}

/** Symmetry is stored as ordinary tile-space strokes, so export and reopening
 * never depend on a workspace preference. Avoid painting a centerline twice. */
export function mirrorBrushStrokes(strokes: readonly MaterialStroke[], symmetry: BrushSymmetry): MaterialStroke[] {
  if (symmetry === 'none') return [...strokes];
  const transforms = symmetry === 'both' ? [[true, false], [false, true], [true, true]]
    : [[symmetry === 'x', symmetry === 'y']];
  const output: MaterialStroke[] = [];
  for (const stroke of strokes) {
    const variants: MaterialStroke[] = [stroke];
    for (const [x, y] of transforms) {
      const points = stroke.points.map(point => ({ ...point,
        u: x ? 1 - point.u : point.u,
        v: y ? 1 - point.v : point.v,
      }));
      if (variants.some(variant => samePoints(variant.points, points))) continue;
      const angle = stroke.angle ?? 0;
      const reflectedAngle = x && y ? angle + 180 : x ? 180 - angle : -angle;
      variants.push({ ...stroke, points,
        angle: ((reflectedAngle % 360) + 540) % 360 - 180 });
    }
    output.push(...variants);
  }
  return output;
}

/** Conservative preview warning. Final simplification may use less space; no
 * points or paths are discarded to satisfy a capacity limit. */
export function brushCapacityWarning(strokes: readonly MaterialStroke[],
  remainingPoints?: number, remainingStrokes?: number): boolean {
  const points = strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
  return (remainingPoints !== undefined && Number.isFinite(remainingPoints) &&
      points >= Math.max(1, remainingPoints * 0.8)) ||
    (remainingStrokes !== undefined && Number.isFinite(remainingStrokes) &&
      strokes.length >= Math.max(1, remainingStrokes * 0.8));
}
