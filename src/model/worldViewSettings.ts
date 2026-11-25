import type { TerrainProject } from './types';
import type { WorldDefinition } from './world';

export type WorldWorkspaceMode = 'explore' | 'setup' | 'simulate' | 'analyze' | 'deliver';
export type WorldPresentation = 'map' | 'terrain' | 'split';
export type WorldDisplayLayer =
  'relief' | 'elevation' | 'flow' | 'wear' | 'deposition' | 'slope' | 'contours' | 'aspect';
export interface WorldViewSettings {
  mode: WorldWorkspaceMode;
  presentation: WorldPresentation;
  layer: WorldDisplayLayer;
  panelWidth: number;
  automatic: boolean;
  cache: boolean;
}
export interface WorldBookmark {
  id: string;
  name: string;
  region: { startX: number; startZ: number; cellsX: number; cellsZ: number };
  domain: string;
}
export const WORLD_VIEW_KEY = 'normal-height.world-view.v1';
const BOOKMARKS_KEY = 'normal-height.world-bookmarks.v1';
export const DEFAULT_WORLD_VIEW: WorldViewSettings = {
  mode: 'explore',
  presentation: 'map',
  layer: 'relief',
  panelWidth: 304,
  automatic: false,
  cache: false,
};

export function parseWorldViewSettings(value: unknown): WorldViewSettings {
  const result = { ...DEFAULT_WORLD_VIEW };
  if (!value || typeof value !== 'object') return result;
  const input = value as Record<string, unknown>;
  if (['explore', 'setup', 'simulate', 'analyze', 'deliver'].includes(String(input.mode)))
    result.mode = input.mode as WorldWorkspaceMode;
  if (['map', 'terrain', 'split'].includes(String(input.presentation)))
    result.presentation = input.presentation as WorldPresentation;
  if (
    ['relief', 'elevation', 'flow', 'wear', 'deposition', 'slope', 'contours', 'aspect'].includes(
      String(input.layer),
    )
  )
    result.layer = input.layer as WorldDisplayLayer;
  if (typeof input.panelWidth === 'number' && Number.isFinite(input.panelWidth))
    result.panelWidth = Math.max(272, Math.min(420, input.panelWidth));
  if (typeof input.automatic === 'boolean') result.automatic = input.automatic;
  if (typeof input.cache === 'boolean') result.cache = input.cache;
  return result;
}

export function loadWorldViewSettings(): WorldViewSettings {
  try {
    return parseWorldViewSettings(JSON.parse(localStorage.getItem(WORLD_VIEW_KEY) ?? 'null'));
  } catch {
    return { ...DEFAULT_WORLD_VIEW };
  }
}
export function saveWorldViewSettings(settings: WorldViewSettings): void {
  try {
    localStorage.setItem(WORLD_VIEW_KEY, JSON.stringify(parseWorldViewSettings(settings)));
  } catch {
    /* Optional presentation storage never interrupts authoring. */
  }
}
export function worldBookmarkScope(project: TerrainProject): string {
  return JSON.stringify([
    project.name,
    project.seed,
    project.graph.nodes.find((n) => n.kind === 'output')?.id,
  ]);
}
export function worldDomainKey(world: WorldDefinition): string {
  const d = world.domain;
  return JSON.stringify([d.originX, d.originZ, d.width, d.depth, d.cellsX, d.cellsZ]);
}
export function parseWorldBookmarks(value: unknown): WorldBookmark[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value
    .filter((entry): entry is WorldBookmark => {
      if (
        !entry ||
        typeof entry !== 'object' ||
        typeof entry.id !== 'string' ||
        seen.has(entry.id) ||
        typeof entry.name !== 'string' ||
        !entry.name.trim() ||
        typeof entry.domain !== 'string' ||
        !entry.region
      )
        return false;
      const { startX, startZ, cellsX, cellsZ } = entry.region;
      if (
        ![startX, startZ, cellsX, cellsZ].every(Number.isSafeInteger) ||
        startX < 0 ||
        startZ < 0 ||
        cellsX < 1 ||
        cellsZ < 1 ||
        startX + cellsX > 32768 ||
        startZ + cellsZ > 32768
      )
        return false;
      seen.add(entry.id);
      return true;
    })
    .slice(0, 20)
    .map((entry) => ({
      ...entry,
      name: entry.name.trim().slice(0, 60),
      region: { ...entry.region },
    }));
}
export function loadWorldBookmarks(scope: string): WorldBookmark[] {
  try {
    const store = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) ?? '{}');
    return parseWorldBookmarks(store[scope]);
  } catch {
    return [];
  }
}
export function saveWorldBookmarks(scope: string, bookmarks: WorldBookmark[]): boolean {
  try {
    let previous: Record<string, unknown> = {};
    try {
      const stored = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) ?? '{}');
      if (stored && typeof stored === 'object' && !Array.isArray(stored)) previous = stored;
    } catch {
      /* Replace malformed optional settings. */
    }
    // Keep a bounded recent-project shelf, independent of authored project data.
    const recent = Object.entries(previous)
      .filter(([key]) => key !== scope)
      .slice(-15);
    localStorage.setItem(
      BOOKMARKS_KEY,
      JSON.stringify(Object.fromEntries([...recent, [scope, parseWorldBookmarks(bookmarks)]])),
    );
    return true;
  } catch {
    return false;
  }
}
