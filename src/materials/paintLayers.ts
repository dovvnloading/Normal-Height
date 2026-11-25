import type { HeightField, TerrainProject } from '../model/types';
import { MAX_PROJECT_FILE_BYTES } from '../model/heightRaster';
import { assertProjectStorageBudget, projectStorageBytes } from '../model/projectStorage';
import {
  MAX_PAINT_POINTS,
  MAX_PAINT_STROKES,
  MATERIAL_LAYERS,
  clampPaint,
  createMaskEvaluator,
  createMaterialPaintRaster,
  createStrokeRaster,
  parseMaterialPaint,
  parsePaintMask,
  pointInPaintSelection,
  paintChannel,
  type MaterialLayer,
  type MaterialStroke,
  type PaintMask,
  type PaintPoint,
  type PaintSelection,
} from './materialPaint';

export interface PaintLayer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  strokes: MaterialStroke[];
  mask?: PaintMask;
}
export const MAX_PAINT_LAYERS = 64;
const LEGACY_LAYER_ID = 'paint-base';
const EMPTY_STROKES: MaterialStroke[] = [];
const legacyLayers = new WeakMap<MaterialStroke[], PaintLayer[]>();
const allStrokes = new WeakMap<PaintLayer[], MaterialStroke[]>();

export function createPaintLayer(name = 'Paint layer', id?: string): PaintLayer {
  return {
    id: id ?? `paint-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
    name: name.trim().slice(0, 80) || 'Paint layer',
    visible: true,
    locked: false,
    opacity: 1,
    strokes: [],
  };
}
/** No project mutation occurs when viewing a legacy file. Migration is on edit. */
export function getPaintLayers(
  project: Pick<TerrainProject, 'materialPaint' | 'paintLayers'>,
): PaintLayer[] {
  if (project.paintLayers) return project.paintLayers;
  const strokes = project.materialPaint ?? EMPTY_STROKES;
  let layers = legacyLayers.get(strokes);
  if (!layers) {
    layers = [{ ...createPaintLayer('Base paint', LEGACY_LAYER_ID), strokes }];
    legacyLayers.set(strokes, layers);
  }
  return layers;
}
/** Includes hidden layers for limits/history. Rendering respects their visibility. */
export function getPaintStrokes(
  project: Pick<TerrainProject, 'materialPaint' | 'paintLayers'>,
): MaterialStroke[] {
  if (!project.paintLayers) return project.materialPaint ?? EMPTY_STROKES;
  let strokes = allStrokes.get(project.paintLayers);
  if (!strokes) {
    strokes = project.paintLayers.flatMap((layer) => layer.strokes);
    allStrokes.set(project.paintLayers, strokes);
  }
  return strokes;
}
export function paintCapacity(project: TerrainProject) {
  const strokes = getPaintStrokes(project),
    points = strokes.reduce((sum, stroke) => sum + stroke.points.length, 0),
    bytes = projectStorageBytes(project);
  return {
    strokes: strokes.length,
    points,
    layers: getPaintLayers(project).length,
    maxStrokes: MAX_PAINT_STROKES,
    maxPoints: MAX_PAINT_POINTS,
    maxLayers: MAX_PAINT_LAYERS,
    bytes,
    maxBytes: MAX_PROJECT_FILE_BYTES,
    ratio: Math.max(strokes.length / MAX_PAINT_STROKES, points / MAX_PAINT_POINTS, bytes / MAX_PROJECT_FILE_BYTES),
  };
}
function assertCapacity(layers: readonly PaintLayer[]) {
  if (layers.length > MAX_PAINT_LAYERS)
    throw new Error(`A project supports up to ${MAX_PAINT_LAYERS} paint layers.`);
  let points = 0,
    strokes = 0;
  for (const layer of layers) {
    strokes += layer.strokes.length;
    for (const stroke of layer.strokes) points += stroke.points.length;
  }
  if (strokes > MAX_PAINT_STROKES || points > MAX_PAINT_POINTS)
    throw new Error(
      `Paint storage is full (${MAX_PAINT_STROKES.toLocaleString()} strokes / ${MAX_PAINT_POINTS.toLocaleString()} points). Remove an unused layer or undo a stroke before painting.`,
    );
}
/** A single gesture (including mirrored paths) is one immutable project edit. */
export function applyPaintStrokes(
  project: TerrainProject,
  strokes: MaterialStroke[],
  activeLayerId?: string,
): TerrainProject {
  if (!strokes.length) return project;
  // Validate before authoring. Keep original stroke identities for the live
  // preview/final bake handoff; parsing here is validation, not a rewrite.
  parseMaterialPaint(strokes);
  const layers = getPaintLayers(project);
  let index = activeLayerId
    ? layers.findIndex((layer) => layer.id === activeLayerId)
    : layers.length - 1;
  const next = [...layers];
  if (index < 0 && layers.length === 0) {
    next.push(createPaintLayer('Paint layer 1'));
    index = 0;
  }
  if (index < 0) throw new Error('Choose a paint layer before painting.');
  const layer = next[index];
  if (layer.locked)
    throw new Error(`“${layer.name}” is locked. Unlock it or choose another paint layer.`);
  if (!layer.visible) throw new Error(`“${layer.name}” is hidden. Show it before painting.`);
  next[index] = { ...layer, strokes: [...layer.strokes, ...strokes] };
  assertCapacity(next);
  // Legacy brush callers retain their original serialization until the first
  // explicit layer operation, so older files/tests remain compatible.
  const result =
    !project.paintLayers &&
    next.length === 1 &&
    (!activeLayerId || activeLayerId === LEGACY_LAYER_ID)
      ? { ...project, materialPaint: next[0].strokes }
      : { ...project, materialPaint: undefined, paintLayers: next };
  assertProjectStorageBudget(result);
  return result;
}
export function parsePaintLayers(input: unknown): PaintLayer[] {
  if (!Array.isArray(input) || input.length > MAX_PAINT_LAYERS)
    throw new Error('Invalid paint layer stack.');
  const ids = new Set<string>();
  const result = input.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid paint layer.');
    const layer = raw as PaintLayer;
    if (
      typeof layer.id !== 'string' ||
      !layer.id ||
      layer.id.length > 100 ||
      ids.has(layer.id) ||
      ['__proto__', 'constructor', 'prototype'].includes(layer.id) ||
      typeof layer.name !== 'string' ||
      typeof layer.visible !== 'boolean' ||
      typeof layer.locked !== 'boolean' ||
      typeof layer.opacity !== 'number' ||
      !Number.isFinite(layer.opacity) ||
      layer.opacity < 0 ||
      layer.opacity > 1
    )
      throw new Error('Invalid paint layer properties or duplicate identifier.');
    ids.add(layer.id);
    return {
      id: layer.id,
      name: layer.name.slice(0, 80),
      visible: layer.visible,
      locked: layer.locked,
      opacity: layer.opacity,
      strokes: parseMaterialPaint(layer.strokes),
      ...(layer.mask !== undefined ? { mask: parsePaintMask(layer.mask) } : {}),
    };
  });
  assertCapacity(result);
  return result;
}

const paintIds = new WeakMap<object, number>();
let nextPaintId = 0;
function strokeListId(strokes: MaterialStroke[] | undefined) {
  if (!strokes?.length) return 0;
  let id = paintIds.get(strokes);
  if (!id) {
    id = ++nextPaintId;
    paintIds.set(strokes, id);
  }
  return id;
}
export function paintLayerSignature(
  project: Pick<TerrainProject, 'materialPaint' | 'paintLayers'>,
) {
  // Renaming and locking are editing metadata; they must not trigger expensive
  // texture/mesh regeneration. Rendering settings are in paintStackKey.
  return project.paintLayers
    ? `layers:${project.paintLayers.map((layer) => strokeListId(layer.strokes)).join(',')}`
    : `strokes:${strokeListId(project.materialPaint)}`;
}
/** Group settings only: stroke changes may still use a spatially local bake. */
export function paintStackKey(project: TerrainProject) {
  return project.paintLayers
    ? JSON.stringify(
        project.paintLayers.map(({ id, visible, opacity, mask }) => [id, visible, opacity, mask]),
      )
    : 'legacy';
}
export function samplePaintMaterial(
  splat: Uint8ClampedArray | Uint8Array,
  resolution: number,
  point: PaintPoint,
): MaterialLayer {
  const x = Math.round(clampPaint(point.u) * (resolution - 1)),
    y = Math.round(clampPaint(point.v) * (resolution - 1));
  const i = (y * resolution + x) * 4;
  let best = 0;
  for (let c = 1; c < 4; c++) if (splat[i + c] > splat[i + best]) best = c;
  return MATERIAL_LAYERS[best];
}
/** Connected four-neighbour material region; saved runs replay at any bake size. */
export function floodPaintSelection(
  splat: Uint8ClampedArray | Uint8Array,
  resolution: number,
  point: PaintPoint,
  tolerance = 0.2,
  restriction?: PaintSelection,
): PaintSelection {
  if (
    !Number.isInteger(resolution) ||
    resolution < 2 ||
    splat.length !== resolution * resolution * 4
  )
    throw new Error('A material map is required for the fill tool.');
  // Do not downsample a previously selected region merely because the current
  // material preview is smaller. The fill grid is still bounded at 512.
  const n = Math.max(Math.min(512, resolution), restriction?.region?.resolution ?? 0),
    count = n * n;
  const source = (x: number, y: number) =>
    (Math.round((y / (n - 1)) * (resolution - 1)) * resolution +
      Math.round((x / (n - 1)) * (resolution - 1))) *
    4;
  const startX = Math.round(clampPaint(point.u) * (n - 1)),
    startY = Math.round(clampPaint(point.v) * (n - 1));
  const first = source(startX, startY),
    target = Array.from(splat.slice(first, first + 4));
  const visited = new Uint8Array(count),
    selected = new Uint8Array(count),
    queue = new Int32Array(count);
  let head = 0,
    tail = 1;
  queue[0] = startY * n + startX;
  visited[queue[0]] = 1;
  const limit = clampPaint(tolerance) * 510;
  while (head < tail) {
    const i = queue[head++],
      x = i % n,
      y = Math.floor(i / n),
      p = source(x, y);
    let distance = 0;
    for (let c = 0; c < 4; c++) distance += Math.abs(splat[p + c] - target[c]);
    if (distance > limit || !pointInPaintSelection(restriction, { u: x / (n - 1), v: y / (n - 1) })) continue;
    selected[i] = 1;
    const neighbours = [
      x > 0 ? i - 1 : -1,
      x + 1 < n ? i + 1 : -1,
      y > 0 ? i - n : -1,
      y + 1 < n ? i + n : -1,
    ];
    for (const next of neighbours)
      if (next >= 0 && !visited[next]) {
        visited[next] = 1;
        queue[tail++] = next;
      }
  }
  const runs: number[] = [];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n;) {
      if (!selected[y * n + x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < n && selected[y * n + x]) x++;
      runs.push(y, start, x);
    }
  return { points: [], region: { resolution: n, runs } };
}

type Weights = readonly number[];
const mixCoverage = (under: Weights, local: Weights, opacity = 1): number[] => {
  const alpha = Math.min(1, local[0] + local[1] + local[2] + local[3]) * opacity;
  return [0, 1, 2, 3].map((c) => under[c] * (1 - alpha) + local[c] * opacity);
};
export interface ProjectPaintRaster {
  /** Refresh the row cache before apply(). */
  row(y: number): Float32Array;
  apply(x: number, y: number, procedural: Weights): number[];
}
/**
 * Strokes composite inside an isolated layer; layer opacity/masks are applied
 * exactly once. Erase reveals the layers below, never edits another layer.
 * Normal painting has a streaming row path. Blend/Replace use the same stroke
 * weights and a bounded, memoized sampler of the preceding material revision.
 */
export function createProjectPaintRaster(
  project: TerrainProject,
  field: HeightField,
  proceduralSample?: (x: number, y: number) => Weights,
): ProjectPaintRaster | undefined {
  const layers = getPaintLayers(project).filter(
    (layer) => layer.visible && layer.opacity > 0 && layer.strokes.length,
  );
  if (!layers.length) return undefined;
  const n = field.resolution,
    context = { field, project };
  const output = new Float32Array(n * 4);
  let currentRow = -1;
  const advanced = layers.some((layer) =>
    layer.strokes.some((stroke) => stroke.mode === 'blend' || stroke.mode === 'replace'),
  );
  if (!advanced) {
    const groups = layers.map((layer) => ({
      layer,
      raster: createMaterialPaintRaster(layer.strokes, n, context)!,
      mask: createMaskEvaluator(layer.mask, context, project.seed),
    }));
    const row = (y: number) => {
      if (currentRow === y) return output;
      currentRow = y;
      output.fill(0);
      for (const { layer, raster, mask } of groups) {
        const coverage = raster.row(y);
        for (let x = 0; x < n; x++) {
          const p = x * 4,
            opacity = layer.opacity * mask(x, y);
          const alpha =
            Math.min(1, coverage[p] + coverage[p + 1] + coverage[p + 2] + coverage[p + 3]) *
            opacity;
          if (!alpha) continue;
          for (let c = 0; c < 4; c++)
            output[p + c] = output[p + c] * (1 - alpha) + coverage[p + c] * opacity;
        }
      }
      return output;
    };
    const blended = [0, 0, 0, 0];
    return {
      row,
      apply(x, y, base) {
        row(y);
        const p = x * 4;
        const alpha = Math.min(1, output[p] + output[p + 1] + output[p + 2] + output[p + 3]);
        for (let c = 0; c < 4; c++) blended[c] = base[c] * (1 - alpha) + output[p + c];
        return blended;
      },
    };
  }
  let sequence = 0;
  const groups = layers.map((layer) => {
    const start = sequence;
    const paths = layer.strokes.map((stroke) => ({
      stroke,
      raster: createStrokeRaster(stroke, n, context),
      order: sequence++,
    }));
    const rows = new Map<number, typeof paths>();
    return {
      layer,
      start,
      end: sequence,
      mask: createMaskEvaluator(layer.mask, context, project.seed),
      pathsAt(y: number) {
        let active = rows.get(y);
        if (!active) {
          active = paths.filter((path) => y >= path.raster.firstRow && y <= path.raster.lastRow);
          rows.set(y, active);
        }
        return active;
      },
    };
  });
  // The small neighbourhood is shared heavily by adjacent output pixels.
  // Bound memory independently of terrain/export dimensions.
  const memo = new Map<number, number[]>();
  const baseMemo = new Map<number, number[]>();
  const cached = (cache: Map<number, number[]>, key: number) => {
    const value = cache.get(key);
    if (value) {
      cache.delete(key);
      cache.set(key, value);
    }
    return value;
  };
  const remember = (cache: Map<number, number[]>, key: number, value: number[], limit: number) => {
    if (cache.size >= limit) cache.delete(cache.keys().next().value!);
    cache.set(key, value);
  };
  const baseAt = (x: number, y: number, fallback: Weights) => {
    const index = y * n + x;
    let value = cached(baseMemo, index);
    if (!value) {
      value = Array.from(proceduralSample?.(x, y) ?? fallback);
      remember(baseMemo, index, value, 16384);
    }
    return value;
  };
  const evaluate = (
    x: number,
    y: number,
    base: Weights,
    stop = sequence,
    rawLast = false,
  ): number[] => {
    let result = Array.from(base);
    for (const { layer, mask, start, end, pathsAt } of groups) {
      if (start >= stop) break;
      const local = [0, 0, 0, 0];
      const stopped = stop < end;
      for (const { stroke, raster, order } of pathsAt(y)) {
        if (order >= stop) break;
        const alpha = raster.weight(x, y);
        if (!alpha) continue;
        const target = paintChannel(stroke.layer);
        if (target < 0) {
          for (let c = 0; c < 4; c++) local[c] *= 1 - alpha;
          continue;
        }
        if (stroke.mode === 'replace') {
          const source = paintChannel(stroke.source ?? 'rock');
          if (source === target) continue;
          const visible = mixCoverage(result, local),
            amount = visible[source] * alpha;
          if (!amount) continue;
          visible[source] -= amount;
          visible[target] += amount;
          for (let c = 0; c < 4; c++) local[c] = visible[c];
        } else if (stroke.mode === 'blend') {
          const visible = mixCoverage(result, local),
            average = [0, 0, 0, 0];
          const distance = Math.max(1, Math.min(8, Math.round(stroke.radius * (n - 1) * 0.22)));
          const offsets = [
            [0, 0],
            [-distance, 0],
            [distance, 0],
            [0, -distance],
            [0, distance],
          ];
          for (const [dx, dy] of offsets) {
            const sx = Math.max(0, Math.min(n - 1, x + dx)),
              sy = Math.max(0, Math.min(n - 1, y + dy));
            const key = order * n * n + sy * n + sx;
            let sample = cached(memo, key);
            if (!sample) {
              sample = evaluate(sx, sy, baseAt(sx, sy, base), order, true);
              remember(memo, key, sample, 65536);
            }
            for (let c = 0; c < 4; c++) average[c] += sample[c] / offsets.length;
          }
          for (let c = 0; c < 4; c++) local[c] = visible[c] * (1 - alpha) + average[c] * alpha;
        } else {
          for (let c = 0; c < 4; c++) local[c] *= 1 - alpha;
          local[target] += alpha;
        }
      }
      result = mixCoverage(result, local, stopped && rawLast ? 1 : layer.opacity * mask(x, y));
      if (stopped) break;
    }
    return result;
  };
  return {
    row(y) {
      currentRow = y;
      return output;
    },
    apply(x, y, base) {
      return evaluate(x, y, base);
    },
  };
}
