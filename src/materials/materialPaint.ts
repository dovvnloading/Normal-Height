import type { HeightField, TerrainProject } from '../model/types';
import { fieldCoordinate, type FieldSampling } from '../engine/fields';
import { createTerrainAnalyzer, type TerrainFactors } from './terrainAnalysis';

/** Points and radii use tile fractions. Row zero is the north edge. */
export type MaterialLayer = 'rock' | 'soil' | 'vegetation' | 'snow';
export interface PaintPoint {
  u: number;
  v: number;
  /** Normalized stylus pressure. Omitted mouse/touch samples use full pressure. */
  pressure?: number;
}
export interface PaintMask {
  /** Physical elevation in metres, independent of display exaggeration. */
  elevation?: [number, number];
  slope?: [number, number];
  flow?: [number, number];
  curvature?: [number, number];
  /** Clockwise compass degrees; [300, 60] includes north. */
  aspect?: [number, number];
  feather?: number;
  breakup?: number;
  /** World-space size of the coherent breakup pattern, in metres. */
  scale?: number;
}
export interface PaintSelection {
  points: PaintPoint[];
  invert?: boolean;
  /** Flood selection, stored as compact [row, start, end-exclusive] runs. */
  region?: { resolution: number; runs: number[] };
}
export interface MaterialStroke {
  layer: MaterialLayer | 'erase';
  radius: number;
  hardness: number;
  strength: number;
  points: PaintPoint[];
  pressure?: 'none' | 'radius' | 'strength' | 'both';
  texture?: 'smooth' | 'grain' | 'scatter';
  spacing?: number;
  angle?: number;
  aspect?: number;
  jitter?: number;
  seed?: number;
  mask?: PaintMask;
  mode?: 'paint' | 'blend' | 'replace';
  source?: MaterialLayer;
  selection?: PaintSelection;
  /** Fill applies to the entire tile, clipped by selection and terrain masks. */
  fullTile?: boolean;
}

// Explicit limits keep imported projects bounded. Long paths are simplified
// before committing; capacity is shared by all authored layers.
export const MAX_PAINT_STROKES = 4096;
export const MAX_PAINT_POINTS = 128000;
export const MAX_STROKE_POINTS = 2048;
export const MAX_SELECTION_POINTS = 256;
export const MATERIAL_LAYERS = ['rock', 'soil', 'vegetation', 'snow'] as const;
const channel = { rock: 0, soil: 1, vegetation: 2, snow: 3, erase: -1 } as const;
export const paintChannel = (layer: MaterialStroke['layer']) => channel[layer];
const unit = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const finite = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
export const clampPaint = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => {
  const v = clampPaint(value);
  return v * v * (3 - 2 * v);
};

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

export function parsePaintMask(input: unknown): PaintMask {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid terrain paint mask.');
  const raw = input as Record<string, unknown>;
  const result: PaintMask = {};
  const ranges = {
    elevation: [-1e7, 1e7],
    slope: [0, 90],
    flow: [0, 1],
    curvature: [-1, 1],
    aspect: [0, 360],
  } as const;
  for (const key of Object.keys(ranges) as (keyof typeof ranges)[]) {
    const value = raw[key];
    if (value === undefined) continue;
    const [min, max] = ranges[key];
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      !value.every((v) => finite(v, min, max)) ||
      (key !== 'aspect' && value[0] > value[1])
    )
      throw new Error('Invalid paint mask ' + key + '.');
    result[key] = [value[0], value[1]];
  }
  for (const key of ['feather', 'breakup'] as const) {
    if (raw[key] === undefined) continue;
    if (!unit(raw[key])) throw new Error('Invalid paint mask ' + key + '.');
    result[key] = raw[key];
  }
  if (raw.scale !== undefined) {
    if (!finite(raw.scale, 0.01, 1e7)) throw new Error('Invalid paint mask scale.');
    result.scale = raw.scale;
  }
  return result;
}
function parsePoint(raw: unknown): PaintPoint {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid paint point.');
  const p = raw as PaintPoint;
  if (!unit(p.u) || !unit(p.v)) throw new Error('Material stroke lies outside the terrain.');
  if (p.pressure !== undefined && !unit(p.pressure)) throw new Error('Invalid stylus pressure.');
  return { u: p.u, v: p.v, ...(p.pressure !== undefined ? { pressure: p.pressure } : {}) };
}
export function parsePaintSelection(input: unknown): PaintSelection {
  if (!input || typeof input !== 'object') throw new Error('Invalid paint selection.');
  const s = input as PaintSelection;
  if (
    !Array.isArray(s.points) ||
    s.points.length > MAX_SELECTION_POINTS ||
    (s.points.length > 0 && s.points.length < 3)
  )
    throw new Error('A polygon needs 3–256 points.');
  if (s.invert !== undefined && typeof s.invert !== 'boolean')
    throw new Error('Invalid selection inversion.');
  const result: PaintSelection = {
    points: s.points.map(parsePoint),
    ...(s.invert ? { invert: true } : {}),
  };
  if (s.region !== undefined) {
    const { resolution, runs } = s.region;
    if (
      !Number.isInteger(resolution) ||
      resolution < 2 ||
      resolution > 512 ||
      !Array.isArray(runs) ||
      runs.length % 3 !== 0 ||
      runs.length > resolution * resolution * 3
    )
      throw new Error('Invalid flood selection.');
    let lastRow = -1,
      lastEnd = 0;
    for (let i = 0; i < runs.length; i += 3) {
      const [row, start, end] = runs.slice(i, i + 3);
      if (
        ![row, start, end].every(Number.isInteger) ||
        row < 0 ||
        row >= resolution ||
        start < 0 ||
        end > resolution ||
        start >= end ||
        row < lastRow ||
        (row === lastRow && start < lastEnd)
      )
        throw new Error('Invalid flood selection runs.');
      lastRow = row;
      lastEnd = end;
    }
    result.region = { resolution, runs: [...runs] };
  }
  if (!result.region && result.points.length === 0) throw new Error('The selection is empty.');
  return result;
}

export function parseMaterialPaint(input: unknown): MaterialStroke[] {
  if (!Array.isArray(input) || input.length > MAX_PAINT_STROKES)
    throw new Error('Invalid material paint history.');
  let pointCount = 0;
  return input.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid material stroke.');
    const s = raw as MaterialStroke;
    const { layer, radius, hardness, strength, points } = s;
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
    if (pointCount > MAX_PAINT_POINTS)
      throw new Error('Material paint exceeds the project point limit.');
    const result: MaterialStroke = {
      layer,
      radius,
      hardness,
      strength,
      points: points.map(parsePoint),
    };
    const enums = {
      pressure: ['none', 'radius', 'strength', 'both'],
      texture: ['smooth', 'grain', 'scatter'],
      mode: ['paint', 'blend', 'replace'],
      source: MATERIAL_LAYERS,
    } as const;
    for (const key of Object.keys(enums) as (keyof typeof enums)[]) {
      if (s[key] === undefined) continue;
      if (typeof s[key] !== 'string' || !(enums[key] as readonly string[]).includes(s[key]!))
        throw new Error('Invalid paint ' + key + '.');
      Object.assign(result, { [key]: s[key] });
    }
    const numbers = {
      spacing: [0.01, 2],
      angle: [-360, 360],
      aspect: [0.05, 1],
      jitter: [0, 1],
      seed: [0, 2147483647],
    } as const;
    for (const key of Object.keys(numbers) as (keyof typeof numbers)[]) {
      if (s[key] === undefined) continue;
      if (!finite(s[key], numbers[key][0], numbers[key][1]))
        throw new Error('Invalid brush ' + key + '.');
      Object.assign(result, { [key]: s[key] });
    }
    if (s.mask !== undefined) result.mask = parsePaintMask(s.mask);
    if (s.selection !== undefined) result.selection = parsePaintSelection(s.selection);
    if (s.fullTile !== undefined) {
      if (typeof s.fullTile !== 'boolean') throw new Error('Invalid paint fill.');
      result.fullTile = s.fullTile;
    }
    return result;
  });
}

/** A stable world-space hash; no random state or pixel-resolution dependency. */
function hash(x: number, y: number, seed: number) {
  let h =
    Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function noise(x: number, y: number, seed: number) {
  const ix = Math.floor(x),
    iy = Math.floor(y),
    tx = smooth(x - ix),
    ty = smooth(y - iy);
  const a = hash(ix, iy, seed) * (1 - tx) + hash(ix + 1, iy, seed) * tx;
  const b = hash(ix, iy + 1, seed) * (1 - tx) + hash(ix + 1, iy + 1, seed) * tx;
  return a * (1 - ty) + b * ty;
}
const rangeWeight = (value: number, range: [number, number] | undefined, feather: number) => {
  if (!range) return 1;
  const [lo, hi] = range;
  if (value < lo || value > hi) return 0;
  const edge = (hi - lo) * feather * 0.5;
  return edge > 0 ? Math.min(smooth((value - lo) / edge), smooth((hi - value) / edge)) : 1;
};
export interface PaintRasterContext {
  field: HeightField;
  project: TerrainProject;
  sampling?: FieldSampling;
}
const analyzerCache = new WeakMap<
  HeightField,
  {
    worldSize: number;
    heightScale: number;
    sampling?: FieldSampling;
    analyze: ReturnType<typeof createTerrainAnalyzer>;
  }
>();
function analyzer(context: PaintRasterContext) {
  const { field, project } = context;
  let entry = analyzerCache.get(field);
  if (
    !entry ||
    entry.worldSize !== project.worldSize ||
    entry.heightScale !== project.heightScale ||
    entry.sampling !== context.sampling
  ) {
    entry = {
      worldSize: project.worldSize,
      heightScale: project.heightScale,
      sampling: context.sampling,
      analyze: createTerrainAnalyzer(field, project, context.sampling?.grid),
    };
    analyzerCache.set(field, entry);
  }
  return entry.analyze;
}
export function evaluatePaintMask(
  mask: PaintMask | undefined,
  point: PaintPoint,
  field: HeightField,
  project: TerrainProject,
  seed = project.seed,
): number {
  if (!mask) return 1;
  const n = field.resolution,
    x = Math.round(clampPaint(point.u) * (n - 1)),
    y = Math.round(clampPaint(point.v) * (n - 1));
  return createMaskEvaluator(mask, { field, project }, seed)(x, y);
}
/** Compiled once per stroke; physical terrain analysis is needed only for enabled masks. */
export function createMaskEvaluator(
  mask: PaintMask | undefined,
  context: PaintRasterContext | undefined,
  seed: number,
) {
  if (!mask || !context) return () => 1;
  const { field, project } = context,
    n = field.resolution;
  const feather = mask.feather ?? 0.12;
  const analyze = mask.slope || mask.aspect || mask.curvature ? analyzer(context) : null;
  const metrics: TerrainFactors = {
    grade: 0,
    gradientX: 0,
    gradientY: 0,
    slopeDegrees: 0,
    northness: 0,
    landform: 0,
    occlusion: 1,
  };
  return (x: number, y: number) => {
    const i = y * n + x;
    let amount =
      rangeWeight(
        field.height[i] * (context.sampling?.grid.heightScale ?? project.heightScale) +
          (context.sampling?.grid.datum ?? 0),
        mask.elevation,
        feather,
      ) * rangeWeight(clampPaint(field.flow[i]), mask.flow, feather);
    if (!amount) return 0;
    if (analyze) {
      const m = analyze(x, y, metrics);
      amount *=
        rangeWeight(m.slopeDegrees, mask.slope, feather) *
        rangeWeight(Math.max(-1, Math.min(1, m.landform)), mask.curvature, feather);
      if (mask.aspect) {
        // Downhill direction measured clockwise from north.
        const azimuth = ((Math.atan2(-m.gradientX, m.gradientY) * 180) / Math.PI + 360) % 360;
        const [start, end] = mask.aspect;
        const span = end >= start ? end - start : 360 - start + end;
        if (span < 360) {
          const relative = (azimuth - start + 360) % 360;
          amount *= m.grade < 1e-7 ? 0 : rangeWeight(relative, [0, span], feather);
        }
      }
    }
    if (mask.breakup) {
      const scale = mask.scale ?? Math.max(1, project.worldSize * 0.012);
      const sample = noise(
        (context.sampling
          ? fieldCoordinate(context.sampling.grid, 'X', x)
          : (x / (n - 1)) * project.worldSize) / scale,
        (context.sampling
          ? fieldCoordinate(context.sampling.grid, 'Z', y)
          : (y / (n - 1)) * project.worldSize) / scale,
        seed,
      );
      amount *= 1 - mask.breakup + mask.breakup * smooth((sample - 0.2) / 0.6);
    }
    return amount;
  };
}

export function pointInPaintSelection(
  selection: PaintSelection | undefined,
  point: PaintPoint,
): boolean {
  if (!selection) return true;
  let inside = false;
  const points = selection.points;
  if (points.length >= 3) {
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[i],
        b = points[j];
      const cross = (point.u - a.u) * (b.v - a.v) - (point.v - a.v) * (b.u - a.u);
      if (
        Math.abs(cross) < 1e-10 &&
        point.u >= Math.min(a.u, b.u) &&
        point.u <= Math.max(a.u, b.u) &&
        point.v >= Math.min(a.v, b.v) &&
        point.v <= Math.max(a.v, b.v)
      ) {
        inside = true;
        break;
      }
      if (
        a.v > point.v !== b.v > point.v &&
        point.u < ((b.u - a.u) * (point.v - a.v)) / (b.v - a.v) + a.u
      )
        inside = !inside;
    }
  }
  if (selection.region) {
    const { resolution, runs } = selection.region;
    const x = Math.min(resolution - 1, Math.round(clampPaint(point.u) * (resolution - 1)));
    const y = Math.min(resolution - 1, Math.round(clampPaint(point.v) * (resolution - 1)));
    // Find the last span whose row/start is at or before the queried cell.
    // This also bounds lookups for complex selections used as fill restrictions.
    let lo = 0,
      hi = runs.length / 3;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1,
        k = mid * 3;
      if (runs[k] < y || (runs[k] === y && runs[k + 1] <= x)) lo = mid + 1;
      else hi = mid;
    }
    const k = (lo - 1) * 3;
    const selected = k >= 0 && runs[k] === y && x < runs[k + 2];
    inside = points.length >= 3 ? inside && selected : selected;
  }
  return selection.invert ? !inside : inside;
}

interface Segment {
  x: number;
  y: number;
  dx: number;
  dy: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
  p0: number;
  p1: number;
}
export interface StrokeRaster {
  firstRow: number;
  lastRow: number;
  weight(x: number, y: number): number;
  row(y: number): Float32Array;
}
/** Shared geometry/falloff path for saved materials and live material previews. */
export function createStrokeRaster(
  stroke: MaterialStroke,
  size: number,
  context?: PaintRasterContext,
): StrokeRaster {
  const sampling = context?.sampling,
    domain = sampling?.paint;
  const regional = Boolean(domain && sampling);
  const rows = sampling?.grid.height ?? size;
  // In a regional raster, stroke geometry stays in authored whole-world UV.
  // Never rescale a brush to the dimensions or origin of the current tile.
  const last = regional ? 1 : size - 1,
    radius = stroke.radius * last;
  const originU = regional
    ? (fieldCoordinate(sampling!.grid, 'X', 0) - domain!.originX) / domain!.width
    : 0;
  const originV = regional
    ? (fieldCoordinate(sampling!.grid, 'Z', 0) - domain!.originZ) / domain!.depth
    : 0;
  const stepU = regional ? sampling!.grid.spacingX / domain!.width : 1;
  const stepV = regional ? sampling!.grid.spacingZ / domain!.depth : 1;
  const authorX = (x: number) =>
    regional ? (fieldCoordinate(sampling!.grid, 'X', x) - domain!.originX) / domain!.width : x;
  const authorY = (y: number) =>
    regional ? (fieldCoordinate(sampling!.grid, 'Z', y) - domain!.originZ) / domain!.depth : y;
  const lower = (value: number) => (regional ? value : Math.ceil(value));
  const upper = (value: number) => (regional ? value : Math.floor(value));
  const angle = ((stroke.angle ?? 0) * Math.PI) / 180,
    cos = Math.cos(angle),
    sin = Math.sin(angle);
  const aspect = stroke.aspect ?? 1,
    seed = stroke.seed ?? context?.project.seed ?? 0;
  const pressureRadius = stroke.pressure === 'radius' || stroke.pressure === 'both';
  const pressureStrength = stroke.pressure === 'strength' || stroke.pressure === 'both';
  const mask = createMaskEvaluator(stroke.mask, context, context?.project.seed ?? seed);
  const segments: Segment[] = [];
  const add = (a: PaintPoint, b: PaintPoint) => {
    const x = a.u * last,
      y = a.v * last,
      dx = (b.u - a.u) * last,
      dy = (b.v - a.v) * last;
    segments.push({
      x,
      y,
      dx,
      dy,
      top: lower(Math.min(y, y + dy) - radius),
      bottom: upper(Math.max(y, y + dy) + radius),
      left: lower(Math.min(x, x + dx) - radius),
      right: upper(Math.max(x, x + dx) + radius),
      p0: a.pressure ?? 1,
      p1: b.pressure ?? 1,
    });
  };
  const stamped =
    stroke.texture === 'scatter' || (stroke.spacing ?? 0.12) > 0.35 || (stroke.jitter ?? 0) > 0;
  if (!stroke.fullTile && stamped) {
    const pathLength = stroke.points
      .slice(1)
      .reduce(
        (sum, point, i) =>
          sum + Math.hypot(point.u - stroke.points[i].u, point.v - stroke.points[i].v),
        0,
      );
    const spacing = Math.max(
      0.00005,
      stroke.radius * 2 * (stroke.spacing ?? 0.25),
      pathLength / (MAX_STROKE_POINTS * 8 - 1),
    );
    let stamp = 0,
      remaining = 0;
    const emit = (point: PaintPoint) => {
      const jitter = (stroke.jitter ?? 0) * stroke.radius * 0.8;
      const p = {
        ...point,
        u: point.u + (hash(stamp, 7, seed) * 2 - 1) * jitter,
        v: point.v + (hash(stamp, 31, seed) * 2 - 1) * jitter,
      };
      add(p, p);
      stamp++;
    };
    emit(stroke.points[0]);
    remaining = spacing;
    for (let i = 1; i < stroke.points.length; i++) {
      const a = stroke.points[i - 1],
        b = stroke.points[i];
      const length = Math.hypot(b.u - a.u, b.v - a.v);
      let distance = remaining;
      while (distance <= length) {
        const t = length ? distance / length : 0;
        emit({
          u: a.u + (b.u - a.u) * t,
          v: a.v + (b.v - a.v) * t,
          pressure: (a.pressure ?? 1) + ((b.pressure ?? 1) - (a.pressure ?? 1)) * t,
        });
        distance += spacing;
      }
      remaining = distance - length;
    }
  } else if (!stroke.fullTile) {
    for (let i = 0; i < Math.max(1, stroke.points.length - 1); i++)
      add(stroke.points[i], stroke.points[i + 1] ?? stroke.points[i]);
  }
  const firstRow = stroke.fullTile
    ? 0
    : Math.max(0, Math.ceil((Math.min(...segments.map((s) => s.top)) - originV) / stepV));
  const lastRow = stroke.fullTile
    ? rows - 1
    : Math.min(
        rows - 1,
        Math.floor((Math.max(...segments.map((s) => s.bottom)) - originV) / stepV),
      );
  const output = new Float32Array(size);
  const weight = (pixelX: number, pixelY: number, candidates = segments) => {
    if (pixelY < firstRow || pixelY > lastRow) return 0;
    const x = authorX(pixelX),
      y = authorY(pixelY);
    const u = x / last,
      v = y / last;
    if (stroke.selection && !pointInPaintSelection(stroke.selection, { u, v })) return 0;
    let coverage = stroke.fullTile ? 1 : 0;
    for (const s of candidates) {
      if (y < s.top || y > s.bottom || x < s.left || x > s.right) continue;
      const ox = x - s.x,
        oy = y - s.y;
      const ex = ox * cos + oy * sin,
        ey = (-ox * sin + oy * cos) / aspect;
      const dx = s.dx * cos + s.dy * sin,
        dy = (-s.dx * sin + s.dy * cos) / aspect;
      const length2 = dx * dx + dy * dy;
      const t = length2 ? clampPaint((ex * dx + ey * dy) / length2) : 0;
      const p = s.p0 + (s.p1 - s.p0) * t;
      const r = radius * (pressureRadius ? Math.max(0.05, p) : 1);
      const distance2 = (ex - dx * t) ** 2 + (ey - dy * t) ** 2;
      if (distance2 > r * r) continue;
      const d = Math.sqrt(distance2) / r;
      const f = d <= stroke.hardness ? 1 : smooth((1 - d) / (1 - stroke.hardness));
      coverage = Math.max(coverage, f * (pressureStrength ? p : 1));
    }
    if (!coverage) return 0;
    if (stroke.texture === 'grain') {
      const scale = Math.max(stroke.radius * 0.18, 0.00005);
      const coarse = noise(u / scale, v / scale, seed);
      const fine = noise(u / (scale * 0.28), v / (scale * 0.28), seed + 17);
      coverage *= 0.18 + 0.82 * smooth((coarse * 0.65 + fine * 0.35 - 0.15) / 0.7);
    }
    return clampPaint(coverage * stroke.strength * mask(pixelX, pixelY));
  };
  return {
    firstRow,
    lastRow,
    weight,
    row(y: number) {
      output.fill(0);
      if (y < firstRow || y > lastRow) return output;
      // Skip unpainted margins even for small dabs on large maps.
      const ay = authorY(y);
      const relevant = segments.filter((s) => ay >= s.top && ay <= s.bottom);
      const lo = stroke.fullTile
        ? 0
        : Math.max(0, Math.ceil((Math.min(...relevant.map((s) => s.left)) - originU) / stepU));
      const hi = stroke.fullTile
        ? size - 1
        : Math.min(
            size - 1,
            Math.floor((Math.max(...relevant.map((s) => s.right)) - originU) / stepU),
          );
      for (let x = lo; x <= hi; x++) output[x] = weight(x, y, relevant);
      return output;
    },
  };
}

/** Legacy/isolated layer raster. Opacity is applied once per swept stroke. */
export function createMaterialPaintRaster(
  strokes: readonly MaterialStroke[] | undefined,
  size: number,
  context?: PaintRasterContext,
) {
  if (!strokes?.length) return undefined;
  const coverage = new Float32Array(size * 4);
  const paths = strokes.map((stroke) => ({
    stroke,
    raster: createStrokeRaster(stroke, size, context),
  }));
  return {
    row(y: number) {
      coverage.fill(0);
      for (const { stroke, raster } of paths) {
        if (y < raster.firstRow || y > raster.lastRow) continue;
        const alpha = raster.row(y),
          target = channel[stroke.layer];
        for (let x = 0; x < size; x++) {
          const a = alpha[x];
          if (!a) continue;
          const p = x * 4;
          for (let c = 0; c < 4; c++) coverage[p + c] *= 1 - a;
          if (target >= 0) coverage[p + target] += a;
        }
      }
      return coverage;
    },
  };
}
