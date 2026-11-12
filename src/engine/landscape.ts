import { clamp, Noise } from './noise';
import type { ErosionResult, ErosionSettings } from './erosion';
import { createDrainageWorkspace, routeDrainage } from './hydrology';
import { accumulateMultiFlow } from './landscapeFlow';

// Matches the D8 ordering used in landscapeFlow's partition fractions.
const FLOW_DX = [-1, 0, 1, -1, 1, -1, 0, 1] as const;
const FLOW_DY = [-1, -1, -1, 0, 0, 1, 1, 1] as const;

const smooth = (a: number, b: number, value: number): number => {
  const t = clamp((value - a) / Math.max(1e-9, b - a));
  return t * t * (3 - 2 * t);
};

function sample(values: Float32Array, n: number, x: number, y: number): number {
  const xx = clamp(x, 0, n - 1), yy = clamp(y, 0, n - 1);
  const ix = Math.min(n - 2, Math.floor(xx));
  const iy = Math.min(n - 2, Math.floor(yy));
  const fx = xx - ix, fy = yy - iy;
  const k = iy * n + ix;
  return values[k] * (1 - fx) * (1 - fy) +
    values[k + 1] * fx * (1 - fy) +
    values[k + n] * (1 - fx) * fy +
    values[k + n + 1] * fx * fy;
}

function resample(values: Float32Array, n: number, m: number): Float32Array {
  if (n === m) return values.slice();
  const out = new Float32Array(m * m);
  for (let y = 0; y < m; y++) {
    const sy = y * (n - 1) / (m - 1);
    for (let x = 0; x < m; x++)
      out[y * m + x] = sample(values, n, x * (n - 1) / (m - 1), sy);
  }
  return out;
}

/**
 * A lightweight separable Gaussian of *simulation displacement*, not of the
 * source terrain. The source bedrock is never blurred. This lets long-period
 * valley evolution change regional geometry without depositing a smoothing
 * blanket over hard-rock gullies finer than the simulated sediment scale.
 */
function smoothDisplacement(source: Float32Array, n: number): Float32Array {
  const weights = [1, 4, 6, 4, 1];
  let current = source;
  for (let pass = 0; pass < 2; pass++) {
    const across = new Float32Array(n * n);
    const down = new Float32Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      let sum = 0, denom = 0;
      for (let d = -2; d <= 2; d++) {
        const xx = x + d;
        if (xx < 0 || xx >= n) continue;
        const weight = weights[d + 2];
        sum += current[y * n + xx] * weight;
        denom += weight;
      }
      across[y * n + x] = sum / denom;
    }
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      let sum = 0, denom = 0;
      for (let d = -2; d <= 2; d++) {
        const yy = y + d;
        if (yy < 0 || yy >= n) continue;
        const weight = weights[d + 2];
        sum += across[yy * n + x] * weight;
        denom += weight;
      }
      down[y * n + x] = sum / denom;
    }
    current = down;
  }
  return current;
}

/**
 * A bounded, multi-resolution landscape-evolution model.
 *
 * Scientific basis:
 * - outlet-connected, depression-aware priority flood, supplemented by MFD
 *   (multiple flow direction) contributing discharge to reduce D8 striping;
 * - stream-power incision E ~ K A^0.45 S^0.9, with geometric bank widening;
 * - sediment flux that travels downstream, with slope/discharge-dependent
 *   transport capacity, finite deposition and open-boundary export;
 * - conservative hillslope creep / over-steepened bank relaxation;
 * - physical-scale, coarse-to-fine integration that preserves the original
 *   high-frequency terrain residual at each refinement stage.
 *
 * This is a terrain-artist landscape evolution model, NOT solved shallow-water
 * equations, measured rock competence, or geologic-year-calibrated physics.
 * K and integration duration are dimensionless. Higher output resolution is
 * not mistaken for independent physical detail below the simulated cell size.
 *
 * Compute memory is O(min(n,512)^2 + n^2), with no per-cell object allocation.
 */
export function landscapeErosion(
  input: Float32Array,
  n: number,
  settings: ErosionSettings,
  mask?: Float32Array,
  progress?: (fraction: number) => void,
): ErosionResult {
  if (!Number.isInteger(n) || n < 2 || n > 2048 ||
      input.length !== n * n || (mask && mask.length !== n * n))
    throw new Error('Landscape evolution requires aligned square terrain grids.');
  let min = Infinity, max = -Infinity;
  for (const value of input) {
    if (!Number.isFinite(value)) throw new Error('Landscape evolution needs finite elevations.');
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  if (mask) for (const value of mask)
    if (!Number.isFinite(value)) throw new Error('Landscape mask values must be finite.');
  const count = n * n, world = Math.max(1, settings.worldSize ?? 8000);
  const heightScale = Math.max(1, settings.heightScale ?? 2400);
  const relief = Math.max(1e-5, max - min);
  const floor = min - relief * 0.14;
  const rainfall = clamp(settings.droplets / 70000, 0, 7.2);
  const strength = clamp(settings.erosion);
  const duration = clamp(settings.lifetime / 64, 0.125, 3.125);
  const cycles = Math.round(clamp(settings.cycles ?? 28, 4, 72));
  const featureMeters = clamp(settings.featureMeters ?? 140, 24, 600);
  const bankAngle = clamp(settings.bankAngle ?? 38, 18, 80) * Math.PI / 180;
  const hillslope = clamp(settings.hillslope ?? 0.12);
  const carry = clamp(settings.capacity / 4, 0.025, 5);
  const settling = clamp(settings.deposition);
  const widthFactor = clamp(settings.radius / 3, 0.3, 3);
  const evaporation = clamp(settings.evaporation, 0, 0.5);
  const gravity = Math.sqrt(clamp(settings.gravity, 0.01, 20) / 4);
  const noise = new Noise((settings.seed ^ 0x517cc1b7) >>> 0);

  const desired = settings.multiscale
    ? [Math.min(128, n), Math.min(256, n), Math.min(512, n)]
    : [Math.min(n, 512)];
  const stages = desired.filter((value, i) => desired.indexOf(value) === i);
  const weights = stages.map((_, i) => stages.length === 1
    ? 1 : stages.length === 2 ? [0.58, 0.42][i] : [0.43, 0.34, 0.23][i]);
  let previous: { resolution: number; height: Float32Array; original: Float32Array; alluvium: Float32Array } | null = null;
  let physicalEroded = 0, physicalDeposited = 0, physicalExported = 0;
  const initialSoil = Math.max(0, settings.soilDepthMeters ?? 1.5) / heightScale;
  let latestFlow: Float32Array | null = null, latestResolution = 0;
  let completedCycles = 0;

  for (let stageIndex = 0; stageIndex < stages.length; stageIndex++) {
    const m = stages[stageIndex], cell = world / (m - 1), size = m * m;
    const original = resample(input, n, m);
    const height = original.slice();
    if (previous) {
      // Transfer only physical height changes. Recover the fine structure of
      // the *source* DEM instead of interpolating coarse erosional pixels into
      // fake surface detail.
      const old = previous;
      for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
        const sx = x * (old.resolution - 1) / (m - 1);
        const sy = y * (old.resolution - 1) / (m - 1);
        height[y * m + x] += sample(old.height, old.resolution, sx, sy) -
          sample(old.original, old.resolution, sx, sy);
      }
    }
    // Height is split into immobile rock and mobile alluvium. The original
    // surface stays unchanged: an initial cover is taken from its own height.
    const alluvium = new Float32Array(size), bedrock = new Float32Array(size);
    for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
      const i = y * m + x;
      alluvium[i] = previous
        ? Math.max(0, sample(previous.alluvium, previous.resolution,
            x * (previous.resolution - 1) / (m - 1),
            y * (previous.resolution - 1) / (m - 1)))
        : initialSoil;
      bedrock[i] = height[i] - alluvium[i];
    }
    const stageMask = mask ? resample(mask, n, m) : null;
    const rain = new Float32Array(size);
    const drainage = createDrainageWorkspace(m);
    const sediment = new Float32Array(size);
    const fractions = new Float32Array(size * 8);
    const localSediment = new Float32Array(size);
    const creepChanges = new Float64Array(size);
    const fanIndices = new Int32Array(5);
    const fanWeights = [0.55, 0.1125, 0.1125, 0.1125, 0.1125];
    let stageEroded = 0, stageDeposited = 0, stageExported = 0;
    const volumePerSample = world * world / size * heightScale;
    const stageCycles = Math.max(1, Math.round(cycles * weights[stageIndex]));
    const dt = duration * 28 / Math.max(1, cycles);
    const stageFeature = featureMeters *
      (stageIndex === 0 && stages.length > 1 ? 1.65 : 1);
    // Channel initiation requires a watershed large enough to organize
    // real convergent water, not simply two or three same-direction D8 cells.
    // The early broad pass only incises trunk valleys. Later passes admit
    // successively smaller tributary catchments at the same physical units.
    const scaleFactor = stages.length > 1
      ? stageIndex === 0 ? 6 : stageIndex === stages.length - 1 ? 1 : 3
      : 1;
    const minimumCatchmentKm2 = Math.max(0.012,
      stageFeature * stageFeature / 1_000_000 * scaleFactor);
    const windX = Math.cos(settings.seed * 0.00017);
    const windY = Math.sin(settings.seed * 0.00017);

    // Gentle, low-frequency orographic variations in rainfall are fixed in
    // physical meters, not re-randomized with each evolution iteration.
    for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
      const i = y * m + x;
      const px = x * cell, py = y * cell;
      const left = original[y * m + Math.max(0, x - 1)];
      const right = original[y * m + Math.min(m - 1, x + 1)];
      const up = original[Math.max(0, y - 1) * m + x];
      const down = original[Math.min(m - 1, y + 1) * m + x];
      const orographic = ((right - left) * windX + (down - up) * windY) *
        heightScale / Math.max(1, 2 * cell);
      const macro = noise.simplex(px / 2800 + 4.3, py / 2800 - 6.1);
      rain[i] = rainfall * clamp(1 + macro * 0.22 + orographic * 0.16, 0.3, 1.6);
    }

    const remove = (index: number, amount: number): number => {
      if (!(amount > 0)) return 0;
      const permission = stageMask ? clamp(stageMask[index]) : 1;
      if (!permission) return 0;
      const take = Math.min(amount * permission, Math.max(0, height[index] - floor));
      const before = height[index];
      const loose = Math.min(alluvium[index], take);
      alluvium[index] -= loose;
      bedrock[index] -= take - loose;
      height[index] = bedrock[index] + alluvium[index];
      const actual = Math.max(0, before - height[index]);
      stageEroded += actual;
      return actual;
    };
    const deposit = (index: number, amount: number): number => {
      const permission = stageMask ? clamp(stageMask[index]) : 1;
      if (!permission || !(amount > 0)) return 0;
      const before = height[index];
      alluvium[index] += amount * permission;
      height[index] = bedrock[index] + alluvium[index];
      const actual = Math.max(0, height[index] - before);
      stageDeposited += actual;
      return actual;
    };

    for (let step = 0; step < stageCycles; step++) {
      routeDrainage(height, m, settings.seed + step * 173 + stageIndex * 1327, drainage);
      const area = accumulateMultiFlow(height, drainage, rain, world, evaporation, fractions);
      localSediment.fill(0);
      const { order, receiver, spill } = drainage;
      if (strength > 0 && rainfall > 0) {
        // Downstream -> upstream: an incised channel propagates headward from
        // the outlet. A broad stage starts the valley, fine stages refine it.
        for (let k = 0; k < size; k++) {
          const i = order[k], downstream = receiver[i];
          if (downstream < 0) continue;
          const cx = i % m, cy = (i / m) | 0;
          const rx = downstream % m, ry = (downstream / m) | 0;
          const ddx = rx - cx, ddy = ry - cy;
          const distance = cell * Math.hypot(ddx, ddy);
          const head = height[i] - height[downstream];
          if (head <= 0 || spill[i] - height[i] > 0.003 * relief) continue;
          const grade = head * heightScale / distance;
          if (grade <= 0.001) continue;
          const contributingKm2 = area[i] * world * world / size / 1e6;
          const aNorm = contributingKm2 / (world * world / 1e6);
          // Small sheet runoff is not a river. This catchment threshold is
          // physical area, rather than a number of droplets or raster pixels.
          if (contributingKm2 < minimumCatchmentKm2) continue;
          const gx = sample(height, m, cx + 1, cy) -
            sample(height, m, cx - 1, cy);
          const gy = sample(height, m, cx, cy + 1) -
            sample(height, m, cx, cy - 1);
          const glen = Math.hypot(gx, gy);
          if (glen < 1e-10) continue;
          const tx = -gy / glen, ty = gx / glen;
          const radiusMeters = Math.max(cell * 1.45, stageFeature);
          const radiusCells = Math.min(5, radiusMeters / cell);
          const ax = cx + tx * radiusCells, ay = cy + ty * radiusCells;
          const bx = cx - tx * radiusCells, by = cy - ty * radiusCells;
          if (ax < 0 || ay < 0 || bx < 0 || by < 0 ||
              ax > m - 1 || ay > m - 1 || bx > m - 1 || by > m - 1) continue;
          const cross = 0.5 * (sample(height, m, ax, ay) +
            sample(height, m, bx, by)) - height[i];
          // Physically measured bank rise suppresses false channels on an
          // affine plane. Tributaries can lengthen as upstream valleys incise.
          const valley = smooth(0.00018, 0.005, cross / relief);
          if (valley < 0.015) continue;
          const power = Math.pow(Math.max(aNorm, 1e-8), 0.45) *
            Math.pow(Math.min(2.5, grade), 0.9);
          const depth = Math.min(
            relief * 0.55 * strength * dt * gravity *
              power * (0.22 + valley * 0.78),
            head * 0.82,
            relief * 0.045,
          );
          if (depth <= 1e-8) continue;
          let erodedAt = remove(i, depth);
          // Riverbank and valley-wall retreat forms a real V/U section, not
          // merely a deep single-cell line. Every shifted sample is counted
          // in the same sediment budget as bed incision.
          const widthMeters = Math.min(stageFeature * 2.5,
            stageFeature * 0.50 +
              32 * Math.pow(Math.max(0.01, contributingKm2), 0.35)) *
            widthFactor;
          const bankCells = Math.min(5, Math.max(1, Math.round(widthMeters / cell)));
          const centerBed = height[i];
          for (let by = -bankCells; by <= bankCells; by++) {
            const yy = cy + by;
            if (yy < 0 || yy >= m) continue;
            for (let bx = -bankCells; bx <= bankCells; bx++) {
              const xx = cx + bx;
              if (xx < 0 || xx >= m || (bx === 0 && by === 0)) continue;
              const r = Math.hypot(bx, by);
              if (r > bankCells) continue;
              const idx = yy * m + xx;
              const target = centerBed + r * cell * Math.tan(bankAngle) / heightScale;
              const excess = height[idx] - target;
              if (excess <= 0) continue;
              const shoulder = Math.max(0, 1 - r * r / (bankCells + 0.5) ** 2);
              erodedAt += remove(idx, Math.min(
                excess * 0.22 * shoulder * valley, relief * 0.012 * dt,
              ));
            }
          }
          localSediment[i] += erodedAt;
        }

        // Sediment is transported in the true downstream topological order;
        // shallow outlets export the remainder and low-gradient valleys build
        // broad deposits. Nothing is secretly re-added without removal.
        sediment.fill(0);
        for (let k = size - 1; k >= 0; k--) {
          const i = order[k], downstream = receiver[i];
          let carried = sediment[i] + localSediment[i];
          if (downstream < 0) {
            // All water-linked sediment is processed in topological order.
            stageExported += carried;
            continue;
          }
          if (carried <= 0) continue;
          const sx = Math.abs(i % m - downstream % m);
          const sy = Math.abs(((i / m) | 0) - ((downstream / m) | 0));
          const grade = Math.max(0,
            (height[i] - height[downstream]) * heightScale /
              (cell * (sx && sy ? Math.SQRT2 : 1)));
          // Capacity is based on *physical* rain-weighted catchment area,
          // not an arbitrary number of contributing raster pixels.
          // 2500 m² is a fixed coefficient reference, independent of m.
          const dischargeReference = area[i] * world * world / size / 2500;
          const capacity = relief * 0.032 * carry *
            Math.pow(Math.max(1e-8, dischargeReference), 0.56) *
            Math.pow(Math.max(0.001, grade), 0.85);
          const ponded = spill[i] > height[i] + relief * 0.0005;
          const surplus = Math.max(0, carried - (ponded ? 0 : capacity));
          if (surplus > 0 && settling > 0) {
            const toSettle = Math.min(carried,
              surplus * settling * (ponded ? 0.55 : 0.22),
              relief * 0.014);
            let settled = 0;
            // Deposit a shallow alluvial fan instead of a single spike.
            const xx = i % m, yy = (i / m) | 0;
            fanIndices[0] = i;
            fanIndices[1] = xx > 0 ? i - 1 : -1;
            fanIndices[2] = xx < m - 1 ? i + 1 : -1;
            fanIndices[3] = yy > 0 ? i - m : -1;
            fanIndices[4] = yy < m - 1 ? i + m : -1;
            let weightSum = 0;
            for (let p = 0; p < 5; p++) if (fanIndices[p] >= 0) {
              const q = stageMask ? clamp(stageMask[fanIndices[p]]) : 1;
              weightSum += fanWeights[p] * q;
            }
            if (weightSum > 0) for (let p = 0; p < 5; p++) {
              const target = fanIndices[p];
              if (target >= 0) settled += deposit(target,
                toSettle * fanWeights[p] / weightSum);
            }
            carried -= settled;
          }
          // Exactly the same MFD fractions used for runoff direct suspended
          // sediment to each downstream receiver; do not put it all on D8.
          for (let d = 0; d < 8; d++) {
            const share = fractions[i * 8 + d];
            if (share > 0)
              sediment[i + FLOW_DY[d] * m + FLOW_DX[d]] += carried * share;
          }
        }
      }

      // Conservative paired hillslope transfers, after the river bed changes.
      // Only above the repose angle; an analytic gently tilted plane is
      // unchanged and cannot turn into an arbitrary grid of parallel grooves.
      if (hillslope > 0) {
        creepChanges.fill(0);
        const repose = Math.tan(bankAngle * 0.70);
        for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
          const i = y * m + x;
          for (let direction = 0; direction < 2; direction++) {
            const j = direction === 0 ? (x < m - 1 ? i + 1 : -1)
              : (y < m - 1 ? i + m : -1);
            if (j < 0) continue;
            const difference = height[i] - height[j];
            const slope = Math.abs(difference) * heightScale / cell;
            if (slope <= repose) continue;
            const permission = stageMask
              ? Math.min(clamp(stageMask[i]), clamp(stageMask[j])) : 1;
            if (!permission) continue;
            const moved = Math.min(
              Math.abs(difference) * 0.085,
              (slope - repose) * cell / heightScale * 0.085,
            ) * hillslope * dt * permission;
            const signed = Math.sign(difference) * moved;
            creepChanges[i] -= signed;
            creepChanges[j] += signed;
          }
        }
        for (let i = 0; i < size; i++) if (creepChanges[i]) {
          const change = creepChanges[i];
          if (change < 0) {
            const loosened = Math.min(alluvium[i], -change);
            alluvium[i] -= loosened;
            bedrock[i] -= -change - loosened;
          } else {
            alluvium[i] += change;
          }
          height[i] = bedrock[i] + alluvium[i];
        }
      }
      completedCycles++;
      progress?.(Math.min(0.999, completedCycles / cycles));
    }

    routeDrainage(height, m, settings.seed + 33533, drainage);
    const finalArea = accumulateMultiFlow(height, drainage, rain, world, evaporation);
    latestFlow = new Float32Array(size);
    const areaM2 = cell * cell;
    for (let i = 0; i < size; i++) latestFlow[i] = finalArea[i] * areaM2 / 1e6;
    latestResolution = m;
    physicalEroded += stageEroded * volumePerSample;
    physicalDeposited += stageDeposited * volumePerSample;
    physicalExported += stageExported * volumePerSample;
    previous = { resolution: m, height, original, alluvium };
  }

  // Recompose the original resolution from the last simulated river/valley
  // delta. This preserves original high-frequency bedrock relief and avoids
  // claiming that a finer export produced new, physically resolved gullies.
  const result = input.slice();
  const wear = new Float32Array(count);
  const deposition = new Float32Array(count);
  const flow = new Float32Array(count);
  if (previous) {
    let protectedChanges: Float32Array | null = null;
    if (settings.bedrockPreserve) {
      const resolution = previous.resolution;
      const changes = new Float32Array(resolution * resolution);
      for (let i = 0; i < changes.length; i++)
        changes[i] = previous.height[i] - previous.original[i];
      // Only the simulated loose-material / regional change is filtered;
      // the input's fine-scale pre-incised bedrock is retained bit-for-bit
      // in the final re-composition rather than being flattened by creep.
      protectedChanges = smoothDisplacement(changes, resolution);
    }
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const sx = x * (previous.resolution - 1) / (n - 1);
      const sy = y * (previous.resolution - 1) / (n - 1);
      const net = protectedChanges
        ? sample(protectedChanges, previous.resolution, sx, sy)
        : sample(previous.height, previous.resolution, sx, sy) -
          sample(previous.original, previous.resolution, sx, sy);
      const permission = mask ? clamp(mask[i]) : 1;
      result[i] += net * permission;
      flow[i] = latestFlow
        ? sample(latestFlow, latestResolution,
            x * (latestResolution - 1) / (n - 1),
            y * (latestResolution - 1) / (n - 1))
        : 0;
    }
  }
  let eroded = 0, deposited = 0;
  for (let i = 0; i < count; i++) {
    const difference = input[i] - result[i];
    if (difference > 0) {
      wear[i] = difference;
      eroded += difference;
    } else if (difference < 0) {
      deposition[i] = -difference;
      deposited -= difference;
    }
  }
  progress?.(1);
  return {
    height: result, flow, wear, deposition, eroded, deposited,
    // Legacy summary remains expressed as output-grid sample-height units.
    // This physical budget is independently measured at simulation resolution;
    // it is not inferred from the recomposed output heightmap.
    exportedSediment: Math.max(0, eroded - deposited),
    sedimentBudget: {
      erodedVolumeM3: physicalEroded,
      depositedVolumeM3: physicalDeposited,
      exportedVolumeM3: physicalExported,
      suspendedVolumeM3: 0,
      balanceErrorM3: physicalEroded - physicalDeposited - physicalExported,
    },
  };
}
