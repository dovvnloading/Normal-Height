import type { HeightField, TerrainProject, ViewSettings } from '../model/types';
import { TERRAIN_SIZE } from './GroundExtension';

/** Water is an artist-facing render layer; it never changes an elevation or export sample. */
export const WATER_PALETTES = {
  lagoon: { label: 'Tropical lagoon', shallow: '#49c9b8', deep: '#093a62', foam: '#e6fff9' },
  alpine: { label: 'Alpine lake', shallow: '#61b5b8', deep: '#142c49', foam: '#f0fcff' },
  ocean: { label: 'Open ocean', shallow: '#238ea9', deep: '#041d3b', foam: '#e4f8ff' },
  dusk: { label: 'Golden hour', shallow: '#6ab4b9', deep: '#172744', foam: '#fff0d9' },
} as const;

export type WaterPalette = keyof typeof WATER_PALETTES;

/** Use only a Coast node upstream of the active terrain output, not a disconnected branch. */
export function linkedCoastLevel(project: TerrainProject): number | null {
  const output = project.graph.nodes.find(node => node.kind === 'output');
  if (!output) return null;
  const nodes = new Map(project.graph.nodes.map(node => [node.id, node]));
  const upstream = new Map<string, string[]>();
  for (const edge of project.graph.edges) {
    const parents = upstream.get(edge.target) ?? [];
    parents.push(edge.source);
    upstream.set(edge.target, parents);
  }
  const seen = new Set<string>();
  const queue = [output.id];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = nodes.get(id);
    if (node?.kind === 'coast' && typeof node.params.seaLevel === 'number' &&
        Number.isFinite(node.params.seaLevel)) {
      return node.params.seaLevel * project.heightScale;
    }
    queue.push(...(upstream.get(id) ?? []));
  }
  return null;
}

const cachedRelief = new WeakMap<Float32Array, { min: number; max: number }>();

export function waterHeightRange(field: HeightField | null, project: TerrainProject): {
  min: number; max: number;
} {
  if (!field || !field.height.length) return { min: -100, max: 1000 };
  let range = cachedRelief.get(field.height);
  if (!range) {
    let min = Infinity, max = -Infinity;
    for (const value of field.height) {
      if (!Number.isFinite(value)) continue;
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    range = Number.isFinite(min) ? { min, max } : { min: -100 / project.heightScale,
      max: 1000 / project.heightScale };
    cachedRelief.set(field.height, range);
  }
  return {
    min: range.min * project.heightScale,
    max: range.max * project.heightScale,
  };
}

/** Auto follows the coast when present, otherwise wets the lowest 22% of relief. */
export function resolveWaterLevelMeters(
  project: TerrainProject, settings: ViewSettings, field: HeightField | null,
): number {
  if (settings.waterLevelMode === 'manual') return settings.waterLevel;
  const linked = linkedCoastLevel(project);
  if (linked !== null) return linked;
  const { min, max } = waterHeightRange(field, project);
  return min + (max - min) * 0.22;
}

/** Keep the waterline fixed in physical meters as exaggeration changes. */
export function waterSceneHeight(levelMeters: number, project: TerrainProject, exaggeration: number): number {
  return levelMeters * TERRAIN_SIZE / Math.max(1, project.worldSize) * exaggeration;
}
