import type { HeightField, TerrainProject } from '../model/types';
import { resolveSurface } from './pbr';
import type { PBRMaps } from './pbr';

import { paintChangeBounds, rectArea, type TexelRect } from './materialRegion';
import type { MaterialRanges } from './layerSynthesis';
import type { MaterialStroke } from './materialPaint';
import { getPaintStrokes, paintLayerSignature, paintStackKey } from './paintLayers';
import {
  assemblePreview,
  type PreviewSnapshot,
  type PackedPreview,
  type PreviewBake,
} from './previewBake';
export type { PackedPreview } from './previewBake';

interface Job {
  surface: string;
  strokes: readonly MaterialStroke[];
  snapshot?: PreviewSnapshot;
  worker: Worker | null;
  promise: Promise<PBRMaps>;
  reject: (error: Error) => void;
  users: number;
  finished: boolean;
}

// Field identity is the terrain revision. Surface edits do not invalidate the
// erosion field; a physical/material signature distinguishes its PBR variants.
const cache = new WeakMap<HeightField, Map<string, Job>>();

const ranges = new WeakMap<HeightField, MaterialRanges>();

// Kept for as long as the maps themselves, so a cached material variant
// (e.g. an artist toggling between two settings) never repacks on the main thread.
const previews = new WeakMap<PBRMaps, PackedPreview>();

/** The worker-packed preview for these maps, or null if it must be packed here. */
export function packedPreview(maps: PBRMaps): PackedPreview | null {
  return previews.get(maps) ?? null;
}

function surfaceKey(project: TerrainProject) {
  return JSON.stringify([
    project.seed,
    project.worldSize,
    project.heightScale,
    resolveSurface(project.surface),
    paintStackKey(project),
  ]);
}
export function pbrVariantKey(project: TerrainProject): string {
  return `${surfaceKey(project)}|${paintLayerSignature(project)}`;
}

function incrementalBase(
  variants: Map<string, Job>,
  surface: string,
  strokes: readonly MaterialStroke[],
  n: number,
) {
  let best: { snapshot: PreviewSnapshot; dirty: TexelRect } | undefined;
  // A large rewrite has little spatial locality. A full transferred bake also
  // avoids copying a previous full set of maps to apply a large patch.
  let bestArea = n * n * 0.45;
  for (const job of variants.values()) {
    if (!job.snapshot || job.surface !== surface) continue;
    const dirty = paintChangeBounds(job.strokes, strokes, n);
    if (!dirty) continue;
    const area = rectArea(dirty);
    if (area < bestArea) {
      bestArea = area;
      best = { snapshot: job.snapshot, dirty };
    }
  }
  return best;
}

function prune(variants: Map<string, Job>, keep: string) {
  for (const [key, entry] of variants) {
    if (variants.size <= 2) break;
    if (key !== keep && entry.finished && !entry.users) variants.delete(key);
  }
}

export function requestPBR(
  field: HeightField,
  project: TerrainProject,
): {
  promise: Promise<PBRMaps>;
  release: () => void;
} {
  let variants = cache.get(field);
  if (!variants) {
    variants = new Map();
    cache.set(field, variants);
  }
  const key = pbrVariantKey(project);
  let job = variants.get(key);
  if (!job) {
    let accept!: (maps: PBRMaps) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<PBRMaps>((resolve, fail) => {
      accept = resolve;
      reject = fail;
    });
    // The main thread never executes generatePBR. Only field buffers are
    // structured-cloned because terrain/3D callers still own their originals.
    const worker = new Worker(new URL('./pbr.worker.ts', import.meta.url), { type: 'module' });
    const surface = surfaceKey(project),
      strokes = getPaintStrokes(project);
    const base = incrementalBase(variants, surface, strokes, field.resolution);
    job = { worker, promise, reject, surface, strokes, users: 0, finished: false };
    const running = job;
    const entries = variants;
    const fail = (message: string) => {
      if (running.finished) return;
      running.finished = true;
      running.worker?.terminate();
      running.worker = null;
      entries.delete(key);
      reject(new Error(message));
    };
    worker.onmessage = (
      event: MessageEvent<
        { type: 'result'; bake: PreviewBake } | { type: 'error'; message: string }
      >,
    ) => {
      if (running.finished) return;
      const message = event.data;
      if (message.type === 'error') {
        fail(message.message);
        return;
      }
      try {
        const snapshot = assemblePreview(field.resolution, message.bake, base?.snapshot);
        previews.set(snapshot.maps, snapshot.packed);
        ranges.set(field, message.bake.ranges);
        running.snapshot = snapshot;
        running.finished = true;
        running.worker?.terminate();
        running.worker = null;
        accept(snapshot.maps);
        prune(entries, key);
      } catch (error) {
        fail(error instanceof Error ? error.message : 'Could not apply material pixels.');
      }
    };
    worker.onerror = (event) => fail(event.message || 'PBR material worker failed.');
    variants.set(key, running);
    try {
      worker.postMessage({ field, project, dirty: base?.dirty, ranges: ranges.get(field) });
    } catch (error) {
      fail(error instanceof Error ? error.message : 'Could not send terrain to material worker.');
    }
    prune(variants, key);
  }
  const active = job;
  active.users++;
  let released = false;
  return {
    promise: active.promise,
    release: () => {
      if (released) return;
      released = true;
      active.users--;
      if (!active.finished && active.users === 0) {
        active.finished = true;
        active.worker?.terminate();
        active.worker = null;
        variants!.delete(key);
        active.reject(new Error('PBR request superseded.'));
      }
      prune(variants!, key);
    },
  };
}
