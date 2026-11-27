import type { TransportGrid } from '../world/hydrology';
import type { GenesisDrainage } from './drainage';

/**
 * Backward-Euler stream-power incision with fixed exponents m=1/2, n=1.
 * K [1/year] sqrt(A [m²]) S [-] is a lowering rate [m/year].
 * Receivers are solved first. A priority-flood spill is only routing metadata:
 * an uphill connection cannot raise the terrain or create a fictitious lake.
 * This operator removes rock; it does not model sediment transport.
 */
export function inciseStreamPower(
  height: Float64Array,
  grid: TransportGrid,
  drainage: GenesisDrainage,
  hardness: Float32Array,
  erosionRate: number,
  rainfall: number,
  durationYears: number,
  incision?: Float64Array,
): number {
  if (erosionRate === 0 || rainfall === 0 || durationYears === 0) return 0;
  const dx = grid.widthMeters / (grid.width - 1);
  const dz = grid.depthMeters / (grid.height - 1);
  let removed = 0;
  for (const i of drainage.order) {
    const receiver = drainage.receiver[i];
    if (receiver < 0) continue;
    const old = height[i],
      downstream = height[receiver];
    if (old <= downstream) continue;
    const ox = (i % grid.width) - (receiver % grid.width);
    const oz = Math.floor(i / grid.width) - Math.floor(receiver / grid.width);
    const distance = Math.hypot(ox * dx, oz * dz);
    const erodibility = (1 - hardness[i]) ** 2;
    const c =
      (erosionRate *
        erodibility *
        Math.sqrt(drainage.contributingAreaM2[i] * rainfall) *
        durationYears) /
      distance;
    // The equivalent weighted difference avoids multiplying large elevations
    // by c, preserves the lower bound, and gives exact identity when c=0.
    const lowered = (old - downstream) * (c / (1 + c));
    const next = Math.max(downstream, old - lowered);
    height[i] = next;
    const actual = old - next;
    if (incision) incision[i] += actual;
    removed += actual * drainage.cellAreaM2[i];
  }
  return removed;
}

/**
 * Exact two-cell diffusion exchanges, composed symmetrically in canonical
 * face order. Each exchange is monotone and conserves area-weighted volume;
 * physical face lengths and half/quarter edge volumes handle rectangles.
 * The splitting is an artistic hillslope approximation, not an exact PDE
 * solution at arbitrarily large time steps.
 */
export function relaxGenesisHillslopes(
  height: Float64Array,
  grid: TransportGrid,
  area: Float64Array,
  hardness: Float32Array,
  coefficient: number,
  durationYears: number,
): { movedVolumeM3: number; residualM3: number } {
  if (!coefficient || !durationYears) return { movedVolumeM3: 0, residualM3: 0 };
  const dx = grid.widthMeters / (grid.width - 1);
  const dz = grid.depthMeters / (grid.height - 1);
  let moved = 0,
    residual = 0;
  const pinned = (i: number) =>
    grid.boundary === 'open' &&
    (i % grid.width === 0 ||
      i % grid.width === grid.width - 1 ||
      i < grid.width ||
      i >= height.length - grid.width);
  const exchange = (a: number, b: number, face: number, distance: number) => {
    if (pinned(a) || pinned(b)) return;
    const mobility = 0.15 + 0.85 * (1 - (hardness[a] + hardness[b]) * 0.5);
    const inverseArea = 1 / area[a] + 1 / area[b];
    const t = ((coefficient * mobility * durationYears * 0.5 * face) / distance) * inverseArea;
    const fraction = -Math.expm1(-t);
    const volume = ((height[a] - height[b]) * fraction) / inverseArea;
    const beforeA = height[a],
      beforeB = height[b];
    height[a] -= volume / area[a];
    height[b] += volume / area[b];
    // Measure actual stored-height changes. Subtracting two enormous total
    // terrain volumes would turn summation roundoff into a false mass error.
    residual += (height[a] - beforeA) * area[a] + (height[b] - beforeB) * area[b];
    moved += Math.abs(volume);
  };
  // X half-step, Z full-step (two symmetric sweeps), X half-step.
  for (let z = 0; z < grid.height; z++)
    for (let x = 0; x < grid.width - 1; x++) {
      const i = z * grid.width + x;
      exchange(i, i + 1, dz * (z === 0 || z === grid.height - 1 ? 0.5 : 1), dx);
    }
  for (let z = 0; z < grid.height - 1; z++)
    for (let x = 0; x < grid.width; x++) {
      const i = z * grid.width + x;
      exchange(i, i + grid.width, dx * (x === 0 || x === grid.width - 1 ? 0.5 : 1), dz);
    }
  for (let z = grid.height - 2; z >= 0; z--)
    for (let x = grid.width - 1; x >= 0; x--) {
      const i = z * grid.width + x;
      exchange(i, i + grid.width, dx * (x === 0 || x === grid.width - 1 ? 0.5 : 1), dz);
    }
  for (let z = grid.height - 1; z >= 0; z--)
    for (let x = grid.width - 2; x >= 0; x--) {
      const i = z * grid.width + x;
      exchange(i, i + 1, dz * (z === 0 || z === grid.height - 1 ? 0.5 : 1), dx);
    }
  return { movedVolumeM3: moved, residualM3: residual };
}
