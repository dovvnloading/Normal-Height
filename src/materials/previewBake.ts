import type { HeightField, TerrainProject } from '../model/types';
import { packPreviewRegion } from '../render/previewMaterial';
import { materialRanges, type MaterialRanges } from './layerSynthesis';
import { padRect, replaceRegion, tileRect, type TexelRect } from './materialRegion';
import { generateMaterialRegion, type MaterialBuffers, type PBRMaps } from './pbr';

export interface PackedPreview {
  orm: Uint8ClampedArray;
  microNormal: Uint8ClampedArray;
}
export interface PreviewBake {
  source: TexelRect;
  target: TexelRect;
  buffers: MaterialBuffers;
  packed: PackedPreview;
  ranges: MaterialRanges;
}
export interface PreviewSnapshot {
  maps: PBRMaps;
  packed: PackedPreview;
}

/** One ring can change normals outside the stroke; their finite differences
 * read one more ring. Both are evaluated against the unmodified full DEM. */
export function bakePreview(
  field: HeightField,
  project: TerrainProject,
  dirty?: TexelRect,
  ranges = materialRanges(field),
): PreviewBake {
  const n = field.resolution;
  const target = dirty ? padRect(dirty, n, 1) : tileRect(n);
  const source = dirty ? padRect(target, n, 1) : target;
  const buffers = generateMaterialRegion(field, project, source, ranges);
  const packed = packPreviewRegion(buffers, source, target, field, project);
  return { source, target, buffers, packed, ranges };
}

export function assemblePreview(
  n: number,
  bake: PreviewBake,
  previous?: PreviewSnapshot,
): PreviewSnapshot {
  const { buffers, packed, source, target } = bake;
  if (!previous) return { maps: { resolution: n, ...buffers }, packed };
  const m = previous.maps;
  // AO and curvature depend only on the DEM and surface settings. Their
  // immutable backing arrays can be shared across compatible paint snapshots.
  const maps: PBRMaps = {
    ...m,
    basecolor: replaceRegion(m.basecolor, buffers.basecolor, source, n, 4),
    splat: replaceRegion(m.splat, buffers.splat, source, n, 4),
    roughness: replaceRegion(m.roughness, buffers.roughness, source, n, 1),
    detail: replaceRegion(m.detail, buffers.detail, source, n, 1),
  };
  return {
    maps,
    packed: {
      orm: replaceRegion(previous.packed.orm, packed.orm, target, n, 4),
      microNormal: replaceRegion(previous.packed.microNormal, packed.microNormal, target, n, 4),
    },
  };
}
