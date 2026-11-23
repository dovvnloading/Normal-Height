import { rasterBytes, type HeightRaster } from './heightRaster';
import type { TerrainProject } from './types';

const MAX_UNDO_STEPS = 60;
const MAX_HISTORY_RASTER_BYTES = 64 * 1024 * 1024;

/** Keep a contiguous undo stack, counting shared source rasters once across all snapshots. */
export function appendUndoSnapshot(
  history: TerrainProject[],
  previous: TerrainProject,
  current: TerrainProject,
): TerrainProject[] {
  const candidates = [...history.slice(1 - MAX_UNDO_STEPS), previous];
  const seen = new Set<HeightRaster>();
  let bytes = 0;
  const countSources = (project: TerrainProject) => {
    for (const { raster } of project.graph.nodes) {
      if (raster && !seen.has(raster)) {
        seen.add(raster);
        bytes += rasterBytes(raster);
      }
    }
  };
  // Undo/redo move the current project between stacks. Including it here
  // keeps the entire retained set bounded through either operation.
  countSources(current);
  for (let i = candidates.length - 1; i >= 0; i--) {
    countSources(candidates[i]);
    if (bytes > MAX_HISTORY_RASTER_BYTES) return candidates.slice(i + 1);
  }
  return candidates;
}
