/** Normalized map-space control points. X increases east; Y increases south. */
export interface SplinePoint {
  x: number;
  y: number;
}

export const DEFAULT_SPLINE_PATH: readonly SplinePoint[] = [
  { x: 0.14, y: 0.22 },
  { x: 0.34, y: 0.37 },
  { x: 0.52, y: 0.54 },
  { x: 0.68, y: 0.63 },
  { x: 0.86, y: 0.79 },
];

export const MAX_SPLINE_POINTS = 24;
const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function sampleSpline(
  points: readonly SplinePoint[],
  stepsPerSpan = 20,
): SplinePoint[] {
  if (!points.length) return [];
  if (points.length === 1) return [{ ...points[0] }];
  const result: SplinePoint[] = [];
  const steps = Math.max(1, Math.min(512, Math.round(stepsPerSpan)));
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    // Catmull–Rom with bounded tension: smooth bends, exact control-point passage.
    for (let step = 0; step < steps; step++) {
      const t = step / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const coordinate = (a: number, b: number, c: number, d: number) =>
        (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 +
          (-a + 3 * b - 3 * c + d) * t3) / 2;
      result.push({
        x: clamp(coordinate(p0.x, p1.x, p2.x, p3.x)),
        y: clamp(coordinate(p0.y, p1.y, p2.y, p3.y)),
      });
    }
  }
  result.push({ ...points[points.length - 1] });
  return result;
}

/** Shared guide sampling for the map and its editing hit tests. The engine
 * retains its existing resolution-dependent sampling and terrain semantics. */
export const SPLINE_GUIDE_STEPS = 48;

const length = (a: SplinePoint, b: SplinePoint) => Math.hypot(b.x - a.x, b.y - a.y);

export function splineLength(points: readonly SplinePoint[]): number {
  const samples = sampleSpline(points, SPLINE_GUIDE_STEPS);
  let total = 0;
  for (let i = 1; i < samples.length; i++) total += length(samples[i - 1], samples[i]);
  return total;
}

/** Insert into the span of the nearest *visible curve*, not the control
 * polygon. Keep the clicked coordinate and preserve the endpoint order.
 * Ties (including self-intersections) select the first span deterministically. */
export function insertSplinePoint(
  points: readonly SplinePoint[],
  added: SplinePoint,
): SplinePoint[] {
  if (points.length >= MAX_SPLINE_POINTS || !Number.isFinite(added.x) || !Number.isFinite(added.y))
    return points.map((p) => ({ ...p }));
  const point = { x: clamp(added.x), y: clamp(added.y) };
  if (points.length < 2) return [...points, point];
  const samples = sampleSpline(points, SPLINE_GUIDE_STEPS);
  let closest = Infinity;
  let insertAt = 1;
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i], b = samples[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const segment2 = dx * dx + dy * dy;
    const projection = segment2 > 0
      ? clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / segment2)
      : 0;
    const distance = (point.x - a.x - projection * dx) ** 2 +
      (point.y - a.y - projection * dy) ** 2;
    if (distance < closest) {
      closest = distance;
      insertAt = Math.floor(i / SPLINE_GUIDE_STEPS) + 1;
    }
  }
  return [...points.slice(0, insertAt), point, ...points.slice(insertAt)];
}

/** Add a point halfway along the longest curved span by arc length. Insert
 * directly at that span, even when another span crosses the midpoint. */
export function splitLongestSplineSpan(points: readonly SplinePoint[]): SplinePoint[] {
  if (points.length < 2 || points.length >= MAX_SPLINE_POINTS) return [...points];
  const samples = sampleSpline(points, SPLINE_GUIDE_STEPS);
  let longest = 0;
  let span = 0;
  for (let i = 0; i < points.length - 1; i++) {
    let distance = 0;
    const start = i * SPLINE_GUIDE_STEPS;
    for (let j = start; j < start + SPLINE_GUIDE_STEPS; j++)
      distance += length(samples[j], samples[j + 1]);
    if (distance > longest) {
      longest = distance;
      span = i;
    }
  }
  if (longest <= 1e-10) return [...points];
  let remaining = longest / 2;
  const start = span * SPLINE_GUIDE_STEPS;
  for (let i = start; i < start + SPLINE_GUIDE_STEPS; i++) {
    const a = samples[i], b = samples[i + 1];
    const distance = length(a, b);
    if (distance > 0 && remaining <= distance) {
      const t = clamp(remaining / distance);
      const point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      return [...points.slice(0, span + 1), point, ...points.slice(span + 1)];
    }
    remaining -= distance;
  }
  return [...points];
}

export function moveSplinePoint(
  points: readonly SplinePoint[],
  index: number,
  point: SplinePoint,
): SplinePoint[] {
  if (!points[index] || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return [...points];
  return points.map((p, i) => i === index ? { x: clamp(point.x), y: clamp(point.y) } : p);
}

/** The engine's normalized core radius and full outer influence radius. */
export function splineFootprint(width: number, falloff: number) {
  const core = Math.max(0.002, Math.min(0.12, Number.isFinite(width) ? width : 0.016));
  const spread = Math.max(1.5, Math.min(6, Number.isFinite(falloff) ? falloff : 3));
  return { core, outer: core * spread };
}

/** Evenly spaced direction markers, with a local tangent in map coordinates. */
export function splineDirectionMarkers(samples: readonly SplinePoint[], count = 3) {
  const distances = samples.slice(1).map((p, i) => length(samples[i], p));
  const total = distances.reduce((sum, distance) => sum + distance, 0);
  if (total <= 1e-10) return [];
  const markers: (SplinePoint & { angle: number })[] = [];
  let segment = 0;
  let traversed = 0;
  for (let i = 1; i <= count; i++) {
    const target = total * i / (count + 1);
    while (segment < distances.length - 1 && traversed + distances[segment] < target)
      traversed += distances[segment++];
    const distance = distances[segment];
    if (!distance) continue;
    const a = samples[segment], b = samples[segment + 1];
    const t = clamp((target - traversed) / distance);
    markers.push({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      angle: Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI,
    });
  }
  return markers;
}

export function validSplinePoint(value: unknown): value is SplinePoint {
  if (!value || typeof value !== 'object') return false;
  const point = value as Record<string, unknown>;
  return typeof point.x === 'number' && Number.isFinite(point.x) &&
    point.x >= 0 && point.x <= 1 &&
    typeof point.y === 'number' && Number.isFinite(point.y) &&
    point.y >= 0 && point.y <= 1;
}
