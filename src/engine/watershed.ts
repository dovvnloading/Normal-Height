import { clamp } from './noise';
import type { ErosionResult, ErosionSettings } from './erosion';
import { accumulateDrainage, createDrainageWorkspace, routeDrainage } from './hydrology';

/**
 * Watershed-guided landscape evolution.
 *
 * This is an explicit, mass-accounted stream-power / sediment-flux model,
 * not a fluid solver. Each iteration:
 *  1. routes rainfall to open outlets, including internally closed depressions;
 *  2. accumulates contributing area in upstream-to-downstream topology;
 *  3. entrains sediment from slopes where power exceeds the incoming load;
 *  4. settles excess sediment and routes the remaining load downstream.
 *
 * Approximate E ~ K A^0.45 S^0.9 and transport capacity ~ Q^m S. Coefficients
 * are artistic, not time-calibrated: erosion duration represents relative
 * landscape evolution. No random particle trails or texture-space grooves.
 *
 * The source is never altered; all changes are recorded in height/wear/deposit.
 * Every exported sediment unit can be traced to an actual removal.
 */
export function watershedErosion(
  input: Float32Array,
  n: number,
  settings: ErosionSettings,
  mask?: Float32Array,
  progress?: (fraction: number) => void,
): ErosionResult {
  const count = n * n;
  if (!Number.isInteger(n) || n < 2 || input.length !== count ||
    (mask && mask.length !== count)) {
    throw new Error('Watershed erosion requires matching square field dimensions.');
  }
  const height = input.slice();
  const flow = new Float32Array(count);
  const wear = new Float32Array(count);
  const deposition = new Float32Array(count);
  const sediment = new Float32Array(count);
  let minimum = Infinity, maximum = -Infinity;
  for (const h of input) {
    if (!Number.isFinite(h)) throw new Error('Watershed erosion requires finite height values.');
    minimum = Math.min(minimum, h);
    maximum = Math.max(maximum, h);
  }
  if (mask) for (const m of mask)
    if (!Number.isFinite(m)) throw new Error('Watershed erosion mask must be finite.');

  const relief = Math.max(1e-5, maximum - minimum);
  const bedrock = minimum - relief * 0.025;
  const worldSize = Math.max(1, settings.worldSize ?? 8000);
  const heightScale = Math.max(1, settings.heightScale ?? 2400);
  const cell = worldSize / (n - 1);
  const erosion = clamp(settings.erosion);
  const depositionRate = clamp(settings.deposition);
  const gravity = Math.sqrt(clamp(settings.gravity, 0.01, 20) / 4);
  const rainfall = Math.sqrt(clamp(settings.droplets, 0, 500000) / 70000);
  const duration = clamp(settings.lifetime / 64, 0.125, 3.125);
  const channelWidth = clamp(settings.radius / 3, 0.3, 3);
  const capacityFactor = clamp(settings.capacity / 4, 0.025, 5);
  const iterations = settings.multiscale ? 3 : 2;
  const drainage = createDrainageWorkspace(n);
  let eroded = 0, deposited = 0, exportedSediment = 0;

  // Raster integration uses equal-area cells; each sample-height unit is the
  // same volume divided by the constant physical cell area.
  const takeAt = (center: number, amount: number, radius: number) => {
    if (amount <= 0) return 0;
    const x = center % n, y = Math.floor(center / n);
    let availableWeight = 0;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const px = x + dx, py = y + dy;
      if (px < 0 || py < 0 || px >= n || py >= n) continue;
      const i = py * n + px;
      if (height[i] <= bedrock) continue;
      const distance = Math.hypot(dx, dy);
      if (distance > radius + 0.1) continue;
      const weight = 1 / (1 + distance * distance * 1.6);
      availableWeight += weight * (mask ? clamp(mask[i]) : 1);
    }
    if (availableWeight <= 0) return 0;
    let actual = 0;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const px = x + dx, py = y + dy;
      if (px < 0 || py < 0 || px >= n || py >= n) continue;
      const i = py * n + px, distance = Math.hypot(dx, dy);
      if (distance > radius + 0.1) continue;
      const resistance = mask ? clamp(mask[i]) : 1;
      if (resistance <= 0) continue;
      const take = Math.min(Math.max(0, height[i] - bedrock),
        amount * resistance / ((1 + distance * distance * 1.6) * availableWeight));
      if (take <= 0) continue;
      const before = height[i];
      height[i] -= take;
      const moved = before - height[i];
      actual += moved;
      wear[i] += moved;
    }
    return actual;
  };

  // Spread depositional load into a short, low-slope fan; preserve the exact
  // removal/addition accounting even on a partially disabled material mask.
  const settleAt = (center: number, amount: number) => {
    if (amount <= 0) return 0;
    const x = center % n, y = Math.floor(center / n);
    let sum = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const px = x + dx, py = y + dy;
      if (px < 0 || py < 0 || px >= n || py >= n) continue;
      const i = py * n + px;
      sum += (mask ? clamp(mask[i]) : 1) / (1 + (dx * dx + dy * dy) * 1.4);
    }
    if (sum <= 0) return 0;
    let actual = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const px = x + dx, py = y + dy;
      if (px < 0 || py < 0 || px >= n || py >= n) continue;
      const i = py * n + px;
      const influence = (mask ? clamp(mask[i]) : 1);
      if (influence <= 0) continue;
      const before = height[i];
      height[i] += amount * influence / ((1 + (dx * dx + dy * dy) * 1.4) * sum);
      const moved = height[i] - before;
      deposition[i] += moved;
      actual += moved;
    }
    return actual;
  };

  if (erosion === 0 || rainfall === 0) {
    // Still compute the actual watershed flow for visualization and routing.
    routeDrainage(height, n, settings.seed, drainage);
    flow.set(accumulateDrainage(drainage, worldSize, settings.evaporation));
    progress?.(1);
    return { height, flow, wear, deposition, eroded, deposited, exportedSediment };
  }

  for (let iteration = 0; iteration < iterations; iteration++) {
    routeDrainage(height, n, settings.seed + iteration * 0x9e3779b1, drainage);
    accumulateDrainage(drainage, worldSize, settings.evaporation);
    flow.set(drainage.area);
    sediment.fill(0);
    const { area, receiver, spill, order } = drainage;
    const riverThreshold = settings.multiscale
      ? [0.00028, 0.00010, 0.000025][iteration]
      : 0.000055;
    const minimumCatchment = Math.max(2, count * riverThreshold);
    const passStrength = settings.multiscale
      ? [1.5, 1.0, 0.65][iteration] : 1.1;
    const passRadius = iteration === 0 && settings.multiscale ? 1.35 : 1;
    for (let k = count - 1; k >= 0; k--) {
      const i = order[k], downstream = receiver[i];
      let carried = sediment[i];
      if (downstream < 0) {
        // Open boundary exports the un-deposited sediment. Do not create
        // artificial piles along the edges of the tile.
        exportedSediment += carried;
        continue;
      }
      const dx = Math.abs(i % n - downstream % n);
      const dy = Math.abs(Math.floor(i / n) - Math.floor(downstream / n));
      const spacing = cell * (dx && dy ? Math.SQRT2 : 1);
      const rise = (height[i] - height[downstream]) * heightScale;
      const slope = Math.max(0, rise / spacing);
      const waterArea = Math.max(1, area[i]);
      const relativeArea = waterArea / count;
      const wetDepression = Math.max(0, spill[i] - height[i]) * heightScale;
      const power = Math.pow(relativeArea, 0.45) *
        Math.pow(Math.min(3, slope), 0.9) * rainfall * gravity;
      // Capacity grows with discharge as well as gradient; sediment cover
      // naturally suppresses incision while excess load is deposited.
      const capacity = relief * 0.13 * capacityFactor * rainfall *
        Math.pow(relativeArea, 0.32) *
        Math.pow(waterArea, 0.24) * Math.max(0.005, slope);
      const coverage = mask ? clamp(mask[i]) : 1;
      if (coverage > 0 && wetDepression < 0.2 * spacing &&
        waterArea >= minimumCatchment && slope > 0.002 && erosion > 0) {
        const requested = relief * 0.12 * erosion * duration * passStrength *
          power * Math.max(0, 1 - carried / Math.max(capacity, 1e-8));
        // Restrict each explicit step to a fraction of the actual downstream
        // head difference. Never create an inverse-gradient cut in one pass.
        const safe = Math.min(requested,
          Math.max(0, height[i] - height[downstream]) * 0.38, relief * 0.035);
        const contributingKm2 = waterArea * cell * cell / 1_000_000;
        const widthMeters = Math.min(85, 5 + 12 * contributingKm2 ** 0.35) *
          channelWidth * passRadius;
        const radius = Math.min(5, Math.max(0, Math.ceil(widthMeters / cell) - 1));
        const removed = takeAt(i, safe, radius);
        carried += removed;
        eroded += removed;
      }

      if (coverage > 0 && depositionRate > 0 && carried > 0) {
        const flooded = wetDepression > 0.01;
        const excess = Math.max(0, carried - (flooded ? 0 : capacity));
        const depositedHere = settleAt(i,
          Math.min(carried, excess * depositionRate * (flooded ? 1.6 : 1)));
        carried -= depositedHere;
        deposited += depositedHere;
      }
      sediment[downstream] += carried;
    }
    progress?.((iteration + 1) / iterations);
  }
  // The Float32 transport buffer can lose a few sub-ULP units across thousands
  // of downstream additions. Reconcile transported mass with actual, measured
  // height changes to keep the exported material budget correct.
  exportedSediment = Math.max(0, eroded - deposited);
  progress?.(1);
  return { height, flow, wear, deposition, eroded, deposited, exportedSediment };
}
