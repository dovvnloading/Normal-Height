import type { WorldTransportSettings } from '../../model/world';

export interface TransportGrid {
  width: number;
  height: number;
  widthMeters: number;
  depthMeters: number;
  boundary: 'open' | 'closed';
}
export interface WorldMassBudget {
  iterations: number;
  areaM2: number;
  rainfallVolumeM3: number;
  evaporationVolumeM3: number;
  exportedWaterVolumeM3: number;
  finalWaterVolumeM3: number;
  waterResidualM3: number;
  erodedVolumeM3: number;
  depositedVolumeM3: number;
  exportedSedimentVolumeM3: number;
  suspendedSedimentVolumeM3: number;
  solidResidualM3: number;
  thermalMovedVolumeM3: number;
  sharedFaceWaterVolumeM3: number;
}
export interface WorldDrainage {
  /** One globally connected receiver tree, -1 only at true outlets/sink. */
  receiver: Int32Array;
  filledHeight: Float64Array;
  contributingAreaM2: Float64Array;
  basin: Int32Array;
  outletCount: number;
}
export interface WorldTransportResult {
  height: Float64Array;
  waterDepth: Float64Array;
  suspendedSediment: Float64Array;
  flow: Float64Array;
  wear: Float64Array;
  deposition: Float64Array;
  drainage: WorldDrainage;
  budget: WorldMassBudget;
}
export interface TransportOptions {
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
  tileCells?: number;
  tileOrder?: 'forward' | 'reverse';
}

function validateGrid(height: ArrayLike<number>, grid: TransportGrid) {
  if (
    !Number.isSafeInteger(grid.width) ||
    !Number.isSafeInteger(grid.height) ||
    grid.width < 2 ||
    grid.height < 2 ||
    grid.width > 1024 ||
    grid.height > 1024 ||
    height.length !== grid.width * grid.height
  )
    throw new Error('Global World transport needs a matching 2–1024 sample grid per axis.');
  if (
    !Number.isFinite(grid.widthMeters) ||
    !Number.isFinite(grid.depthMeters) ||
    grid.widthMeters <= 0 ||
    grid.depthMeters <= 0
  )
    throw new Error('Global transport needs positive finite physical dimensions.');
  if (grid.boundary !== 'open' && grid.boundary !== 'closed')
    throw new Error('World transport supports open and closed boundaries.');
  for (let i = 0; i < height.length; i++)
    if (!Number.isFinite(height[i]))
      throw new Error('Global transport requires finite elevations.');
}
function geometry(grid: TransportGrid) {
  const dx = grid.widthMeters / (grid.width - 1),
    dz = grid.depthMeters / (grid.height - 1);
  const areas = new Float64Array(grid.width * grid.height);
  for (let z = 0; z < grid.height; z++)
    for (let x = 0; x < grid.width; x++)
      areas[z * grid.width + x] =
        dx *
        dz *
        (x === 0 || x === grid.width - 1 ? 0.5 : 1) *
        (z === 0 || z === grid.height - 1 ? 0.5 : 1);
  return { dx, dz, areas };
}

/** Deterministic priority-flood routing: internal tile edges are never outlets. */
export function routeWorldDrainage(input: ArrayLike<number>, grid: TransportGrid): WorldDrainage {
  validateGrid(input, grid);
  const count = input.length,
    visited = new Uint8Array(count),
    filledHeight = Float64Array.from(input);
  const receiver = new Int32Array(count).fill(-1),
    basin = new Int32Array(count).fill(-1),
    heap: number[] = [],
    order: number[] = [];
  const before = (a: number, b: number) =>
    filledHeight[a] < filledHeight[b] || (filledHeight[a] === filledHeight[b] && a < b);
  const push = (index: number) => {
    let i = heap.length;
    heap.push(index);
    while (i > 0) {
      const p = (i - 1) >>> 1;
      if (!before(index, heap[p])) break;
      heap[i] = heap[p];
      i = p;
    }
    heap[i] = index;
  };
  const pop = () => {
    const top = heap[0],
      last = heap.pop()!;
    if (heap.length) {
      let i = 0;
      while (true) {
        let c = i * 2 + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && before(heap[c + 1], heap[c])) c++;
        if (!before(heap[c], last)) break;
        heap[i] = heap[c];
        i = c;
      }
      heap[i] = last;
    }
    return top;
  };
  let outletCount = 0;
  if (grid.boundary === 'open') {
    for (let z = 0; z < grid.height; z++)
      for (let x = 0; x < grid.width; x++)
        if (x === 0 || z === 0 || x === grid.width - 1 || z === grid.height - 1) {
          const i = z * grid.width + x;
          visited[i] = 1;
          basin[i] = outletCount++;
          push(i);
        }
  } else {
    let sink = 0;
    for (let i = 1; i < count; i++) if (input[i] < input[sink]) sink = i;
    visited[sink] = 1;
    basin[sink] = 0;
    outletCount = 1;
    push(sink);
  }
  while (heap.length) {
    const i = pop(),
      x = i % grid.width,
      z = Math.floor(i / grid.width);
    order.push(i);
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
        filledHeight[next] = Math.max(input[next], filledHeight[i]);
        push(next);
      }
  }
  const contributingAreaM2 = geometry(grid).areas;
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k];
    if (receiver[i] >= 0) contributingAreaM2[receiver[i]] += contributingAreaM2[i];
  }
  return { receiver, filledHeight, contributingAreaM2, basin, outletCount };
}

/**
 * Bounded, experimental whole-domain finite-volume transport. Each directed
 * face is reconciled once, with opposite signed water/sediment contributions.
 * Tiles partition flux preparation, then canonical face order makes results
 * independent of tile shape/order. This is a CPU reference, not a geophysical
 * calibration or an out-of-core native 8K solver.
 */
export async function simulateWorldTransport(
  input: ArrayLike<number>,
  grid: TransportGrid,
  settings: WorldTransportSettings,
  options: TransportOptions = {},
): Promise<WorldTransportResult> {
  if (options.signal?.aborted) throw new DOMException('World transport cancelled.', 'AbortError');
  validateGrid(input, grid);
  if (
    !Number.isSafeInteger(settings.iterations) ||
    settings.iterations < 1 ||
    settings.iterations > 128
  )
    throw new Error('Transport iterations must be from 1 to 128.');
  for (const key of [
    'rainfall',
    'evaporation',
    'conductivity',
    'capacity',
    'erosion',
    'deposition',
    'talusDegrees',
    'thermal',
    'soilDepth',
  ] as const)
    if (!Number.isFinite(settings[key]) || settings[key] < 0)
      throw new Error(`Invalid transport ${key}.`);
  if (
    settings.evaporation > 1 ||
    settings.erosion > 1 ||
    settings.deposition > 1 ||
    settings.thermal > 1 ||
    settings.talusDegrees >= 90
  )
    throw new Error('Transport rates must stay within their physical/numerical bounds.');
  const tileSize = options.tileCells ?? 64;
  if (!Number.isSafeInteger(tileSize) || tileSize < 1 || tileSize > 1024)
    throw new Error('Transport tiles need 1–1024 samples per side.');
  const { dx, dz, areas } = geometry(grid),
    count = input.length;
  const height = Float64Array.from(input),
    initial = Float64Array.from(input),
    bedrock = Float64Array.from(input, (v) => v - settings.soilDepth);
  const water = new Float64Array(count),
    sediment = new Float64Array(count),
    flow = new Float64Array(count),
    wear = new Float64Array(count),
    deposition = new Float64Array(count);
  const east = new Float64Array(count),
    south = new Float64Array(count),
    outgoing = new Float64Array(count),
    boundary = new Float64Array(count),
    limiter = new Float64Array(count);
  const waterDelta = new Float64Array(count),
    sedimentDelta = new Float64Array(count),
    terrainDelta = new Float64Array(count);
  const tiles: { x: number; z: number }[] = [];
  for (let z = 0; z < grid.height; z += tileSize)
    for (let x = 0; x < grid.width; x += tileSize) tiles.push({ x, z });
  if (options.tileOrder === 'reverse') tiles.reverse();
  const eachCell = (fn: (i: number, x: number, z: number) => void) => {
    for (const tile of tiles)
      for (let z = tile.z; z < Math.min(grid.height, tile.z + tileSize); z++)
        for (let x = tile.x; x < Math.min(grid.width, tile.x + tileSize); x++)
          fn(z * grid.width + x, x, z);
  };
  const eachFace = (fn: (a: number, b: number, raw: number, crossing: boolean) => void) => {
    for (let z = 0; z < grid.height; z++)
      for (let x = 0; x < grid.width; x++) {
        const i = z * grid.width + x;
        if (x + 1 < grid.width)
          fn(i, i + 1, east[i], Math.floor(x / tileSize) !== Math.floor((x + 1) / tileSize));
        if (z + 1 < grid.height)
          fn(
            i,
            i + grid.width,
            south[i],
            Math.floor(z / tileSize) !== Math.floor((z + 1) / tileSize),
          );
      }
  };
  const budget: WorldMassBudget = {
    iterations: settings.iterations,
    areaM2: grid.widthMeters * grid.depthMeters,
    rainfallVolumeM3: 0,
    evaporationVolumeM3: 0,
    exportedWaterVolumeM3: 0,
    finalWaterVolumeM3: 0,
    waterResidualM3: 0,
    erodedVolumeM3: 0,
    depositedVolumeM3: 0,
    exportedSedimentVolumeM3: 0,
    suspendedSedimentVolumeM3: 0,
    solidResidualM3: 0,
    thermalMovedVolumeM3: 0,
    sharedFaceWaterVolumeM3: 0,
  };
  const drainage = routeWorldDrainage(input, grid),
    talus = Math.tan((settings.talusDegrees * Math.PI) / 180);
  for (let step = 0; step < settings.iterations; step++) {
    if (options.signal?.aborted) throw new DOMException('World transport cancelled.', 'AbortError');
    for (let i = 0; i < count; i++) {
      const rain = settings.rainfall * areas[i];
      water[i] += rain;
      budget.rainfallVolumeM3 += rain;
    }
    east.fill(0);
    south.fill(0);
    outgoing.fill(0);
    boundary.fill(0);
    waterDelta.fill(0);
    sedimentDelta.fill(0);
    eachCell((i, x, z) => {
      const surface = height[i] + water[i] / areas[i];
      const faceZ = dz * (z === 0 || z === grid.height - 1 ? 0.5 : 1),
        faceX = dx * (x === 0 || x === grid.width - 1 ? 0.5 : 1);
      if (x + 1 < grid.width)
        east[i] =
          ((settings.conductivity * (surface - height[i + 1] - water[i + 1] / areas[i + 1])) / dx) *
          faceZ;
      if (z + 1 < grid.height)
        south[i] =
          ((settings.conductivity *
            (surface - height[i + grid.width] - water[i + grid.width] / areas[i + grid.width])) /
            dz) *
          faceX;
      if (grid.boundary === 'open') {
        const depth = water[i] / areas[i];
        boundary[i] =
          settings.conductivity *
          depth *
          ((x === 0 || x === grid.width - 1 ? faceZ / (dx * 0.5) : 0) +
            (z === 0 || z === grid.height - 1 ? faceX / (dz * 0.5) : 0));
      }
    });
    eachFace((a, b, raw) => {
      outgoing[raw >= 0 ? a : b] += Math.abs(raw);
    });
    for (let i = 0; i < count; i++) {
      outgoing[i] += boundary[i];
      limiter[i] = outgoing[i] > 0 ? Math.min(1, water[i] / outgoing[i]) : 0;
    }
    eachFace((a, b, raw, crossing) => {
      const donor = raw >= 0 ? a : b,
        receiver = raw >= 0 ? b : a,
        q = Math.abs(raw) * limiter[donor];
      const s = water[donor] > 0 ? (q * sediment[donor]) / water[donor] : 0;
      waterDelta[donor] -= q;
      waterDelta[receiver] += q;
      sedimentDelta[donor] -= s;
      sedimentDelta[receiver] += s;
      flow[donor] += q;
      if (crossing) budget.sharedFaceWaterVolumeM3 += q;
    });
    for (let i = 0; i < count; i++) {
      const q = boundary[i] * limiter[i],
        s = water[i] > 0 ? (q * sediment[i]) / water[i] : 0;
      waterDelta[i] -= q;
      sedimentDelta[i] -= s;
      flow[i] += q;
      budget.exportedWaterVolumeM3 += q;
      budget.exportedSedimentVolumeM3 += s;
      water[i] = Math.max(0, water[i] + waterDelta[i]);
      sediment[i] = Math.max(0, sediment[i] + sedimentDelta[i]);
      const evaporated = water[i] * settings.evaporation;
      water[i] -= evaporated;
      budget.evaporationVolumeM3 += evaporated;
    }
    // Erosion/deposition uses the same post-advection suspended volume. Terrain
    // changes are staged simultaneously so scan order cannot affect capacity.
    terrainDelta.fill(0);
    for (let z = 0; z < grid.height; z++)
      for (let x = 0; x < grid.width; x++) {
        const i = z * grid.width + x;
        let slope = 0;
        if (x) slope = Math.max(slope, (height[i] - height[i - 1]) / dx);
        if (x + 1 < grid.width) slope = Math.max(slope, (height[i] - height[i + 1]) / dx);
        if (z) slope = Math.max(slope, (height[i] - height[i - grid.width]) / dz);
        if (z + 1 < grid.height) slope = Math.max(slope, (height[i] - height[i + grid.width]) / dz);
        const capacity = settings.capacity * (water[i] + outgoing[i] * limiter[i]) * slope;
        if (sediment[i] > capacity) {
          const moved = (sediment[i] - capacity) * settings.deposition;
          sediment[i] -= moved;
          terrainDelta[i] += moved / areas[i];
          deposition[i] += moved / areas[i];
          budget.depositedVolumeM3 += moved;
        } else {
          const moved = Math.min(
            (capacity - sediment[i]) * settings.erosion,
            Math.max(0, height[i] - bedrock[i]) * areas[i],
          );
          sediment[i] += moved;
          terrainDelta[i] -= moved / areas[i];
          wear[i] += moved / areas[i];
          budget.erodedVolumeM3 += moved;
        }
      }
    for (let i = 0; i < count; i++) height[i] += terrainDelta[i];
    if (settings.thermal > 0) {
      east.fill(0);
      south.fill(0);
      outgoing.fill(0);
      terrainDelta.fill(0);
      eachCell((i, x, z) => {
        if (x + 1 < grid.width) {
          const difference = height[i] - height[i + 1];
          east[i] =
            Math.sign(difference) *
            Math.max(0, Math.abs(difference) - talus * dx) *
            Math.min(areas[i], areas[i + 1]) *
            settings.thermal *
            0.25;
        }
        if (z + 1 < grid.height) {
          const difference = height[i] - height[i + grid.width];
          south[i] =
            Math.sign(difference) *
            Math.max(0, Math.abs(difference) - talus * dz) *
            Math.min(areas[i], areas[i + grid.width]) *
            settings.thermal *
            0.25;
        }
      });
      eachFace((a, b, raw) => {
        outgoing[raw >= 0 ? a : b] += Math.abs(raw);
      });
      for (let i = 0; i < count; i++)
        limiter[i] =
          outgoing[i] > 0
            ? Math.min(1, (Math.max(0, height[i] - bedrock[i]) * areas[i]) / outgoing[i])
            : 0;
      eachFace((a, b, raw) => {
        const donor = raw >= 0 ? a : b,
          receiver = raw >= 0 ? b : a,
          q = Math.abs(raw) * limiter[donor];
        terrainDelta[donor] -= q / areas[donor];
        terrainDelta[receiver] += q / areas[receiver];
        budget.thermalMovedVolumeM3 += q;
      });
      for (let i = 0; i < count; i++) height[i] += terrainDelta[i];
    }
    options.onProgress?.((step + 1) / settings.iterations);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  if (options.signal?.aborted) throw new DOMException('World transport cancelled.', 'AbortError');
  let terrainChangeM3 = 0;
  for (let i = 0; i < count; i++) {
    budget.finalWaterVolumeM3 += water[i];
    budget.suspendedSedimentVolumeM3 += sediment[i];
    terrainChangeM3 += (height[i] - initial[i]) * areas[i];
    water[i] /= areas[i];
    if (![height[i], water[i], sediment[i], flow[i]].every(Number.isFinite))
      throw new Error('World transport exceeded its finite numerical range.');
  }
  budget.waterResidualM3 =
    budget.rainfallVolumeM3 -
    budget.evaporationVolumeM3 -
    budget.exportedWaterVolumeM3 -
    budget.finalWaterVolumeM3;
  budget.solidResidualM3 =
    terrainChangeM3 + budget.suspendedSedimentVolumeM3 + budget.exportedSedimentVolumeM3;
  return {
    height,
    waterDepth: water,
    suspendedSediment: sediment,
    flow,
    wear,
    deposition,
    drainage,
    budget,
  };
}
