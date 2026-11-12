import { Noise } from './noise';
import { createDrainageWorkspace, routeDrainage } from './hydrology';

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (a: number, b: number, value: number) => {
  const x = clamp((value - a) / Math.max(1e-8, b - a));
  return x * x * (3 - 2 * x);
};

function bilinear(values: Float32Array, n: number, x: number, y: number): number {
  const sx = clamp(x, 0, n - 1), sy = clamp(y, 0, n - 1);
  const ix = Math.min(n - 2, Math.floor(sx)), iy = Math.min(n - 2, Math.floor(sy));
  const fx = sx - ix, fy = sy - iy, i = iy * n + ix;
  return values[i] * (1 - fx) * (1 - fy) +
    values[i + 1] * fx * (1 - fy) +
    values[i + n] * (1 - fx) * fy +
    values[i + n + 1] * fx * fy;
}

function resample(values: Float32Array, n: number, m: number): Float32Array {
  if (n === m) return values.slice();
  const out = new Float32Array(m * m);
  for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
    out[y * m + x] = bilinear(values, n,
      x * (n - 1) / (m - 1), y * (n - 1) / (m - 1));
  }
  return out;
}

/** Two-pass separable box filtering, with a proper edge normalization. */
function smoothUplift(data: Float32Array, n: number, radius: number): Float32Array {
  const r = Math.max(1, radius | 0);
  const temp = new Float32Array(n * n), output = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    const row = y * n;
    let sum = 0;
    for (let x = 0; x <= r; x++) sum += data[row + x];
    for (let x = 0; x < n; x++) {
      if (x > 0) {
        if (x + r < n) sum += data[row + x + r];
        if (x - r - 1 >= 0) sum -= data[row + x - r - 1];
      }
      temp[row + x] = sum / (Math.min(n - 1, x + r) - Math.max(0, x - r) + 1);
    }
  }
  for (let x = 0; x < n; x++) {
    let sum = 0;
    for (let y = 0; y <= r; y++) sum += temp[y * n + x];
    for (let y = 0; y < n; y++) {
      if (y > 0) {
        if (y + r < n) sum += temp[(y + r) * n + x];
        if (y - r - 1 >= 0) sum -= temp[(y - r - 1) * n + x];
      }
      output[y * n + x] = sum /
        (Math.min(n - 1, y + r) - Math.max(0, y - r) + 1);
    }
  }
  return output;
}

export interface IncisedSource {
  height: Float32Array;
  /** Contributing rainfall area in raster-cell equivalents. */
  drainage: Float32Array;
  /** Maximum actual removal (normalized elevation) from each cell. */
  incision: Float32Array;
  /** Single downstream connection per cell, -1 at open boundary outlets. */
  receiver: Int32Array;
}

/**
 * Construct a coherent *valley* network rather than treating cumulative runoff
 * as an elevated terrain surface. The outlet-connected river tree is computed
 * on a routing-only relief with scale-correct, seeded geology heterogeneity.
 * Its connected segments are rasterized as narrow riverbeds and wider tapered
 * valley sides. Both are NEGATIVE elevation changes, never raised streams.
 *
 * The network's catchment areas determine channel width and depth; untouched
 * source locations retain their actual native relief. The field is evaluated
 * at <=1024 samples to bound CPU + memory; larger heightfield exports get the
 * physically evaluated delta resampled onto their original source resolution.
 *
 * This is a procedural feature-kernel reconstruction along a hydrological
 * graph (Génevaux et al. 2013; Cordonnier et al. 2016), NOT a water-fluid or
 * bedrock erosion physics simulator. The separate hydraulic node handles
 * transport and hillslope weathering after the source has been constructed.
 */
export function carveConnectedValleys(
  input: Float32Array,
  n: number,
  seed: number,
  strength: number,
): IncisedSource {
  if (!Number.isInteger(n) || n < 2 || n > 2048 || input.length !== n * n)
    throw new Error('Orogenic source requires aligned 2–2048 square elevation data.');
  let low = Infinity, high = -Infinity;
  for (const value of input) {
    if (!Number.isFinite(value)) throw new Error('Orogenic source needs finite elevations.');
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  const blend = clamp(strength);
  const result = input.slice();
  if (high - low < 1e-7 || blend === 0) return {
    height: result, drainage: new Float32Array(n * n),
    incision: new Float32Array(n * n), receiver: new Int32Array(n * n).fill(-1),
  };

  const m = Math.min(1024, n), count = m * m, span = high - low;
  const source = resample(input, n, m);
  const noise = new Noise((seed ^ 0x6c822ac5) >>> 0);
  const route = smoothUplift(source, m, Math.max(1, Math.round(m / 256)));
  const jitterX = new Float32Array(count), jitterY = new Float32Array(count);

  // Erodibility structure affects ONLY runoff routing. It does not create
  // fake gray noise in the delivered heightfield. Multiple smooth physical
  // scales break the parallel D8 banding of an unperturbed planar source.
  for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
    const i = y * m + x;
    const normalizedX = x / m, normalizedY = y / m;
    const heterogeneity =
      0.028 * noise.simplex(normalizedX * 8 + 14.7, normalizedY * 8 - 9.1) +
      0.018 * noise.simplex(normalizedX * 20 - 37.1, normalizedY * 20 + 5.4) +
      0.007 * noise.simplex(normalizedX * 50 + 19.4, normalizedY * 50 + 13.7) +
      0.004 * noise.simplex(normalizedX * 100 - 8.6, normalizedY * 100 - 31.4);
    route[i] += span * heterogeneity;
    if (x > 0 && y > 0 && x < m - 1 && y < m - 1) {
      jitterX[i] = 0.28 *
        noise.simplex(x * 0.32 + 33.1, y * 0.32 - 15.6);
      jitterY[i] = 0.28 *
        noise.simplex(x * 0.32 - 8.7, y * 0.32 + 41.3);
    }
  }

  const graph = routeDrainage(route, m, seed, createDrainageWorkspace(m));
  const { order, receiver } = graph;
  const area = new Float32Array(count).fill(1);
  for (let k = count - 1; k >= 0; k--) {
    const i = order[k], downstream = receiver[i];
    if (downstream >= 0) area[downstream] += area[i];
  }

  // For fixed tile width, equal physical catchments have equal feature size
  // when working resolution changes. 384 serves as the calibration grid for
  // the reference comparison, not a baked-in pixel dimension.
  const scale = m / 384;
  const minimumArea = Math.max(2, 5 * scale * scale);
  const cut = new Float32Array(count);
  const riverBed = (a: number) => {
    const order = Math.log2(a / minimumArea + 1);
    return {
      narrowDepth: span * Math.min(0.41, 0.034 + 0.058 * order),
      narrowWidth: Math.min(4.5 * scale,
        (0.28 + 0.12 * order) * scale),
      wideDepth: span * Math.min(0.15,
        Math.max(0, Math.log2(a / Math.max(1, 80 * scale * scale)) + 1) * 0.022),
      wideWidth: Math.min(18 * scale,
        (1.2 + 0.65 * Math.max(0,
          Math.log2(a / Math.max(1, 80 * scale * scale)) + 1)) * scale),
    };
  };

  // Rasterize the centerline AND the segment to its downstream receiver, so
  // connected tributaries cannot dissolve into isolated pixel stamps.
  // A max-cut compositing rule prevents overlapping passes from creating
  // sinkholes or accumulating an arbitrarily deep gorge.
  for (let i = 0; i < count; i++) {
    const a = area[i], parent = receiver[i];
    if (parent < 0 || a < minimumArea) continue;
    const x = i % m, y = (i / m) | 0;
    const px = parent % m, py = (parent / m) | 0;
    const elevation = (source[i] - low) / span;
    const allowed = smooth(0.04, 0.31, elevation);
    if (allowed < 0.001) continue;
    const edgeDistance = Math.min(x, y, m - 1 - x, m - 1 - y);
    const edgeFade = smooth(0, 2.4 * scale, edgeDistance);
    const { narrowDepth, narrowWidth, wideDepth, wideWidth } = riverBed(a);
    const depth = narrowDepth * allowed * edgeFade;
    const broad = wideDepth * allowed * edgeFade;
    if (depth <= 1e-8) continue;
    const ax = x + jitterX[i], ay = y + jitterY[i];
    const bx = px + jitterX[parent], by = py + jitterY[parent];
    const ddx = bx - ax, ddy = by - ay;
    const denom = ddx * ddx + ddy * ddy + 1e-8;
    const extent = Math.max(narrowWidth, wideWidth) * 2.8;
    const xmin = Math.max(0, Math.floor(Math.min(ax, bx) - extent));
    const xmax = Math.min(m - 1, Math.ceil(Math.max(ax, bx) + extent));
    const ymin = Math.max(0, Math.floor(Math.min(ay, by) - extent));
    const ymax = Math.min(m - 1, Math.ceil(Math.max(ay, by) + extent));
    for (let yy = ymin; yy <= ymax; yy++) for (let xx = xmin; xx <= xmax; xx++) {
      const t = clamp(((xx - ax) * ddx + (yy - ay) * ddy) / denom);
      const distance = Math.hypot(xx - ax - t * ddx, yy - ay - t * ddy);
      const narrow = depth * Math.exp(
        -0.5 * Math.pow(distance / Math.max(0.15, narrowWidth), 1.3));
      const wide = broad * Math.exp(
        -0.5 * Math.pow(distance / Math.max(0.25, wideWidth), 2));
      const contribution = Math.max(narrow, wide);
      const at = yy * m + xx;
      if (contribution > cut[at]) cut[at] = contribution;
    }
  }

  const incision = new Float32Array(n * n);
  const drainage = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x;
    const u = x * (m - 1) / Math.max(1, n - 1);
    const v = y * (m - 1) / Math.max(1, n - 1);
    const removed = bilinear(cut, m, u, v) * blend;
    result[i] -= removed;
    incision[i] = removed;
    drainage[i] = bilinear(area, m, u, v) * (n / m) ** 2;
  }

  // Receiver indices remain defined on the working grid. Expose an aligned
  // receiver field for the working-resolution diagnostics only; callers
  // needing native 2K flow paths should explicitly request their own routing.
  return { height: result, drainage, incision,
    receiver: n === m ? receiver : new Int32Array(n * n).fill(-1) };
}
