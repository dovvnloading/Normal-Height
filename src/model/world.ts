import type { TerrainProject } from './types';
import type { GenesisSettings } from './genesis';
import { normalizeGenesisSettings, validateGenesisSettings } from './genesis';

export type WorldBackend = 'auto' | 'cpu-reference' | 'webgpu';
export type WorldBoundary = 'closed' | 'open' | 'periodic';

export interface WorldTransportSettings {
  enabled: boolean;
  iterations: number;
  /** Rainfall depth in metres per iteration. */
  rainfall: number;
  evaporation: number;
  /** Artistic hydraulic conductivity in m² per iteration. */
  conductivity: number;
  capacity: number;
  erosion: number;
  deposition: number;
  talusDegrees: number;
  thermal: number;
  /** Finite erodible cover beneath the initial terrain, in metres. */
  soilDepth: number;
}

export const DEFAULT_WORLD_TRANSPORT: Readonly<WorldTransportSettings> = Object.freeze({
  enabled: false,
  iterations: 24,
  rainfall: 0.08,
  evaporation: 0.02,
  conductivity: 0.35,
  capacity: 1.5,
  erosion: 0.35,
  deposition: 0.3,
  talusDegrees: 38,
  thermal: 0.12,
  soilDepth: 3,
});

/** Local Cartesian metres: +X east, +Z south; row zero is north. */
export interface WorldDomain {
  originX: number;
  originZ: number;
  width: number;
  depth: number;
  /** Intervals, rather than vertex sample counts. */
  cellsX: number;
  cellsZ: number;
  heightScale: number;
  datum: number;
  boundary: WorldBoundary;
}

/** Deliberately separate from both project v2 and Noise Studio v3. */
export interface WorldDefinition {
  version: 1;
  domain: WorldDomain;
  tileCells: number;
  globalResolution: number;
  backend: WorldBackend;
  transport?: WorldTransportSettings;
  /** Opt-in geological formation, evaluated before World water/sediment transport. */
  genesis?: GenesisSettings;
}

export const WORLD_MAX_CELLS = 32768;
export const WORLD_REGION_BUDGET = 128 * 1024 * 1024;

export function createWorldDefinition(
  project: Pick<TerrainProject, 'worldSize' | 'heightScale'>,
): WorldDefinition {
  const size =
    Number.isFinite(project.worldSize) && project.worldSize > 0 ? project.worldSize : 4000;
  return {
    version: 1,
    domain: {
      originX: -size / 2,
      originZ: -size / 2,
      width: size,
      depth: size,
      cellsX: 1024,
      cellsZ: 1024,
      heightScale: project.heightScale || 1800,
      datum: 0,
      boundary: 'closed',
    },
    tileCells: 256,
    globalResolution: 256,
    backend: 'cpu-reference',
  };
}

export function validateWorldDefinition(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'World settings must be an object.';
  const world = value as WorldDefinition;
  if (world.version !== 1) return 'This World schema version is not supported.';
  if (!world.domain || typeof world.domain !== 'object')
    return 'The world needs a Cartesian domain.';
  const d = world.domain;
  for (const key of ['originX', 'originZ', 'width', 'depth', 'heightScale', 'datum'] as const)
    if (typeof d[key] !== 'number' || !Number.isFinite(d[key]))
      return `World ${key} must be finite.`;
  if (d.width < 1 || d.depth < 1 || d.width > 1e9 || d.depth > 1e9)
    return 'World width and depth must be between 1 and 1,000,000,000 metres.';
  if (Math.abs(d.originX) > 1e12 || Math.abs(d.originZ) > 1e12)
    return 'World origins must be within ±1,000,000,000,000 metres.';
  if (d.heightScale <= 0 || d.heightScale > 1e7 || Math.abs(d.datum) > 1e9)
    return 'World height scale must be positive (at most 10,000,000 m), with a finite local datum.';
  for (const key of ['cellsX', 'cellsZ'] as const)
    if (!Number.isSafeInteger(d[key]) || d[key] < 1 || d[key] > WORLD_MAX_CELLS)
      return `World ${key} must be an integer from 1 to ${WORLD_MAX_CELLS}.`;
  for (const axis of ['X', 'Z'] as const) {
    const extent = axis === 'X' ? d.width : d.depth,
      origin = d[`origin${axis}`];
    if (
      extent / d[`cells${axis}`] <
      Math.max(Math.abs(origin), Math.abs(origin + extent)) * Number.EPSILON * 8
    )
      return 'The sample spacing is too fine for this Cartesian origin. Choose a closer local origin or wider sample spacing.';
  }
  if (!['closed', 'open', 'periodic'].includes(d.boundary))
    return 'Choose closed, open, or periodic world boundaries.';
  if (
    !Number.isSafeInteger(world.tileCells) ||
    world.tileCells < 32 ||
    world.tileCells > 512 ||
    (world.tileCells & (world.tileCells - 1)) !== 0
  )
    return 'World tiles must use 32, 64, 128, 256, or 512 intervals.';
  if (
    !Number.isSafeInteger(world.globalResolution) ||
    world.globalResolution < 64 ||
    world.globalResolution > 1024
  )
    return 'Global reference resolution must be an integer from 64 to 1024 samples.';
  if (!['auto', 'cpu-reference', 'webgpu'].includes(world.backend))
    return 'Choose Auto, CPU reference, or WebGPU.';
  if (world.genesis !== undefined) {
    const genesisError = validateGenesisSettings(world.genesis);
    if (genesisError) return genesisError;
  }
  if (world.transport !== undefined) {
    const t = world.transport;
    if (!t || typeof t !== 'object' || typeof t.enabled !== 'boolean')
      return 'World transport settings are invalid.';
    if (!Number.isSafeInteger(t.iterations) || t.iterations < 1 || t.iterations > 128)
      return 'World transport needs 1–128 iterations.';
    const ranges: [keyof WorldTransportSettings, number, number][] = [
      ['rainfall', 0, 10],
      ['evaporation', 0, 1],
      ['conductivity', 0, 100],
      ['capacity', 0, 20],
      ['erosion', 0, 1],
      ['deposition', 0, 1],
      ['talusDegrees', 0, 89],
      ['thermal', 0, 1],
      ['soilDepth', 0, 1000],
    ];
    for (const [key, min, max] of ranges) {
      const value = t[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
        return `World transport ${key} must be between ${min} and ${max}.`;
    }
  }
  return null;
}

/** Strict validation: malformed saved worlds never silently change their spatial meaning. */
export function normalizeWorldDefinition(
  value: unknown,
  fallbackProject: Pick<TerrainProject, 'worldSize' | 'heightScale'>,
): WorldDefinition {
  if (value === undefined || value === null) return createWorldDefinition(fallbackProject);
  const error = validateWorldDefinition(value);
  if (error) throw new Error(error);
  const world = value as WorldDefinition;
  return {
    version: 1,
    domain: { ...world.domain },
    tileCells: world.tileCells,
    globalResolution: world.globalResolution,
    backend: world.backend,
    ...(world.transport ? { transport: { ...world.transport } } : {}),
    ...(world.genesis ? { genesis: normalizeGenesisSettings(world.genesis) } : {}),
  };
}
