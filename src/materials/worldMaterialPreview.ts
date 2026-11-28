import type { FieldSampling } from '../engine/fields';
import { gridSpacing } from '../engine/world/grid';
import type { WorldRegionResult, WorldSampleGrid } from '../engine/world/types';
import type { HeightField, TerrainProject } from '../model/types';
import type { WorldDefinition } from '../model/world';
import { materialRanges, type MaterialRanges } from './layerSynthesis';
import { generateMaterialRegion, materialNormalRegion } from './pbr';

export const WORLD_MATERIAL_PREVIEW_MAX_SIDE = 513;

export interface WorldMaterialPreviewSource {
  field: HeightField;
  sampling: FieldSampling;
}

export interface WorldMaterialPreview {
  width: number;
  height: number;
  basecolor: Uint8ClampedArray;
  orm: Uint8ClampedArray;
  detailNormal: Uint8ClampedArray;
}

/** Registers the bounded preview in the same physical coordinate/paint system
 * as the export baker. The preview has no neighboring terrain beyond its
 * footprint; edge AO is deliberately a preview approximation. */
export function worldMaterialPreviewSource(
  result: WorldRegionResult,
  world: WorldDefinition,
  grid: WorldSampleGrid,
): WorldMaterialPreviewSource {
  const d = world.domain;
  const extentX = (grid.cellsX / d.cellsX) * d.width;
  const extentZ = (grid.cellsZ / d.cellsZ) * d.depth;
  const originX = d.originX + (grid.startX / d.cellsX) * d.width;
  const originZ = d.originZ + (grid.startZ / d.cellsZ) * d.depth;
  return {
    field: {
      resolution: result.width,
      height: result.heights,
      flow: result.flow,
      wear: result.wear,
      deposition: result.deposition,
    },
    sampling: {
      grid: {
        width: result.width,
        height: result.height,
        originX,
        originZ,
        spacingX: gridSpacing(d, grid, 'X'),
        spacingZ: gridSpacing(d, grid, 'Z'),
        heightScale: d.heightScale,
        datum: d.datum,
        lattice: {
          originX,
          originZ,
          extentX,
          extentZ,
          cellsX: result.width - 1,
          cellsZ: result.height - 1,
          offsetX: 0,
          offsetZ: 0,
        },
      },
      paint: { originX: d.originX, originZ: d.originZ, width: d.width, depth: d.depth },
    },
  };
}

/** Synthesis and packing run exclusively in a worker in the application. */
export function bakeWorldMaterialPreview(
  source: WorldMaterialPreviewSource,
  project: TerrainProject,
  ranges: MaterialRanges = materialRanges(source.field),
): WorldMaterialPreview {
  const { field, sampling } = source;
  const { width, height } = sampling.grid;
  if (width > WORLD_MATERIAL_PREVIEW_MAX_SIDE || height > WORLD_MATERIAL_PREVIEW_MAX_SIDE)
    throw new Error('World material previews are limited to 513 samples per axis.');
  const rect = { left: 0, top: 0, right: width, bottom: height };
  const maps = generateMaterialRegion(field, project, rect, ranges, sampling);
  const detailNormal = materialNormalRegion(
    maps.detail,
    rect,
    rect,
    field,
    project,
    true,
    false,
    sampling.grid,
  );
  const orm = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    orm[i * 4] = maps.ao[i];
    orm[i * 4 + 1] = maps.roughness[i];
    orm[i * 4 + 2] = 0;
    orm[i * 4 + 3] = 255;
  }
  return { width, height, basecolor: maps.basecolor, orm, detailNormal };
}

export interface WorldMaterialPreviewRequest {
  type: 'bake';
  id: number;
  fieldId: number;
  source?: WorldMaterialPreviewSource;
  project: TerrainProject;
  ranges: MaterialRanges;
}
export type WorldMaterialPreviewResponse =
  | { type: 'result'; id: number; fieldId: number; maps: WorldMaterialPreview }
  | { type: 'error'; id: number; message: string };
