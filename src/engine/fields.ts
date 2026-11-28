import type { HeightField, TerrainProject } from '../model/types';

/** Shared physical raster contract. Rows run north to south; columns run east.
 * Values remain in authored height units until converted using scale/datum.
 * An optional canonical lattice makes overlapping region coordinates identical.
 */
export interface FieldGrid {
  width: number;
  height: number;
  originX: number;
  originZ: number;
  spacingX: number;
  spacingZ: number;
  heightScale: number;
  datum: number;
  lattice?: {
    originX: number;
    originZ: number;
    extentX: number;
    extentZ: number;
    cellsX: number;
    cellsZ: number;
    offsetX: number;
    offsetZ: number;
  };
}

export interface FieldDescriptor {
  semantic:
    | 'elevation'
    | 'flow-weight'
    | 'erosion-diagnostic'
    | 'coverage'
    | 'normal'
    | 'color'
    | 'hardness'
    | 'lithology'
    | 'uplift'
    | 'incision'
    | 'contributing-area'
    | 'channel';
  units:
    | 'authored-height'
    | 'meters'
    | 'unitless'
    | 'linear-rgb'
    | 'srgb'
    | 'square-meters'
    | 'category-id';
  components: 1 | 3 | 4;
  algorithm: string;
}

/** Paint is authored in normalized whole-domain coordinates, never tile UVs. */
export interface PaintGrid {
  originX: number;
  originZ: number;
  width: number;
  depth: number;
}

export interface FieldSampling {
  grid: FieldGrid;
  paint?: PaintGrid;
}

export function heightFieldGrid(field: HeightField, project: TerrainProject): FieldGrid {
  const spacing = project.worldSize / (field.resolution - 1);
  return {
    width: field.resolution,
    height: field.resolution,
    originX: 0,
    originZ: 0,
    spacingX: spacing,
    spacingZ: spacing,
    heightScale: project.heightScale,
    datum: 0,
  };
}

export function fieldCoordinate(grid: FieldGrid, axis: 'X' | 'Z', index: number): number {
  const l = grid.lattice;
  return l
    ? l[`origin${axis}`] + ((l[`offset${axis}`] + index) / l[`cells${axis}`]) * l[`extent${axis}`]
    : grid[`origin${axis}`] + index * grid[`spacing${axis}`];
}

export function validateFieldGrid(grid: FieldGrid): void {
  if (![grid.width, grid.height].every((n) => Number.isSafeInteger(n) && n >= 2 && n <= 32769))
    throw new Error('A material field requires 2–32769 samples per axis.');
  if (
    ![grid.originX, grid.originZ, grid.datum].every(Number.isFinite) ||
    ![grid.spacingX, grid.spacingZ, grid.heightScale].every((n) => Number.isFinite(n) && n > 0)
  )
    throw new Error('A material field requires finite origins, positive spacing and height scale.');
  if (grid.lattice) {
    const l = grid.lattice;
    if (
      !Object.values(l).every(Number.isFinite) ||
      ![l.cellsX, l.cellsZ].every((n) => Number.isSafeInteger(n) && n > 0) ||
      ![l.extentX, l.extentZ].every((n) => n > 0)
    )
      throw new Error('Invalid canonical field lattice.');
    for (const axis of ['X', 'Z'] as const) {
      const spacing = l[`extent${axis}`] / l[`cells${axis}`];
      if (Math.abs(spacing - grid[`spacing${axis}`]) > 1e-10 * Math.max(1, spacing))
        throw new Error('Field spacing must match its canonical lattice.');
    }
  }
}

/** Validates the rectangular storage explicitly; legacy HeightField.resolution
 * is the row stride in this adapter, not a claim that a region is square. */
export function validateMaterialField(field: HeightField, grid: FieldGrid): void {
  validateFieldGrid(grid);
  const count = grid.width * grid.height;
  if (
    field.resolution !== grid.width ||
    [field.height, field.flow, field.wear, field.deposition].some(
      (values) => values.length !== count,
    )
  )
    throw new Error('PBR generation requires aligned fields on the declared rectangular grid.');
  for (const values of [field.height, field.flow, field.wear, field.deposition])
    for (const value of values)
      if (!Number.isFinite(value))
        throw new Error('Material fields contain non-finite terrain or diagnostic samples.');
}
