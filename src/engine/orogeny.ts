import { clamp, Noise } from './noise';
import { createDrainageWorkspace, routeDrainage } from './hydrology';

/**
 * Orogenic source terrain built from uplift-controlled stream-power equilibrium.
 *
 * This is an independently implemented approximation of the terrain
 * construction approach described by Cordonnier et al. (2016) and the n=1
 * stream-power relation (Braun & Willett, 2013). We build an outlet-connected
 * stream graph and solve U = K A^m S across it, then blend this relief with the
 * artist's regional uplift shape. It is NOT a precipitation/sediment-fluid
 * solver; users can apply the separate Hydraulic erosion node afterward.
 *
 * Critically, the drainage graph uses jittered physical sampling coordinates
 * and distributes local runoff between earlier, strictly downhill neighbors.
 * This prevents the artificial cardinal/diagonal lines created by solely
 * imprinting D8 flow pixels onto a heightfield.
 */

export interface OrogenicRelief {
  height: Float32Array;
  /** Raw, non-negative contributing drainage area, at requested resolution. */
  drainage: Float32Array;
}

const DX = [-1, 0, 1, -1, 1, -1, 0, 1] as const;
const DY = [-1, -1, -1, 0, 0, 1, 1, 1] as const;

function sample(data: Float32Array, n: number, x: number, y: number): number {
  const ix = Math.min(n - 2, Math.max(0, Math.floor(x)));
  const iy = Math.min(n - 2, Math.max(0, Math.floor(y)));
  const fx = clamp(x - ix), fy = clamp(y - iy);
  const i = iy * n + ix;
  return data[i] * (1 - fx) * (1 - fy) +
    data[i + 1] * fx * (1 - fy) +
    data[i + n] * (1 - fx) * fy +
    data[i + n + 1] * fx * fy;
}

function resample(data: Float32Array, n: number, size: number): Float32Array {
  if (n === size) return data.slice();
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++)
    out[y * size + x] = sample(data, n, x * (n - 1) / (size - 1),
      y * (n - 1) / (size - 1));
  return out;
}

/** Separable sliding box filter; fixed memory and O(pixel count) per pass. */
function blurBox(values: Float32Array, n: number, radius: number): Float32Array {
  const r = Math.min(n - 1, Math.max(1, radius | 0));
  const temp = new Float32Array(n * n);
  const out = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    const offset = y * n;
    let total = 0;
    for (let x = 0; x <= r; x++) total += values[offset + x];
    for (let x = 0; x < n; x++) {
      if (x > 0) {
        if (x + r < n) total += values[offset + x + r];
        if (x - r - 1 >= 0) total -= values[offset + x - r - 1];
      }
      temp[offset + x] = total /
        (Math.min(n - 1, x + r) - Math.max(0, x - r) + 1);
    }
  }
  for (let x = 0; x < n; x++) {
    let total = 0;
    for (let y = 0; y <= r; y++) total += temp[y * n + x];
    for (let y = 0; y < n; y++) {
      if (y > 0) {
        if (y + r < n) total += temp[(y + r) * n + x];
        if (y - r - 1 >= 0) total -= temp[(y - r - 1) * n + x];
      }
      out[y * n + x] = total /
        (Math.min(n - 1, y + r) - Math.max(0, y - r) + 1);
    }
  }
  return out;
}

function blur(values: Float32Array, n: number, radius: number, passes: number) {
  let current = values;
  for (let pass = 0; pass < passes; pass++)
    current = blurBox(current, n, radius);
  return current;
}

/** Bounded streaming percentile histogram: no million-element JS array sort. */
function quantiles(
  values: Float32Array, lowFraction = 0.02, highFraction = 0.99,
): [number, number] {
  let low = Infinity, high = -Infinity;
  for (const value of values) {
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  const span = high - low;
  if (span < 1e-9) return [low, high];
  const counts = new Uint32Array(512);
  for (const value of values)
    counts[Math.min(511, Math.floor(clamp((value - low) / span) * 512))]++;
  const at = (fraction: number) => {
    const threshold = Math.max(1, Math.ceil(values.length * fraction));
    let running = 0;
    for (let i = 0; i < counts.length; i++) {
      running += counts[i];
      if (running >= threshold) return low + span * ((i + 0.5) / 512);
    }
    return high;
  };
  return [at(lowFraction), at(highFraction)];
}

/**
 * Returns a real elevation field and the independently computed drainage area.
 * The original source samples remain unchanged. A perfectly flat input cannot
 * invent mountains or drainage features.
 *
 * We simulate no more than 1024² graph nodes to preserve the existing worker's
 * memory budget. Higher-resolution outputs retain native source frequencies
 * and receive a bilinearly mapped physically computed elevation *delta*.
 */
export function generateOrogenicRelief(
  input: Float32Array,
  n: number,
  seed: number,
  dissection = 0.82,
): OrogenicRelief {
  if (!Number.isInteger(n) || n < 2 || n > 2048 || input.length !== n * n)
    throw new Error('Orogenic relief requires a 2–2048 square heightfield.');
  let minimum = Infinity, maximum = -Infinity;
  for (const value of input) {
    if (!Number.isFinite(value))
      throw new Error('Orogenic relief requires finite input elevations.');
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  const blend = clamp(dissection);
  const emptyDrainage = () => new Float32Array(n * n);
  if (maximum - minimum < 1e-7 || blend === 0)
    return { height: input.slice(), drainage: emptyDrainage() };

  const m = Math.min(n, 1024), total = m * m;
  const source = resample(input, n, m);
  let sourceMin = Infinity, sourceMax = -Infinity;
  for (const value of source) {
    sourceMin = Math.min(sourceMin, value);
    sourceMax = Math.max(sourceMax, value);
  }
  const range = Math.max(1e-7, sourceMax - sourceMin);
  const noise = new Noise(seed >>> 0);
  const routeSurface = blur(source, m, Math.max(1, Math.round(m / 256)), 2);
  const regionalUplift = blur(source, m, Math.max(2, Math.round(m * 0.013)), 3);
  const jitterX = new Float32Array(total), jitterY = new Float32Array(total);
  for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
    const i = y * m + x;
    if (x === 0 || y === 0 || x === m - 1 || y === m - 1) continue;
    jitterX[i] = noise.simplex(x * 0.32 + 33.1, y * 0.32 - 15.6) * 0.34;
    jitterY[i] = noise.simplex(x * 0.32 - 8.7, y * 0.32 + 41.3) * 0.34;
    // Sub-resolution lithological variations seed headwater locations;
    // the final height receives no copied noise or stamped river texture.
    routeSurface[i] += range * 0.003 *
      noise.simplex(x * 0.16 + 13.9, y * 0.16 - 29.7);
  }

  const routes = routeDrainage(routeSurface, m, seed >>> 0,
    createDrainageWorkspace(m));
  const { order, rank, receiver } = routes;
  // Eight candidate slots per node represent its strictly downhill neighbors.
  // Unlike a D8 raster, runoff is split between directions based on slope,
  // allowing smooth angular branching before stream power is evaluated.
  const downstream = new Int32Array(total * 8);
  const weights = new Float32Array(total * 8);
  downstream.fill(-1);
  for (let k = 0; k < total; k++) {
    const i = order[k];
    if (receiver[i] < 0) continue;
    const x = i % m, y = Math.floor(i / m);
    let weightSum = 0;
    for (let d = 0; d < 8; d++) {
      const xx = x + DX[d], yy = y + DY[d];
      if (xx < 0 || yy < 0 || xx >= m || yy >= m) continue;
      const j = yy * m + xx;
      if (rank[j] >= rank[i]) continue;
      const fall = routeSurface[i] - routeSurface[j];
      if (fall <= 1e-9) continue;
      const dx = x + jitterX[i] - xx - jitterX[j];
      const dy = y + jitterY[i] - yy - jitterY[j];
      const physicalDistance = Math.max(0.25, Math.hypot(dx, dy));
      const w = Math.pow(fall / physicalDistance, 3.5);
      downstream[i * 8 + d] = j;
      weights[i * 8 + d] = w;
      weightSum += w;
    }
    if (weightSum <= 0) {
      downstream[i * 8] = receiver[i];
      weights[i * 8] = 1;
    } else for (let d = 0; d < 8; d++) weights[i * 8 + d] /= weightSum;
  }
  const area = new Float32Array(total).fill(1);
  for (let k = total - 1; k >= 0; k--) {
    const i = order[k], offset = i * 8;
    for (let d = 0; d < 8; d++) {
      const j = downstream[offset + d];
      if (j >= 0) area[j] += area[i] * weights[offset + d];
    }
  }

  // Steady-state stream-power equation: U = K A^m S, for slope exponent n=1.
  // Integrating from the open outlets upstream creates coherent drainage
  // gradients and leaves sharp interfluves between convergent tributaries.
  // Relative uplift varies smoothly with the regional mountain envelope.
  const elevation = new Float32Array(total);
  const gain = range * 0.015 * 512 / m;
  for (let k = 0; k < total; k++) {
    const i = order[k], offset = i * 8;
    const x = i % m, y = Math.floor(i / m);
    let downstreamElevation = 0, distance = 0, connections = 0;
    for (let d = 0; d < 8; d++) {
      const j = downstream[offset + d];
      if (j < 0) continue;
      const w = weights[offset + d];
      const xx = j % m, yy = Math.floor(j / m);
      const dx = x + jitterX[i] - xx - jitterX[j];
      const dy = y + jitterY[i] - yy - jitterY[j];
      downstreamElevation += w * elevation[j];
      distance += w * Math.hypot(dx, dy);
      connections++;
    }
    if (!connections) {
      elevation[i] = source[i] * 0.8;
      continue;
    }
    const edge = Math.min(x, y, m - 1 - x, m - 1 - y);
    const edgeEnvelope = clamp(edge / (m * 0.1));
    const uplift = (0.10 + 0.90 * clamp(
      (regionalUplift[i] - sourceMin - range * 0.1) / (range * 0.85)
    )) * edgeEnvelope;
    elevation[i] = downstreamElevation +
      gain * uplift * distance / Math.sqrt(Math.max(1, area[i]));
  }

  // Reproject the irregular river graph onto the regular elevation grid.
  // A small blur removes sampling artifacts without inventing height detail.
  const reprojection = new Float32Array(total);
  for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
    const i = y * m + x;
    reprojection[i] = sample(elevation, m, x - jitterX[i], y - jitterY[i]);
  }
  const softRelief = blur(reprojection, m, 1, 1);
  const [steadyLow, steadyHigh] = quantiles(softRelief);
  const [sourceLow, sourceHigh] = quantiles(source);
  const steadyRange = Math.max(1e-8, steadyHigh - steadyLow);
  const sourceRange = Math.max(1e-8, sourceHigh - sourceLow);
  const delta = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const normalized = clamp(
      sourceLow + ((softRelief[i] - steadyLow) / steadyRange) *
        sourceRange, sourceMin - range * 0.08, sourceMax + range * 0.08,
    );
    delta[i] = (normalized - source[i]) * blend;
  }

  const height = input.slice();
  const drainage = new Float32Array(n * n);
  if (m === n) {
    for (let i = 0; i < total; i++) {
      height[i] += delta[i];
      drainage[i] = area[i];
    }
  } else for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x;
    const sx = x * (m - 1) / (n - 1);
    const sy = y * (m - 1) / (n - 1);
    height[i] += sample(delta, m, sx, sy);
    // Discharge scales with actual terrain sample area.
    drainage[i] = sample(area, m, sx, sy) * (n / m) ** 2;
  }
  return { height, drainage };
}
