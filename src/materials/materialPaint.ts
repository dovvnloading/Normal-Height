/** Points and radii use tile fractions. Row zero is the north edge. */
export type MaterialLayer = 'rock' | 'soil' | 'vegetation' | 'snow';
export interface PaintPoint {
  u: number;
  v: number;
}
export interface MaterialStroke {
  layer: MaterialLayer | 'erase';
  radius: number;
  hardness: number;
  strength: number;
  points: PaintPoint[];
}

export const MAX_PAINT_STROKES = 512;
export const MAX_PAINT_POINTS = 16000;
export const MAX_STROKE_POINTS = 2048;

export function canAppendMaterialStroke(
  strokes: readonly MaterialStroke[] | undefined,
  stroke: MaterialStroke,
) {
  return (
    (strokes?.length ?? 0) < MAX_PAINT_STROKES &&
    stroke.points.length > 0 &&
    stroke.points.length <= MAX_STROKE_POINTS &&
    (strokes ?? []).reduce((count, item) => count + item.points.length, stroke.points.length) <=
      MAX_PAINT_POINTS
  );
}

const channel = { rock: 0, soil: 1, vegetation: 2, snow: 3, erase: -1 } as const;
const unit = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

export function parseMaterialPaint(input: unknown): MaterialStroke[] {
  if (!Array.isArray(input) || input.length > MAX_PAINT_STROKES)
    throw new Error('Invalid material paint history.');
  let pointCount = 0;
  return input.map((s: unknown) => {
    if (!s || typeof s !== 'object') throw new Error('Invalid material stroke.');
    const { layer, radius, hardness, strength, points } = s as MaterialStroke;
    if (
      typeof layer !== 'string' ||
      !Object.hasOwn(channel, layer) ||
      !unit(radius) ||
      radius < 0.0001 ||
      !unit(hardness) ||
      !unit(strength) ||
      !Array.isArray(points) ||
      points.length < 1 ||
      points.length > MAX_STROKE_POINTS
    )
      throw new Error('Invalid material brush or stroke length.');
    pointCount += points.length;
    if (pointCount > MAX_PAINT_POINTS) throw new Error('Material paint exceeds the project point limit.');
    return {
      layer,
      radius,
      hardness,
      strength,
      points: points.map((p) => {
        if (!p || !unit(p.u) || !unit(p.v))
          throw new Error('Material stroke lies outside the terrain.');
        return { u: p.u, v: p.v };
      }),
    };
  });
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/**
 * Rasterize the swept disk of each stroke. A stroke applies its opacity once,
 * including at joins and crossings, independently of pointer event frequency.
 * Track premultiplied layer coverage. The residual is the procedural material.
 * Memory grows with stroke geometry and row width rather than texture area.
 */
export function createMaterialPaintRaster(
  strokes: readonly MaterialStroke[] | undefined,
  size: number,
) {
  if (!strokes?.length) return undefined;
  const last = size - 1;
  const layerCoverage = new Float32Array(size * 4);
  const falloff = new Float32Array(size);
  const paths = strokes.map((stroke) => {
    const radius = stroke.radius * last;
    const segments = [];
    let firstRow = last,
      lastRow = 0;
    for (let i = 0; i < Math.max(1, stroke.points.length - 1); i++) {
      const start = stroke.points[i],
        end = stroke.points[i + 1] ?? start;
      const x = start.u * last,
        y = start.v * last;
      const dx = end.u * last - x,
        dy = end.v * last - y;
      const length2 = dx * dx + dy * dy;
      const top = Math.ceil(Math.min(y, y + dy) - radius);
      const bottom = Math.floor(Math.max(y, y + dy) + radius);
      firstRow = Math.min(firstRow, top);
      lastRow = Math.max(lastRow, bottom);
      segments.push({ x, y, dx, dy, invLength2: length2 ? 1 / length2 : 0, top, bottom });
    }
    return {
      segments,
      firstRow,
      lastRow,
      radius,
      hardness: stroke.hardness,
      strength: stroke.strength,
      target: channel[stroke.layer],
    };
  });

  return {
    row(y: number) {
      layerCoverage.fill(0);
      for (const path of paths) {
        if (y < path.firstRow || y > path.lastRow || !path.strength) continue;
        const { radius, hardness, strength, target } = path;
        let first = size,
          end = -1;
        for (const s of path.segments) {
          if (y < s.top || y > s.bottom) continue;
          // Clip the centerline to this row's radius-wide band before searching X.
          const a = s.dy ? clamp01((y - radius - s.y) / s.dy) : 0;
          const b = s.dy ? clamp01((y + radius - s.y) / s.dy) : 1;
          const ax = s.x + s.dx * a,
            bx = s.x + s.dx * b;
          const lo = Math.max(0, Math.ceil(Math.min(ax, bx) - radius));
          const hi = Math.min(last, Math.floor(Math.max(ax, bx) + radius));
          first = Math.min(first, lo);
          end = Math.max(end, hi);
          for (let x = lo; x <= hi; x++) {
            if (falloff[x] === 1) continue;
            const t = clamp01(((x - s.x) * s.dx + (y - s.y) * s.dy) * s.invLength2);
            const ex = x - s.x - t * s.dx,
              ey = y - s.y - t * s.dy;
            const distance2 = ex * ex + ey * ey;
            if (distance2 > radius * radius) continue;
            const d = Math.sqrt(distance2) / radius;
            const f = d <= hardness ? 1 : clamp01((1 - d) / (1 - hardness));
            falloff[x] = Math.max(falloff[x], f * f * (3 - 2 * f));
          }
        }
        for (let x = first; x <= end; x++) {
          const alpha = strength * falloff[x];
          if (!alpha) continue;
          const p = x * 4;
          for (let c = 0; c < 4; c++) layerCoverage[p + c] *= 1 - alpha;
          if (target >= 0) layerCoverage[p + target] += alpha;
        }
        if (end >= first) falloff.fill(0, first, end + 1);
      }
      return layerCoverage;
    },
  };
}
