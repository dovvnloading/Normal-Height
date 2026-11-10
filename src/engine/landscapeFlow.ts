import type { DrainageWorkspace } from './hydrology';

/**
 * Multiple-flow-direction surface runoff, following the method used in
 * catchment-based landscape evolution rather than tracing random droplets.
 *
 * An upstream cell partitions discharge between all strictly downhill,
 * previously-processed neighbors in proportion to slope^1.7. Closed basins
 * use the priority-flood receiver so every unit still reaches an open outlet.
 * No extra graph memory is allocated: the flood's topological order is reused.
 *
 * A 0-loss test must recover the sum of all injected precipitation at outlets.
 */
export function accumulateMultiFlow(
  height: Float32Array,
  workspace: DrainageWorkspace,
  rain: Float32Array,
  worldSizeMeters: number,
  transmissionLoss: number,
): Float32Array {
  const { resolution: n, receiver, order, rank, area } = workspace;
  if (height.length !== n * n || rain.length !== n * n ||
      !Number.isFinite(worldSizeMeters) || worldSizeMeters <= 0) {
    throw new Error('Multi-flow drainage needs aligned height and rain grids.');
  }
  area.set(rain);
  const meters = worldSizeMeters / (n - 1);
  const loss = Math.max(0, transmissionLoss) / 400;
  const dxs = [-1, 0, 1, -1, 1, -1, 0, 1];
  const dys = [-1, -1, -1, 0, 0, 1, 1, 1];
  // Iterate upstream -> downstream. Every accepted receiver has a lower rank;
  // therefore every cell receives all incoming water before its own discharge.
  for (let k = order.length - 1; k >= 0; k--) {
    const cell = order[k];
    const fallback = receiver[cell];
    if (fallback < 0 || area[cell] <= 0) continue;
    const x = cell % n, y = (cell / n) | 0;
    const z = height[cell];
    const weights = new Float64Array(8);
    const neighbors = new Int32Array(8);
    let total = 0;
    for (let d = 0; d < 8; d++) {
      const xx = x + dxs[d], yy = y + dys[d];
      if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
      const j = yy * n + xx;
      if (rank[j] >= rank[cell]) continue;
      const dist = dxs[d] && dys[d] ? Math.SQRT2 : 1;
      const downhill = (z - height[j]) / dist;
      if (downhill <= 1e-9) continue;
      const weight = Math.pow(downhill, 1.7);
      weights[d] = weight;
      neighbors[d] = j;
      total += weight;
    }
    if (total > 0) {
      for (let d = 0; d < 8; d++) {
        if (!weights[d]) continue;
        const dist = dxs[d] && dys[d] ? Math.SQRT2 : 1;
        area[neighbors[d]] += area[cell] * (weights[d] / total) *
          Math.exp(-loss * meters * dist);
      }
    } else {
      const diagonal = Math.abs(x - fallback % n) &&
        Math.abs(y - ((fallback / n) | 0));
      area[fallback] += area[cell] *
        Math.exp(-loss * meters * (diagonal ? Math.SQRT2 : 1));
    }
  }
  return area;
}
