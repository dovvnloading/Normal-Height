import type { HeightField, TerrainProject } from '../model/types';
import type { PBRMaps } from '../materials/pbr';
import { pbrPixels } from '../materials/pbr';

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
  const orm = pbrPixels(maps, field, project, 'orm');
  const microNormal = pbrPixels(maps, field, project, 'detailNormal');
  const n = maps.resolution;
  if (maps.splat.length !== n * n * 4) throw new Error('Preview splat dimensions do not match.');
  for (let p = 0; p < n * n * 4; p += 4) {
    orm[p + 2] = maps.splat[p];      // Rock; B not sampled by MeshStandardMaterial
    orm[p + 3] = maps.splat[p + 1];  // Soil; A is not used in opaque ORM sampling
    microNormal[p + 3] = maps.splat[p + 2]; // Vegetation; normalMap consumes RGB only
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
