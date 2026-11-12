import type { ErosionResult, ErosionSettings } from './erosion';
import { clamp, Noise } from './noise';

const DIAGONAL = 1 / Math.SQRT2;
const DX = [1, 0, 1, -1] as const;
const DY = [0, 1, 1, 1] as const;
const INVERSE_DISTANCE = [1, 1, DIAGONAL, DIAGONAL] as const;

function bilinear(values: Float32Array, n: number, x: number, y: number): number {
  const ix = Math.min(n - 2, Math.max(0, Math.floor(x)));
  const iy = Math.min(n - 2, Math.max(0, Math.floor(y)));
  const fx = clamp(x - ix), fy = clamp(y - iy);
  const i = iy * n + ix;
  return values[i] * (1 - fx) * (1 - fy) +
    values[i + 1] * fx * (1 - fy) +
    values[i + n] * (1 - fx) * fy +
    values[i + n + 1] * fx * fy;
}

function resize(values: Float32Array, n: number, m: number): Float32Array {
  if (m === n) return values.slice();
  const out = new Float32Array(m * m);
  for (let y = 0; y < m; y++) for (let x = 0; x < m; x++)
    out[y * m + x] = bilinear(
      values, n, x * (n - 1) / (m - 1), y * (n - 1) / (m - 1),
    );
  return out;
}

/** Regrid a surface density while preserving integrated physical volume. */
function resizeConservativeDensity(
  source: Float32Array, n: number, m: number,
): Float32Array {
  const out = resize(source, n, m);
  if (n === m) return out;
  let before = 0, after = 0;
  for (const value of source) before += value;
  for (const value of out) after += value;
  if (after <= 0) return out;
  const multiplier = (before / ((n - 1) * (n - 1))) /
    (after / ((m - 1) * (m - 1)));
  for (let i = 0; i < out.length; i++) out[i] *= multiplier;
  return out;
}

/**
 * Conservative column/virtual-pipe hydraulic erosion, informed by
 * Mei-Decaudin-Hu (PG 2007) and Stava-Benes et al. (SCA 2008).
 *
 * State is terrain elevation, surface water, suspended sediment and four
 * persistent signed link fluxes. Each step:
 *   1. introduces physical-coordinate rainfall;
 *   2. responds to hydraulic head differences and previous momentum;
 *   3. scales outgoing flows to the water actually available per cell;
 *   4. transports the suspended sediment with exactly the same water links;
 *   5. erodes where transport capacity exceeds carried sediment; deposits
 *      where it does not; uses paired slope slippage for over-steepened banks;
 *   6. drains water and suspended sediment at the open boundary.
 *
 * Only actual terrain changes enter wear/deposition. We do not draw random
 * river strokes or repurpose the flow diagnostic as a fake height map.
 *
 * This is a CPU-friendly 8-neighbour pipe approximation (not a Navier-Stokes
 * solver), with bounded coarse-to-fine resolution and finite step count.
 */
export function fluidGridErosion(
  input: Float32Array,
  n: number,
  settings: ErosionSettings,
  mask?: Float32Array,
  progress?: (fraction: number) => void,
): ErosionResult {
  const count = n * n;
  if (!Number.isInteger(n) || n < 2 || n > 2048 ||
      input.length !== count || (mask && mask.length !== count))
    throw new Error('Fluid erosion requires aligned square height and mask fields.');
  let minimum = Infinity, maximum = -Infinity;
  for (const value of input) {
    if (!Number.isFinite(value))
      throw new Error('Fluid erosion requires finite elevations.');
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  if (mask) for (const value of mask)
    if (!Number.isFinite(value)) throw new Error('Fluid erosion mask must be finite.');

  const relief = Math.max(1e-6, maximum - minimum);
  const floor = minimum - relief * 0.06;
  const worldMeters = Math.max(1, settings.worldSize ?? 8000);
  const elevationMeters = Math.max(1, settings.heightScale ?? 2400);
  const rainFactor = Math.sqrt(clamp(settings.droplets, 0, 500000) / 70000);
  const erodibility = clamp(settings.erosion);
  const depositionRate = clamp(settings.deposition);
  const capacity = clamp(settings.capacity / 4, 0.025, 5);
  const hillslope = clamp(settings.hillslope ?? 0.14);
  const reposeAngle = clamp(settings.bankAngle ?? 42, 18, 80) * Math.PI / 180;
  const evaporation = clamp(settings.evaporation, 0, 0.5);
  const gravity = Math.sqrt(clamp(settings.gravity, 0.01, 20) / 4);
  const steps = Math.round(clamp(settings.cycles ?? 28, 4, 72)) * 4;
  const maxSimulation = Math.min(n, 512);
  const candidate = settings.multiscale
    ? [Math.min(128, n), Math.min(256, n), maxSimulation]
    : [maxSimulation];
  const stages = candidate.filter((size, i) => candidate.indexOf(size) === i);
  const cycles = stages.map((_, index) =>
    Math.max(1, Math.round(steps *
      (stages.length === 1 ? 1 :
        stages.length === 2 ? [0.45, 0.55][index] : [0.33, 0.34, 0.33][index]))));
  // Subdivide hydraulic steps at finer physical scales without increasing
  // the artist-selected overall simulation duration.
  const substeps = stages.map(m =>
    Math.max(1, Math.min(4, Math.ceil(20 / (worldMeters / (m - 1))))));
  const stepCounts = cycles.map((c, i) => c * substeps[i]);
  const numberOfSteps = stepCounts.reduce((a, b) => a + b, 0);
  const noise = new Noise((settings.seed ^ 0x51c7a17e) >>> 0);
  const soilDepth = Math.max(0, settings.soilDepthMeters ?? 1.5) / elevationMeters;
  let previous: {
    size: number; original: Float32Array; height: Float32Array;
    mobile: Float32Array; water: Float32Array; sediment: Float32Array;
  } | undefined;
  let physicalEroded = 0, physicalDeposited = 0, physicalExported = 0;
  let finalFlow: Float32Array | undefined;
  let completed = 0;

  for (let stage = 0; stage < stages.length; stage++) {
    const m = stages[stage], length = m * m;
    const cellMeters = worldMeters / Math.max(1, m - 1);
    const original = resize(input, n, m);
    const height = original.slice();
    if (previous) {
      for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
        const sx = x * (previous.size - 1) / (m - 1);
        const sy = y * (previous.size - 1) / (m - 1);
        height[y * m + x] +=
          bilinear(previous.height, previous.size, sx, sy) -
          bilinear(previous.original, previous.size, sx, sy);
      }
    }
    const materialMask = mask ? resize(mask, n, m) : undefined;
    // Transported water and suspended sediment persist across coarse-to-fine
    // stages; deposits are tracked in a separate mobile layer.
    const mobile = previous
      ? resizeConservativeDensity(previous.mobile, previous.size, m)
      : new Float32Array(length).fill(soilDepth);
    const bedrock = new Float32Array(length);
    for (let i = 0; i < length; i++) bedrock[i] = height[i] - mobile[i];
    const water = previous
      ? resizeConservativeDensity(previous.water, previous.size, m)
      : new Float32Array(length);
    const sediment = previous
      ? resizeConservativeDensity(previous.sediment, previous.size, m)
      : new Float32Array(length);
    const volumePerSample = cellMeters * cellMeters * elevationMeters;
    const subdiv = substeps[stage];
    const retainedBoundary = Math.pow(0.4, 1 / subdiv);
    const evaporationRate = 1 - Math.pow(
      1 - Math.min(0.45, evaporation * 1.2), 1 / subdiv);
    const waterDelta = new Float32Array(length);
    const sedimentDelta = new Float32Array(length);
    const outgoing = new Float32Array(length);
    const available = new Float32Array(length);
    const movement = new Float32Array(length);
    const cumulativeFlow = new Float32Array(length);
    const rainMap = new Float32Array(length);
    const slopeMoves = new Float64Array(length);
    const pipes = Array.from({ length: 4 }, () => new Float32Array(length));
    // Rainfall and incision are expressed in physical meters rather than
    // varying with the relief of a particular input DEM.
    const rainfall = (1.6 / elevationMeters) * rainFactor;
    const maxTransfer = Math.max(1 / elevationMeters,
      Math.min(200 / elevationMeters, relief * 0.16)) / subdiv;
    const pressure = 0.25 * gravity *
      clamp(20 / cellMeters, 0.35, 2) / (subdiv * subdiv);
    const inertia = Math.pow(0.66, 1 / subdiv);
    const sedimentCapacity = 2.4 * capacity;
    const depthLimit = Math.min(relief * 0.004, 6 / elevationMeters) / subdiv;
    const relaxation = (0.006 + hillslope * 0.018) *
      Math.sqrt(128 / Math.max(128, m)) / subdiv;

    for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
      const i = y * m + x;
      const px = x * cellMeters, py = y * cellMeters;
      // Smooth spatial rain and exposure, no per-step independent random
      // droplets or pixel-index noise that would show up as lattice streaks.
      rainMap[i] = clamp(1 +
        noise.simplex(px / 2800 + 7.7, py / 2800 - 3.3) * 0.25, 0.55, 1.5);
    }

    for (let t = 0; t < stepCounts[stage]; t++) {
      for (let i = 0; i < length; i++) water[i] += rainfall * rainMap[i] / subdiv;
      outgoing.fill(0);
      waterDelta.fill(0);
      sedimentDelta.fill(0);
      movement.fill(0);

      // Signed fluxes on each undirected edge, four link orientations.
      // The other four neighbors are implicitly the reverse flow.
      for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
        const i = y * m + x;
        for (let d = 0; d < 4; d++) {
          const xx = x + DX[d], yy = y + DY[d];
          if (xx < 0 || xx >= m || yy >= m) continue;
          const j = yy * m + xx;
          const head = height[i] + water[i] - height[j] - water[j];
          const predicted = clamp(
            pipes[d][i] * inertia + head * pressure * INVERSE_DISTANCE[d],
            -maxTransfer, maxTransfer,
          );
          pipes[d][i] = predicted;
          if (predicted > 0) outgoing[i] += predicted;
          else outgoing[j] -= predicted;
        }
      }
      for (let i = 0; i < length; i++)
        available[i] = outgoing[i] > 0
          ? Math.min(1, water[i] / outgoing[i]) : 0;

      // Pipe exchanges conserve water and advected sediment separately.
      // Concentrations use pre-transport column values, never a partially
      // updated neighbor from this pass.
      for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
        const i = y * m + x;
        for (let d = 0; d < 4; d++) {
          const xx = x + DX[d], yy = y + DY[d];
          if (xx < 0 || xx >= m || yy >= m) continue;
          const j = yy * m + xx;
          const raw = pipes[d][i];
          const transfer = raw > 0
            ? raw * available[i] : raw * available[j];
          pipes[d][i] = transfer;
          waterDelta[i] -= transfer;
          waterDelta[j] += transfer;
          const origin = transfer >= 0 ? i : j;
          const sedimentMoved = Math.abs(transfer) *
            sediment[origin] / Math.max(1e-9, water[origin]);
          if (transfer >= 0) {
            sedimentDelta[i] -= sedimentMoved;
            sedimentDelta[j] += sedimentMoved;
          } else {
            sedimentDelta[j] -= sedimentMoved;
            sedimentDelta[i] += sedimentMoved;
          }
          movement[i] += Math.abs(transfer);
          movement[j] += Math.abs(transfer);
        }
      }
      for (let i = 0; i < length; i++) {
        water[i] = Math.max(0, water[i] + waterDelta[i]);
        sediment[i] = Math.max(0, sediment[i] + sedimentDelta[i]);
        cumulativeFlow[i] += movement[i];
      }

      if (rainfall > 0 && (erodibility > 0 || depositionRate > 0)) {
        for (let y = 1; y < m - 1; y++) for (let x = 1; x < m - 1; x++) {
          const i = y * m + x, allowance =
            materialMask ? clamp(materialMask[i]) : 1;
          if (allowance <= 0) continue;
          const grade = Math.hypot(
            (height[i + 1] - height[i - 1]) * 0.5,
            (height[i + m] - height[i - m]) * 0.5,
          ) * elevationMeters / cellMeters;
          // A mathematically level source cannot initiate a channel, but
          // sediment already in suspension must still settle in slow water.
          const carrying = grade < 1e-5 ? 0 : Math.max(0,
            sedimentCapacity * movement[i] * subdiv * Math.sqrt(grade) *
            (1 + Math.min(2, water[i] * 20)) -
              (1.6 / elevationMeters) * 2.2);
          const excess = carrying - sediment[i];
          if (excess > 0 && erodibility > 0) {
            const requested = Math.min(
              excess * (0.045 + erodibility * 0.13) * erodibility / subdiv,
              depthLimit,
              Math.max(0, height[i] - floor),
            ) * allowance;
            const before = height[i];
            const loose = Math.min(mobile[i], requested);
            mobile[i] -= loose;
            bedrock[i] -= requested - loose;
            height[i] = bedrock[i] + mobile[i];
            const removed = Math.max(0, before - height[i]);
            sediment[i] += removed;
            physicalEroded += removed * volumePerSample;
          } else if (excess < 0 && depositionRate > 0) {
            const settle = Math.min(sediment[i],
              -excess * depositionRate * 0.095 / subdiv) * allowance;
            const before = height[i];
            mobile[i] += settle;
            height[i] = bedrock[i] + mobile[i];
            const actual = Math.max(0, height[i] - before);
            sediment[i] = Math.max(0, sediment[i] - actual);
            physicalDeposited += actual * volumePerSample;
          }
        }
      }

      // Mass-conserving hillslope slippage, particularly along freshly
      // undercut riverbanks. Process each pair only once, then apply all
      // changes simultaneously to remove directional scan bias.
      if (hillslope > 0 && (t & 3) === 3) {
        slopeMoves.fill(0);
        const threshold = Math.tan(reposeAngle) * cellMeters / elevationMeters;
        for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
          const i = y * m + x;
          if (x + 1 < m) {
            const j = i + 1;
            const difference = height[i] - height[j];
            const permission = materialMask
              ? Math.min(clamp(materialMask[i]), clamp(materialMask[j])) : 1;
            const moved = Math.sign(difference) *
              Math.max(0, Math.abs(difference) - threshold) *
              relaxation * permission;
            slopeMoves[i] -= moved;
            slopeMoves[j] += moved;
          }
          if (y + 1 < m) {
            const j = i + m;
            const difference = height[i] - height[j];
            const permission = materialMask
              ? Math.min(clamp(materialMask[i]), clamp(materialMask[j])) : 1;
            const moved = Math.sign(difference) *
              Math.max(0, Math.abs(difference) - threshold) *
              relaxation * permission;
            slopeMoves[i] -= moved;
            slopeMoves[j] += moved;
          }
        }
        for (let i = 0; i < length; i++) {
          const change = slopeMoves[i];
          if (change < 0) {
            const loose = Math.min(mobile[i], -change);
            mobile[i] -= loose;
            bedrock[i] -= -change - loose;
          } else if (change > 0) {
            mobile[i] += change;
          }
          if (change !== 0) height[i] = bedrock[i] + mobile[i];
        }
      }

      // Open boundary: water/suspended sediment leave instead of forming a
      // tile-edge dam or giant erosion stripe. Accumulate actual outlet flow.
      for (let x = 0; x < m; x++) {
        for (const i of [x, (m - 1) * m + x]) {
          water[i] *= 0.4;
          sediment[i] *= 0.4;
        }
      }
      for (let y = 1; y < m - 1; y++) {
        for (const i of [y * m, y * m + m - 1]) {
          water[i] *= 0.4;
          sediment[i] *= 0.4;
        }
      }
      for (let i = 0; i < length; i++)
        water[i] *= 1 - Math.min(0.45, evaporation * 1.2);
      completed++;
      progress?.(Math.min(0.999, completed / numberOfSteps));
    }
    previous = { size: m, original, height };
    finalFlow = cumulativeFlow;
  }

  // Existing heightfield exports must retain their requested resolution.
  // Reconstruct the *net* terrain delta and preserve original high-frequency
  // bedrock from the input, without claiming fine-resolution fluid simulation.
  const height = input.slice();
  const flow = new Float32Array(count);
  const wear = new Float32Array(count);
  const deposition = new Float32Array(count);
  let eroded = 0, deposited = 0;
  if (previous && finalFlow) {
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const sx = x * (previous.size - 1) / Math.max(1, n - 1);
      const sy = y * (previous.size - 1) / Math.max(1, n - 1);
      const delta = bilinear(previous.height, previous.size, sx, sy) -
        bilinear(previous.original, previous.size, sx, sy);
      const changed = delta * (mask ? clamp(mask[i]) : 1);
      height[i] += changed;
      flow[i] = bilinear(finalFlow, previous.size, sx, sy);
      const actual = height[i] - input[i];
      if (actual < 0) {
        wear[i] = -actual;
        eroded -= actual;
      } else if (actual > 0) {
        deposition[i] = actual;
        deposited += actual;
      }
    }
  }
  progress?.(1);
  return {
    height, flow, wear, deposition, eroded, deposited,
    exportedSediment: Math.max(0, eroded - deposited),
  };
}
