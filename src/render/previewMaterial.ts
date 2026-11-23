import type { HeightField, TerrainProject } from '../model/types';
import type { MaterialBuffers, PBRMaps } from '../materials/pbr';
import { materialNormalRegion } from '../materials/pbr';
import { tileRect, rectArea, type TexelRect } from '../materials/materialRegion';

/**
 * Compact, preview-only material classification sidecar. MeshStandardMaterial
 * consumes ORM.red as AO, ORM.green as roughness, and normal.RGB as the
 * detail normal. ORM.blue/alpha and detail-normal.alpha are unused, so store
 * rock/soil/vegetation in those 3 channels without allocating another GPU map.
 * Snow is the remaining exact 255-sum splat weight.
 *
 * Only live GPU data is repacked. PBR ZIP exports retain glTF ORM (metal=0,
 * alpha=255) and standard OpenGL +Y normal maps (alpha=255).
 */
export function packPreviewPBR(
  maps: PBRMaps,
  field: HeightField,
  project: TerrainProject,
): { orm: Uint8ClampedArray; microNormal: Uint8ClampedArray } {
  const full = tileRect(maps.resolution);
  return packPreviewRegion(maps, full, full, field, project);
}

export function packPreviewRegion(maps: MaterialBuffers, source: TexelRect, target: TexelRect,
  field: HeightField, project: TerrainProject,
): { orm: Uint8ClampedArray; microNormal: Uint8ClampedArray } {
  if (maps.splat.length !== rectArea(source) * 4) throw new Error('Preview splat dimensions do not match.');
  const orm = new Uint8ClampedArray(rectArea(target) * 4);
  const microNormal = materialNormalRegion(maps.detail, source, target, field, project, true);
  const stride = source.right - source.left;
  let p = 0;
  for (let y = target.top; y < target.bottom; y++) {
    let i = (y - source.top) * stride + target.left - source.left;
    for (let x = target.left; x < target.right; x++, i++, p += 4) {
      orm[p] = maps.ao[i];
      orm[p + 1] = maps.roughness[i];
      orm[p + 2] = maps.splat[i * 4];
      orm[p + 3] = maps.splat[i * 4 + 1];
      microNormal[p + 3] = maps.splat[i * 4 + 2];
    }
  }
  return { orm, microNormal };
}

/** Decode the same three bytes that the live fragment shader consumes. */
export function unpackPreviewWeights(
  orm: Uint8ClampedArray,
  microNormal: Uint8ClampedArray,
  pixel: number,
): [number, number, number, number] {
  const p = pixel * 4;
  const rock = orm[p + 2], soil = orm[p + 3], vegetation = microNormal[p + 3];
  return [rock, soil, vegetation, 255 - rock - soil - vegetation];
}
