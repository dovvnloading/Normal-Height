import { MAX_PROJECT_FILE_BYTES } from './heightRaster';
import type { TerrainProject } from './types';
import { resolveSurface } from '../materials/pbr';

const encoder = new TextEncoder();
// Project edits replace their graph, layers, strokes and selections immutably.
// Count shared objects once computationally, but count every occurrence in
// the JSON: duplicated layers and repeated selections still occupy file bytes.
const sizes = new WeakMap<object, number>();
function jsonBytes(value: unknown): number {
  if (value === null || value === undefined) return 4;
  if (typeof value === 'string') return encoder.encode(JSON.stringify(value)).byteLength;
  if (typeof value !== 'object') return JSON.stringify(value)?.length ?? 4;
  const cached = sizes.get(value);
  if (cached !== undefined) return cached;
  let bytes = 2;
  if (Array.isArray(value)) {
    bytes += Math.max(0, value.length - 1);
    for (const item of value) bytes += jsonBytes(item);
  } else {
    let count = 0;
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      bytes += (count++ ? 1 : 0) + jsonBytes(key) + 1 + jsonBytes(item);
    }
  }
  sizes.set(value, bytes);
  return bytes;
}

/** Exact compact UTF-8 JSON byte count for the plain, immutable project model. */
export function projectFileBytes(project: TerrainProject): number {
  return jsonBytes(project);
}

/** Include explicit material defaults and reserve resolution digits for exports. */
export function projectStorageBytes(project: TerrainProject): number {
  return projectFileBytes({
    ...project,
    surface: resolveSurface(project.surface),
    resolution: Math.max(16384, project.resolution),
  });
}

export const PROJECT_STORAGE_ERROR =
  'This edit exceeds the 32 MiB project file limit. Remove paint, selections, or imported heightmaps before continuing.';

export function assertProjectStorageBudget(project: TerrainProject) {
  if (projectStorageBytes(project) > MAX_PROJECT_FILE_BYTES) throw new Error(PROJECT_STORAGE_ERROR);
}

/** All downloadable .nhterrain.json files use compact JSON and the same limit
 * as the importer. Check the actual encoded size again at the file boundary. */
export function serializeProjectFile(project: TerrainProject): string {
  if (projectFileBytes(project) > MAX_PROJECT_FILE_BYTES) throw new Error(PROJECT_STORAGE_ERROR);
  const json = JSON.stringify(project);
  if (encoder.encode(json).byteLength > MAX_PROJECT_FILE_BYTES) throw new Error(PROJECT_STORAGE_ERROR);
  return json;
}
