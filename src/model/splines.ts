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

/** Insert at the closest existing path segment rather than appending at random. */
export function insertSplinePoint(
  points: readonly SplinePoint[],
  added: SplinePoint,
): SplinePoint[] {
  if (points.length >= MAX_SPLINE_POINTS) return points.map((p) => ({ ...p }));
  const point = { x: clamp(added.x), y: clamp(added.y) };
  if (points.length < 2) return [...points, point];
  let closest = Infinity;
  let insertAt = 1;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const projection = dx * dx + dy * dy > 1e-10
      ? clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy))
      : 0;
    const distance = (point.x - a.x - projection * dx) ** 2 +
      (point.y - a.y - projection * dy) ** 2;
    if (distance < closest) {
      closest = distance;
      insertAt = i + 1;
    }
  }
  return [...points.slice(0, insertAt), point, ...points.slice(insertAt)];
}

export function validSplinePoint(value: unknown): value is SplinePoint {
  if (!value || typeof value !== 'object') return false;
  const point = value as Record<string, unknown>;
  return typeof point.x === 'number' && Number.isFinite(point.x) &&
    point.x >= 0 && point.x <= 1 &&
    typeof point.y === 'number' && Number.isFinite(point.y) &&
    point.y >= 0 && point.y <= 1;
}
