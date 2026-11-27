import type { TerrainProject } from '../model/types';
import type { WorldDefinition } from '../model/world';
import type { WorldGridRequest } from '../hooks/worldProtocol';
import { canonical, semanticProjectSignature } from './plan/graph';
import type { HeightRaster } from '../model/heightRaster';

export type WorldPreviewRegion = Pick<WorldGridRequest, 'startX' | 'startZ' | 'cellsX' | 'cellsZ'>;
export type WorldPreviewQuality = 'draft' | 'detail';

/** World evaluation owns its physical domain and reference resolution. Legacy
 * viewport resolution, graph layout, names, and disconnected experiments do
 * not change a World field or discard prepared global context. */
export function worldEvaluationSignature(
  project: TerrainProject,
  world: WorldDefinition,
  previewNodeId?: string,
  rasterSignature?: (raster: HeightRaster) => string | number,
): string {
  return canonical({
    graph: semanticProjectSignature(
      {
        ...project,
        resolution: world.globalResolution,
        worldSize: world.domain.width,
        heightScale: world.domain.heightScale,
      },
      previewNodeId,
      rasterSignature,
    ),
    world: {
      version: world.version,
      domain: world.domain,
      tileCells: world.tileCells,
      globalResolution: world.globalResolution,
      backend: world.backend,
      transport: world.transport?.enabled ? world.transport : undefined,
    },
  });
}

export function worldPreviewRequestKey(revision: string, grid: WorldGridRequest): string {
  return canonical({ revision, grid });
}

/** Samples are bounded independently of the authored world's interval count.
 * Aspect follows physical metres; detail never claims sub-cell source detail. */
export function createWorldPreviewGrid(
  world: WorldDefinition,
  region?: WorldPreviewRegion | null,
  quality: WorldPreviewQuality = 'draft',
): WorldGridRequest {
  const d = world.domain;
  const area = region ?? { startX: 0, startZ: 0, cellsX: d.cellsX, cellsZ: d.cellsZ };
  const width = (d.width * area.cellsX) / d.cellsX;
  const depth = (d.depth * area.cellsZ) / d.cellsZ;
  const longest = quality === 'detail' ? 512 : 384;
  return {
    ...area,
    samplesX: Math.max(
      2,
      Math.min(Math.floor(area.cellsX), Math.round(longest * Math.min(1, width / depth))) + 1,
    ),
    samplesZ: Math.max(
      2,
      Math.min(Math.floor(area.cellsZ), Math.round(longest * Math.min(1, depth / width))) + 1,
    ),
  };
}

export function isWorldOverview(world: WorldDefinition, grid: WorldPreviewRegion): boolean {
  return (
    grid.startX === 0 &&
    grid.startZ === 0 &&
    grid.cellsX === world.domain.cellsX &&
    grid.cellsZ === world.domain.cellsZ
  );
}
