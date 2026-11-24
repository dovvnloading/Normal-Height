import type { WorldDefinition, WorldDomain } from '../../model/world';
import type { WorldSampleGrid } from './types';

export interface WorldTileKey {
  level: number;
  x: number;
  z: number;
}
export interface WorldTile {
  key: WorldTileKey;
  grid: WorldSampleGrid;
  core: { startX: number; startZ: number; cellsX: number; cellsZ: number };
}

function integer(value: number, name: string, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
}

/** World-space sample coordinates always come from one canonical integer interval index. */
export function worldCoordinate(
  domain: WorldDomain,
  i: number,
  j: number,
): { x: number; z: number } {
  if (!Number.isFinite(i) || !Number.isFinite(j))
    throw new Error('World sample indices must be finite.');
  return {
    x: domain.originX + i * (domain.width / domain.cellsX),
    z: domain.originZ + j * (domain.depth / domain.cellsZ),
  };
}

export function validateWorldGrid(domain: WorldDomain, grid: WorldSampleGrid): void {
  integer(grid.samplesX, 'Grid width', 1, 32769);
  integer(grid.samplesZ, 'Grid height', 1, 32769);
  for (const axis of ['X', 'Z'] as const) {
    const total = domain[`cells${axis}`],
      start = grid[`start${axis}`],
      span = grid[`cells${axis}`];
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(span) ||
      start < 0 ||
      span < 0 ||
      start + span > total + 1e-7
    )
      throw new Error('The requested region lies outside the world domain.');
    const samples = grid[`samples${axis}`];
    if ((samples > 1 && span <= 0) || (samples === 1 && span !== 0))
      throw new Error('A single sample has zero extent; multi-sample grids need positive extent.');
    const extentMetres = axis === 'X' ? domain.width : domain.depth;
    const minimumSpacing =
      Math.max(
        Math.abs(domain[`origin${axis}`]),
        Math.abs(domain[`origin${axis}`] + extentMetres),
      ) *
      Number.EPSILON *
      8;
    if (samples > 1 && ((span / (samples - 1)) * extentMetres) / total < minimumSpacing)
      throw new Error(
        'The requested grid is finer than coordinate precision at this origin. Rebase the world to a closer local origin.',
      );
    const outputCells = grid[`outputCells${axis}`];
    if (outputCells !== undefined) {
      integer(outputCells, 'Export grid intervals', 1, 32768);
      const offset = grid[`outputSampleOffset${axis}`] ?? 0;
      // ROI halos may extend beyond the selected output rectangle while staying
      // inside the world. Preserve their signed global sample numerator.
      integer(offset, 'Export sample offset', -32768, 32768);
      const origin = grid[`outputOrigin${axis}`] ?? 0;
      const extent = grid[`outputExtent${axis}`] ?? total;
      if (
        !Number.isFinite(origin) ||
        !Number.isFinite(extent) ||
        origin < 0 ||
        extent <= 0 ||
        origin + extent > total + 1e-7
      )
        throw new Error('The export grid lies outside the world domain.');
      const expectedStart = origin + (offset / outputCells) * extent;
      const expectedEnd = origin + ((offset + samples - 1) / outputCells) * extent;
      if (Math.abs(start - expectedStart) > 1e-7 || Math.abs(start + span - expectedEnd) > 1e-7)
        throw new Error('The requested region disagrees with its canonical export grid.');
    } else if (
      grid[`outputSampleOffset${axis}`] !== undefined ||
      grid[`outputOrigin${axis}`] !== undefined ||
      grid[`outputExtent${axis}`] !== undefined
    )
      throw new Error('Export grid offsets require an explicit interval count.');
  }
}

export function gridIndex(
  domain: WorldDomain,
  grid: WorldSampleGrid,
  axis: 'X' | 'Z',
  sample: number,
): number {
  const cells = grid[`outputCells${axis}`];
  if (cells !== undefined) {
    const origin = grid[`outputOrigin${axis}`] ?? 0;
    const extent = grid[`outputExtent${axis}`] ?? domain[`cells${axis}`];
    return origin + ((sample + (grid[`outputSampleOffset${axis}`] ?? 0)) / cells) * extent;
  }
  const count = grid[`samples${axis}`];
  return grid[`start${axis}`] + (count === 1 ? 0 : (sample * grid[`cells${axis}`]) / (count - 1));
}

export function gridSpacing(domain: WorldDomain, grid: WorldSampleGrid, axis: 'X' | 'Z'): number {
  const metres = axis === 'X' ? domain.width : domain.depth;
  const cells = grid[`outputCells${axis}`];
  if (cells !== undefined)
    return (
      (((grid[`outputExtent${axis}`] ?? domain[`cells${axis}`]) / cells) * metres) /
      domain[`cells${axis}`]
    );
  const samples = grid[`samples${axis}`];
  return samples > 1
    ? ((grid[`cells${axis}`] / (samples - 1)) * metres) / domain[`cells${axis}`]
    : metres / domain[`cells${axis}`];
}

export function worldTile(world: WorldDefinition, key: WorldTileKey, halo = 0): WorldTile {
  integer(key.level, 'LOD level', 0, 15);
  integer(halo, 'Tile halo', 0, 4096);
  const step = 2 ** key.level,
    span = world.tileCells * step;
  integer(key.x, 'Tile X', 0, Math.ceil(world.domain.cellsX / span) - 1);
  integer(key.z, 'Tile Z', 0, Math.ceil(world.domain.cellsZ / span) - 1);
  const startX = key.x * span,
    startZ = key.z * span;
  const cellsX = Math.min(span, world.domain.cellsX - startX),
    cellsZ = Math.min(span, world.domain.cellsZ - startZ);
  const minX = Math.max(0, startX - halo * step),
    minZ = Math.max(0, startZ - halo * step);
  const maxX = Math.min(world.domain.cellsX, startX + cellsX + halo * step);
  const maxZ = Math.min(world.domain.cellsZ, startZ + cellsZ + halo * step);
  // Non-divisible outer edges are included explicitly; interior coarse samples stay nested.
  const grid = {
    startX: minX,
    startZ: minZ,
    cellsX: maxX - minX,
    cellsZ: maxZ - minZ,
    samplesX: Math.ceil((maxX - minX) / step) + 1,
    samplesZ: Math.ceil((maxZ - minZ) / step) + 1,
  };
  if (key.level > 0 && ((maxX - minX) % step || (maxZ - minZ) % step))
    throw new Error(
      'This partial edge is not aligned at the requested LOD; use level zero for exact outer samples.',
    );
  return { key: { ...key }, grid, core: { startX, startZ, cellsX, cellsZ } };
}

export function listWorldTiles(world: WorldDefinition, level = 0): WorldTileKey[] {
  integer(level, 'LOD level', 0, 15);
  const span = world.tileCells * 2 ** level,
    keys: WorldTileKey[] = [];
  const nx = Math.ceil(world.domain.cellsX / span),
    nz = Math.ceil(world.domain.cellsZ / span);
  if (nx * nz > 1048576)
    throw new Error('Too many tiles to enumerate at once; request individual tiles.');
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) keys.push({ level, x, z });
  return keys;
}

/** North/west owners account for shared samples once, including a four-way corner. */
export function sampleOwner(world: WorldDefinition, i: number, j: number): WorldTileKey {
  integer(i, 'Sample X', 0, world.domain.cellsX);
  integer(j, 'Sample Z', 0, world.domain.cellsZ);
  return {
    level: 0,
    x: Math.max(0, Math.ceil(i / world.tileCells) - 1),
    z: Math.max(0, Math.ceil(j / world.tileCells) - 1),
  };
}

/** Trapezoidal area weight; shared borders must first be deduplicated by sampleOwner. */
export function sampleArea(domain: WorldDomain, i: number, j: number): number {
  const wx = i === 0 || i === domain.cellsX ? 0.5 : 1;
  const wz = j === 0 || j === domain.cellsZ ? 0.5 : 1;
  return (((wx * wz * domain.width) / domain.cellsX) * domain.depth) / domain.cellsZ;
}
