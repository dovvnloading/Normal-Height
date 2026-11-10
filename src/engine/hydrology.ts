/**
 * Deterministic, outlet-connected D8 drainage on a heightfield.
 *
 * We use a priority flood from the open boundary to construct a spanning
 * drainage forest. A cell's downstream receiver is ALWAYS visited earlier,
 * including inside enclosed pits. The flood level is a *routing* surface:
 * we never fill or alter the artist's source terrain just to route water.
 *
 * This is hydrological conditioning, not a fluid or groundwater solver.
 * The 8-neighbour raster and open boundaries are explicit limitations.
 */

export interface DrainageWorkspace {
  resolution: number;
  /** One receiver per interior cell; -1 marks an outlet on the tile boundary. */
  receiver: Int32Array;
  /** Processing order: every receiver precedes its upstream children. */
  order: Int32Array;
  rank: Int32Array;
  /** Spill elevation used to connect closed basins, not a modified terrain. */
  spill: Float32Array;
  /** Rainfall contributing area in cell-equivalent units. */
  area: Float32Array;
  visited: Uint8Array;
  heap: Int32Array;
}

const DX = [-1, 0, 1, -1, 1, -1, 0, 1] as const;
const DY = [-1, -1, -1, 0, 0, 1, 1, 1] as const;
const DIAGONAL = 0.7071067811865476;

function tieBreaker(index: number, seed: number): number {
  let v = Math.imul(index ^ seed, 0x9e3779b1);
  v = Math.imul(v ^ (v >>> 16), 0x85ebca6b);
  return (v ^ (v >>> 13)) >>> 0;
}

export function createDrainageWorkspace(n: number): DrainageWorkspace {
  if (!Number.isInteger(n) || n < 2 || n > 2048)
    throw new Error('Drainage requires a 2–2048 square heightfield.');
  const count = n * n;
  return {
    resolution: n,
    receiver: new Int32Array(count),
    order: new Int32Array(count),
    rank: new Int32Array(count),
    spill: new Float32Array(count),
    area: new Float32Array(count),
    visited: new Uint8Array(count),
    heap: new Int32Array(count),
  };
}

/**
 * Priority flood with a stable seeded tie break on equal-elevation flats.
 * After building the outlet-connected forest, improve each receiver to the
 * steepest *actual* downhill neighbor that was processed earlier. A receiver
 * can never point to its descendants, so routing remains acyclic.
 *
 * Runtime O(N log N); arrays are reused across erosion iterations.
 */
export function routeDrainage(
  heights: Float32Array,
  n: number,
  seed: number,
  workspace = createDrainageWorkspace(n),
): DrainageWorkspace {
  const count = n * n;
  if (workspace.resolution !== n || heights.length !== count)
    throw new Error('Drainage workspace and terrain dimensions must match.');
  const { receiver, order, rank, visited, spill, heap } = workspace;
  visited.fill(0);
  receiver.fill(-1);
  let length = 0;

  const less = (a: number, b: number) => {
    if (spill[a] !== spill[b]) return spill[a] < spill[b];
    return tieBreaker(a, seed) < tieBreaker(b, seed);
  };
  const push = (index: number) => {
    let at = length++;
    while (at > 0) {
      const parent = (at - 1) >>> 1;
      if (!less(index, heap[parent])) break;
      heap[at] = heap[parent];
      at = parent;
    }
    heap[at] = index;
  };
  const pop = () => {
    const first = heap[0];
    const end = heap[--length];
    if (length > 0) {
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
  const outlet = (index: number) => {
    if (visited[index]) return;
    if (!Number.isFinite(heights[index]))
      throw new Error('Drainage requires finite elevations.');
    visited[index] = 1;
    spill[index] = heights[index];
    push(index);
  };
  for (let x = 0; x < n; x++) {
    outlet(x);
    outlet((n - 1) * n + x);
  }
  for (let y = 1; y < n - 1; y++) {
    outlet(y * n);
    outlet(y * n + n - 1);
  }
  let processed = 0;
  while (length > 0) {
    const cell = pop();
    const x = cell % n, y = (cell / n) | 0;
    rank[cell] = processed;
    order[processed++] = cell;
    for (let direction = 0; direction < 8; direction++) {
      const nx = x + DX[direction], ny = y + DY[direction];
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const neighbor = ny * n + nx;
      if (visited[neighbor]) continue;
      const elevation = heights[neighbor];
      if (!Number.isFinite(elevation))
        throw new Error('Drainage requires finite elevations.');
      visited[neighbor] = 1;
      receiver[neighbor] = cell;
      spill[neighbor] = Math.max(elevation, spill[cell]);
      push(neighbor);
    }
  }
  if (processed !== count) throw new Error('Drainage failed to connect every cell.');

  for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
    const i = y * n + x;
    const base = heights[i];
    let steepest = 0, downstream = receiver[i];
    for (let direction = 0; direction < 8; direction++) {
      const candidate = (y + DY[direction]) * n + x + DX[direction];
      // The priority-flood order is a strict topological ordering.
      if (rank[candidate] >= rank[i]) continue;
      const grade = (base - heights[candidate]) *
        (DX[direction] !== 0 && DY[direction] !== 0 ? DIAGONAL : 1);
      if (grade > steepest) {
        steepest = grade;
        downstream = candidate;
      }
    }
    receiver[i] = downstream;
  }
  return workspace;
}

/**
 * Rainfall is uniform per grid cell; routing accumulates upstream catchment
 * contributions in a single downstream pass. Optional transmission loss is
 * expressed per *physical cell distance*, not number of grid points.
 *
 * Mass: a 0-loss outlet receives exactly the number of contributing cells.
 */
export function accumulateDrainage(
  workspace: DrainageWorkspace,
  worldSizeMeters: number,
  evaporation: number,
): Float32Array {
  const { area, receiver, order, resolution: n } = workspace;
  area.fill(1);
  const cellMeters = worldSizeMeters / Math.max(1, n - 1);
  const decay = Math.exp(-Math.max(0, evaporation) * cellMeters / 400);
  for (let k = order.length - 1; k >= 0; k--) {
    const cell = order[k];
    const parent = receiver[cell];
    if (parent >= 0) {
      const diagonal = Math.abs((cell % n) - (parent % n)) === 1 &&
        Math.abs(Math.floor(cell / n) - Math.floor(parent / n)) === 1;
      area[parent] += area[cell] * (diagonal ? decay ** Math.SQRT2 : decay);
    }
  }
  return area;
}
