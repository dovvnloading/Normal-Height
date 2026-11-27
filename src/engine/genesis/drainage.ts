import type { TransportGrid, WorldDrainage } from '../world/hydrology';

export interface GenesisDrainage extends WorldDrainage {
  /** Downstream precedes upstream, including flood-routed flats and pits. */
  order: Int32Array;
  cellAreaM2: Float64Array;
}

export interface GenesisDrainageWorkspace {
  grid: TransportGrid;
  filledHeight: Float64Array;
  receiver: Int32Array;
  basin: Int32Array;
  order: Int32Array;
  rank: Int32Array;
  heap: Int32Array;
  visited: Uint8Array;
  cellAreaM2: Float64Array;
  contributingAreaM2: Float64Array;
  targets: Int32Array;
  weights: Float64Array;
}

function validateGrid(grid: TransportGrid): void {
  if (
    ![grid.width, grid.height].every((n) => Number.isSafeInteger(n) && n >= 2 && n <= 1024) ||
    ![grid.widthMeters, grid.depthMeters].every((n) => Number.isFinite(n) && n > 0) ||
    (grid.boundary !== 'open' && grid.boundary !== 'closed')
  )
    throw new Error('Genesis drainage needs a finite 2–1024 sample open or closed physical grid.');
}

export function createGenesisDrainageWorkspace(grid: TransportGrid): GenesisDrainageWorkspace {
  validateGrid(grid);
  const count = grid.width * grid.height;
  return {
    grid: { ...grid },
    filledHeight: new Float64Array(count),
    receiver: new Int32Array(count),
    basin: new Int32Array(count),
    order: new Int32Array(count),
    rank: new Int32Array(count),
    heap: new Int32Array(count),
    visited: new Uint8Array(count),
    cellAreaM2: genesisCellAreas(grid),
    contributingAreaM2: new Float64Array(count),
    targets: new Int32Array(8),
    weights: new Float64Array(8),
  };
}

export function genesisCellAreas(grid: TransportGrid): Float64Array {
  const area = new Float64Array(grid.width * grid.height);
  const dx = grid.widthMeters / (grid.width - 1);
  const dz = grid.depthMeters / (grid.height - 1);
  for (let z = 0; z < grid.height; z++)
    for (let x = 0; x < grid.width; x++)
      area[z * grid.width + x] =
        dx *
        dz *
        (x === 0 || x === grid.width - 1 ? 0.5 : 1) *
        (z === 0 || z === grid.height - 1 ? 0.5 : 1);
  return area;
}

/**
 * Whole-domain priority-flood, using the same boundary and control-volume
 * conventions as World transport. Keeping this version separate preserves
 * legacy projects exactly while retaining actual flood-pop ranks for MFD.
 *
 * Primary receivers follow the steepest earlier physical downhill neighbor;
 * flats/pits retain their flood parent. Area is partitioned over ALL earlier
 * downhill neighbors, proportional to slope^1.1. A final remainder preserves
 * each donor's contribution. Thus primary basin IDs describe a receiver
 * forest, while weighted contributing area can cross primary basin divides.
 * Flood levels condition routing, never terrain.
 */
export function routeGenesisDrainage(
  height: Float64Array,
  grid: TransportGrid,
  workspace = createGenesisDrainageWorkspace(grid),
): GenesisDrainage {
  const count = height.length;
  validateGrid(grid);
  if (
    count !== grid.width * grid.height ||
    (Object.keys(grid) as (keyof TransportGrid)[]).some((key) => workspace.grid[key] !== grid[key])
  )
    throw new Error('Genesis drainage workspace and terrain must share physical grid geometry.');
  for (const value of height)
    if (!Number.isFinite(value)) throw new Error('Genesis drainage needs finite elevations.');
  const {
    filledHeight,
    receiver,
    basin,
    order,
    rank,
    heap,
    visited,
    cellAreaM2,
    contributingAreaM2,
    targets,
    weights,
  } = workspace;
  filledHeight.set(height);
  receiver.fill(-1);
  basin.fill(-1);
  visited.fill(0);
  let length = 0,
    processed = 0,
    outletCount = 0;
  const tie = (i: number) => {
    let h = Math.imul(i ^ 0x61c88647, 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 16), 0xc2b2ae35);
    return (h ^ (h >>> 13)) >>> 0;
  };
  const less = (a: number, b: number) =>
    filledHeight[a] !== filledHeight[b] ? filledHeight[a] < filledHeight[b] : tie(a) < tie(b);
  const push = (i: number) => {
    let at = length++;
    while (at > 0) {
      const parent = (at - 1) >>> 1;
      if (!less(i, heap[parent])) break;
      heap[at] = heap[parent];
      at = parent;
    }
    heap[at] = i;
  };
  const pop = () => {
    const first = heap[0],
      end = heap[--length];
    if (length) {
      let at = 0;
      while (at * 2 + 1 < length) {
        let child = at * 2 + 1;
        if (child + 1 < length && less(heap[child + 1], heap[child])) child++;
        if (!less(heap[child], end)) break;
        heap[at] = heap[child];
        at = child;
      }
      heap[at] = end;
    }
    return first;
  };
  const outlet = (i: number) => {
    visited[i] = 1;
    basin[i] = outletCount++;
    push(i);
  };
  if (grid.boundary === 'closed') {
    let sink = 0;
    for (let i = 1; i < count; i++) if (height[i] < height[sink]) sink = i;
    outlet(sink);
  } else {
    for (let z = 0; z < grid.height; z++)
      for (let x = 0; x < grid.width; x++)
        if (x === 0 || z === 0 || x === grid.width - 1 || z === grid.height - 1)
          outlet(z * grid.width + x);
  }
  while (length) {
    const i = pop(),
      x = i % grid.width,
      z = Math.floor(i / grid.width);
    rank[i] = processed;
    order[processed++] = i;
    for (let oz = -1; oz <= 1; oz++)
      for (let ox = -1; ox <= 1; ox++) {
        const xx = x + ox,
          zz = z + oz;
        if ((!ox && !oz) || xx < 0 || zz < 0 || xx >= grid.width || zz >= grid.height) continue;
        const next = zz * grid.width + xx;
        if (visited[next]) continue;
        visited[next] = 1;
        receiver[next] = i;
        basin[next] = basin[i];
        filledHeight[next] = Math.max(height[next], filledHeight[i]);
        push(next);
      }
  }
  const dx = grid.widthMeters / (grid.width - 1);
  const dz = grid.depthMeters / (grid.height - 1);
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    if (receiver[i] < 0) continue;
    const x = i % grid.width,
      z = Math.floor(i / grid.width);
    let steepest = 0,
      next = receiver[i];
    for (let oz = -1; oz <= 1; oz++)
      for (let ox = -1; ox <= 1; ox++) {
        const xx = x + ox,
          zz = z + oz;
        if ((!ox && !oz) || xx < 0 || zz < 0 || xx >= grid.width || zz >= grid.height) continue;
        const candidate = zz * grid.width + xx;
        if (rank[candidate] >= k) continue;
        const slope = (height[i] - height[candidate]) / Math.hypot(ox * dx, oz * dz);
        if (slope > steepest) {
          steepest = slope;
          next = candidate;
        }
      }
    receiver[i] = next;
    basin[i] = basin[next];
  }
  contributingAreaM2.set(cellAreaM2);
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k],
      next = receiver[i];
    if (next < 0) continue;
    const x = i % grid.width,
      z = Math.floor(i / grid.width);
    let targetCount = 0,
      sum = 0;
    for (let oz = -1; oz <= 1; oz++)
      for (let ox = -1; ox <= 1; ox++) {
        const xx = x + ox,
          zz = z + oz;
        if ((!ox && !oz) || xx < 0 || zz < 0 || xx >= grid.width || zz >= grid.height) continue;
        const candidate = zz * grid.width + xx;
        if (rank[candidate] >= k || height[candidate] >= height[i]) continue;
        const slope = (height[i] - height[candidate]) / Math.hypot(ox * dx, oz * dz);
        const weight = slope ** 1.1;
        targets[targetCount] = candidate;
        weights[targetCount++] = weight;
        sum += weight;
      }
    const area = contributingAreaM2[i];
    if (!targetCount || sum <= 0) {
      contributingAreaM2[next] += area;
      continue;
    }
    let distributed = 0;
    for (let j = 0; j < targetCount; j++) {
      const part = j === targetCount - 1 ? area - distributed : (area * weights[j]) / sum;
      contributingAreaM2[targets[j]] += part;
      distributed += part;
    }
  }
  return { receiver, basin, filledHeight, contributingAreaM2, outletCount, order, cellAreaM2 };
}
