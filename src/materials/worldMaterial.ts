import { AO_RADII_METERS } from './terrainAnalysis';
import { generateMaterialRegion, materialNormalRegion } from './pbr';
import type { MaterialBuffers } from './pbr';
import type { MaterialRanges } from './layerSynthesis';
import { getPaintLayers } from './paintLayers';
import type { FieldSampling } from '../engine/fields';
import type { HeightField, TerrainProject } from '../model/types';
import type { WorldDefinition } from '../model/world';
import type { TexelRect } from './materialRegion';

export const WORLD_MATERIAL_MAPS = [
  'basecolor',
  'roughness',
  'ao',
  'orm',
  'splat',
  'curvature',
  'materialNormalGL',
  'materialNormalDX',
  'detailNormalGL',
  'relief',
] as const;
export type WorldMaterialMap = (typeof WORLD_MATERIAL_MAPS)[number];
export function isWorldMaterialMap(map: string): map is WorldMaterialMap {
  return (WORLD_MATERIAL_MAPS as readonly string[]).includes(map);
}

/** A nested Blend stroke can read an earlier Blend. Sum dependency radii,
 * rather than silently clamping reads at the boundary of an export tile. */
export function worldMaterialHalo(
  project: TerrainProject,
  world: WorldDefinition,
  dx: number,
  dz: number,
) {
  const radius = Math.max(0, ...AO_RADII_METERS.filter((m) => m / Math.max(dx, dz) >= 2));
  let blendX = 0,
    blendZ = 0;
  for (const layer of getPaintLayers(project)) {
    if (!layer.visible || layer.opacity <= 0) continue;
    for (const stroke of layer.strokes)
      if (stroke.mode === 'blend') {
        blendX += Math.max(
          1,
          Math.min(8, Math.round(((stroke.radius * world.domain.width) / dx) * 0.22)),
        );
        blendZ += Math.max(
          1,
          Math.min(8, Math.round(((stroke.radius * world.domain.depth) / dz) * 0.22)),
        );
      }
  }
  return { x: Math.ceil(radius / dx) + blendX + 2, z: Math.ceil(radius / dz) + blendZ + 2, radius };
}

export interface WorldMaterialBake {
  buffers: MaterialBuffers;
  source: TexelRect;
  target: TexelRect;
  field: HeightField;
  sampling: FieldSampling;
}

/** Reuses the exact Terrain material model on a physically registered region.
 * Height halos contain the full AO/landform radius and recursive paint reads;
 * only the output plus its one-pixel normal halo is synthesized into maps. */
export function bakeWorldMaterial(
  field: HeightField,
  project: TerrainProject,
  ranges: MaterialRanges,
  sampling: FieldSampling,
  target: TexelRect,
): WorldMaterialBake {
  const source = {
    left: Math.max(0, target.left - 1),
    top: Math.max(0, target.top - 1),
    right: Math.min(sampling.grid.width, target.right + 1),
    bottom: Math.min(sampling.grid.height, target.bottom + 1),
  };
  return {
    buffers: generateMaterialRegion(field, project, source, ranges, sampling),
    source,
    target,
    field,
    sampling,
  };
}

/** All channels are RGBA8 except relief, which retains signed physical metres
 * in float32. In particular, splat alpha is snow coverage, never opacity. */
export function worldMaterialValues(
  bake: WorldMaterialBake,
  project: TerrainProject,
  map: WorldMaterialMap,
) {
  const { buffers, source, target, field, sampling } = bake;
  if (map === 'materialNormalGL' || map === 'materialNormalDX' || map === 'detailNormalGL') {
    const pixels = materialNormalRegion(
      buffers.detail,
      source,
      target,
      field,
      project,
      map === 'detailNormalGL',
      map === 'materialNormalDX',
      sampling.grid,
    );
    const width = target.right - target.left;
    return (x: number, z: number, component = 0) => pixels[(z * width + x) * 4 + component] / 255;
  }
  const stride = source.right - source.left;
  return (x: number, z: number, component = 0) => {
    const i = (z + target.top - source.top) * stride + x + target.left - source.left;
    if (map === 'relief') return buffers.detail[i];
    if (map === 'splat' || map === 'basecolor') return buffers[map][i * 4 + component] / 255;
    if (component === 3) return 1;
    if (map === 'orm')
      return component === 0
        ? buffers.ao[i] / 255
        : component === 1
          ? buffers.roughness[i] / 255
          : 0;
    return buffers[map][i] / 255;
  };
}
