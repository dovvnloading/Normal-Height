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
  /**
   * Amount means the desired channel-center depth, NOT a fixed volume divided
   * among all bank cells. A normalized brush made wide rivers paradoxically
   * shallower and nearly invisible at preview resolution. The lateral kernel
   * is a tapered valley cross-section, and every actual removal contributes
   * to carried sediment rather than disappearing into a texture overlay.
   */
  const takeAt = (center: number, amount: number, radius: number) => {
    if (amount <= 0) return 0;
    const x = center % n, y = Math.floor(center / n);
    let actual = 0;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const px = x + dx, py = y + dy;
      if (px < 0 || py < 0 || px >= n || py >= n) continue;
      const dist = Math.hypot(dx, dy);
      if (dist > radius + 0.1) continue;
      const index = py * n + px;
      const permission = mask ? clamp(mask[index]) : 1;
      if (permission <= 0) continue;
      const before = height[index];
      const take = Math.min(Math.max(0, before - bedrock),
        amount * permission / (1 + dist * dist * 1.6));
      if (take <= 0) continue;
      height[index] -= take;
      const removed = before - height[index];
      actual += removed;
      wear[index] += removed;
    }
    return actual;
  };

  // Fractional bilinear sampling in grid coordinates, used only at active
  // channels to estimate cross-slope valley confinement. A uniformly tilted
  // plane has zero bank rise and cannot spontaneously acquire regularly
  // spaced, parallel erosion grooves from D8 raster routing alone.
  const elevationAt = (x: number, y: number) => {
    x = clamp(x, 0, n - 1);
    y = clamp(y, 0, n - 1);
    const ix = Math.min(n - 2, Math.floor(x));
    const iy = Math.min(n - 2, Math.floor(y));
    const fx = x - ix, fy = y - iy;
    const i = iy * n + ix;
    return height[i] * (1 - fx) * (1 - fy) +
      height[i + 1] * fx * (1 - fy) +
      height[i + n] * (1 - fx) * fy +
      height[i + n + 1] * fx * fy;
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
      const capacity = relief * 0.25 * capacityFactor * rainfall *
        Math.pow(relativeArea, 0.32) *
        Math.pow(waterArea, 0.24) * Math.max(0.005, slope);
      const coverage = mask ? clamp(mask[i]) : 1;
      if (coverage > 0 && wetDepression < 0.2 * spacing &&
        waterArea >= minimumCatchment && slope > 0.002 && erosion > 0) {
        // Prefer physically convergent valleys, not the parallel raster
        // drainage lines that exist even on an exactly tilted plane.
        const x = i % n, y = Math.floor(i / n);
        const norm = Math.hypot(dx, dy);
        const tx = -dy / norm, ty = dx / norm;
        const bankRadius = Math.min(6, Math.max(1.5, 90 / cell));
        const bankAX = x + tx * bankRadius, bankAY = y + ty * bankRadius;
        const bankBX = x - tx * bankRadius, bankBY = y - ty * bankRadius;
        // The gradient itself can be sampled with clamping, but a *valley
        // classifier* cannot: asymmetric clipping at an open boundary turns
        // even a perfect plane into a false concavity and creates parallel
        // scars across that boundary. Require both physical banks.
        const fullBanks = bankAX >= 0 && bankAX <= n - 1 &&
          bankBX >= 0 && bankBX <= n - 1 &&
          bankAY >= 0 && bankAY <= n - 1 &&
          bankBY >= 0 && bankBY <= n - 1;
        const across = fullBanks ? (
          elevationAt(bankAX, bankAY) +
          elevationAt(bankBX, bankBY)
        ) * 0.5 - height[i] : 0;
        const valley = clamp((across / relief - 0.0006) / 0.008);
        // Area alone is insufficient: finite-resolution D8 can converge even
        // on a mathematically planar surface. Insist on measured cross-bank
        // concavity; increasing catchment then strengthens an actual valley.
        const concentration = 0.35 + 0.65 * clamp(relativeArea / 0.008);
        const convergence = valley * valley * (3 - 2 * valley) * concentration;
        if (convergence > 0.001) {
          const requested = relief * 0.55 * erosion * duration * passStrength *
            power * convergence *
            Math.max(0, 1 - carried / Math.max(capacity, 1e-8));
          // Limit an explicit incision step relative to the existing head so
          // the river does not instantly reverse the downstream gradient.
          const safe = Math.min(requested,
            Math.max(0, height[i] - height[downstream]) * 0.78, relief * 0.06);
          const contributingKm2 = waterArea * cell * cell / 1_000_000;
          const valleyWidthMeters = Math.min(170,
            35 + 36 * contributingKm2 ** 0.32) * channelWidth * passRadius;
          const radius = Math.min(6,
            Math.max(1, Math.round(valleyWidthMeters / (2 * cell))));
          const removed = takeAt(i, safe, radius);
          carried += removed;
          eroded += removed;
        }
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
