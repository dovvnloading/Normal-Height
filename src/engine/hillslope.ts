/**
 * Conservative four-neighbour hillslope motion of a layered heightfield.
 *
 * Transfers are proposed from the same frozen surface, then scaled by each
 * donor's supply before any elevation changes occur. This prevents scan
 * direction bias, respects protected bedrock, and avoids creating sediment
 * by borrowing more mobile material than is available.
 *
 * Units are normalized height per cell. Physical repose thresholds are
 * provided by callers after converting cell spacing and height scale.
 */
export interface HillslopeWorkspace {
  east: Float64Array;
  south: Float64Array;
  demand: Float64Array;
  fraction: Float64Array;
  change: Float64Array;
}

export function createHillslopeWorkspace(length: number): HillslopeWorkspace {
  return {
    east: new Float64Array(length),
    south: new Float64Array(length),
    demand: new Float64Array(length),
    fraction: new Float64Array(length),
    change: new Float64Array(length),
  };
}

export function relaxLayeredHillslope(
  height: Float32Array,
  mobile: Float32Array,
  bedrock: Float32Array,
  n: number,
  talusHeight: number,
  rate: number,
  bedrockErodibility: number,
  floor: number,
  mask: Float32Array | null | undefined,
  work: HillslopeWorkspace,
): void {
  if (!(rate > 0) || n < 2) return;
  const length = n * n;
  const { east, south, demand, fraction, change } = work;
  if (
    height.length !== length || mobile.length !== length ||
    bedrock.length !== length || (mask && mask.length !== length) ||
    east.length !== length || south.length !== length ||
    demand.length !== length || fraction.length !== length ||
    change.length !== length
  ) throw new Error('Hillslope relaxation requires aligned height, material, and workspace arrays.');
  east.fill(0);
  south.fill(0);
  demand.fill(0);
  change.fill(0);
  // An explicit four-neighbour relaxation must remain below the diffusion
  // stability limit even at maximum artistic duration and hillslope strength.
  const stableRate = Math.min(0.18, rate);

  // Propose the same signed pairwise transfers as a simultaneous talus pass.
  // The sign is positive when material goes from this cell to the neighbour.
  const propose = (i: number, j: number): number => {
    const difference = height[i] - height[j];
    const excess = Math.max(0, Math.abs(difference) - talusHeight);
    if (!excess) return 0;
    const permission = mask
      ? Math.min(Math.max(0, Math.min(1, mask[i])),
          Math.max(0, Math.min(1, mask[j]))) : 1;
    const transfer = Math.sign(difference) * excess * stableRate * permission;
    if (transfer) demand[transfer > 0 ? i : j] += Math.abs(transfer);
    return transfer;
  };
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x;
    if (x + 1 < n) east[i] = propose(i, i + 1);
    if (y + 1 < n) south[i] = propose(i, i + n);
  }

  // Restrict each donor's TOTAL outgoing material, not individual edges.
  // This preserves four-way symmetry without overdrawing a thin soil layer.
  const rockRate = Math.min(1, Math.max(0, bedrockErodibility));
  for (let i = 0; i < length; i++) {
    const requested = demand[i];
    if (requested <= 0) {
      fraction[i] = 0;
      continue;
    }
    const loose = Math.min(requested, Math.max(0, mobile[i]));
    const rock = Math.min(
      (requested - loose) * rockRate,
      Math.max(0, bedrock[i] - floor),
    );
    fraction[i] = (loose + rock) / requested;
  }

  // Apply the scaled pair fluxes together. All transferred material becomes
  // mobile sediment at the receiver; only the excess over donor soil supply
  // is weathered from bedrock.
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x;
    if (x + 1 < n && east[i]) {
      const signed = east[i] * fraction[east[i] > 0 ? i : i + 1];
      change[i] -= signed;
      change[i + 1] += signed;
    }
    if (y + 1 < n && south[i]) {
      const signed = south[i] * fraction[south[i] > 0 ? i : i + n];
      change[i] -= signed;
      change[i + n] += signed;
    }
  }
  for (let i = 0; i < length; i++) {
    const delta = change[i];
    if (delta === 0) continue;
    if (delta < 0) {
      const lost = -delta;
      const loose = Math.min(Math.max(0, mobile[i]), lost);
      mobile[i] -= loose;
      bedrock[i] -= lost - loose;
    } else {
      mobile[i] += delta;
    }
    height[i] = bedrock[i] + mobile[i];
  }
}
