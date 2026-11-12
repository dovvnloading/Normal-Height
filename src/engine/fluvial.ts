import { Noise } from './noise';
import { accumulateDrainage, createDrainageWorkspace, routeDrainage } from './hydrology';

/**
 * Fluvial landscape formation: tectonic uplift balanced by stream-power
 * incision, solved to steady state on a self-consistent drainage network.
 *
 * Along every flow path the detachment-limited stream-power law
 * dz/dt = U − K·A^m·S has the steady state S = U / (K·A^m) (slope exponent
 * n = 1). Given receivers and contributing area, the elevation follows by
 * integrating that slope upstream from the outlets:
 *
 *   z_i = z_receiver + U_i · d_i / (K_i · A_i^m)
 *
 * The drainage network is then rerouted on the new surface and the
 * integration repeated until network and surface agree. This is the steady
 * state that implicit time stepping (Braun & Willett 2013, "FastScape")
 * converges to, reached in a handful of routing passes instead of hundreds of
 * time steps. Erosion therefore *forms* the relief: every interfluve is a
 * drainage divide, valleys deepen downstream, and dissection continues down
 * to the raster scale, as in real fluvially eroded uplands.
 *
 * The artist's input is the uplift pattern and large-scale shape: the uplift
 * rate follows the input envelope and the erodibility K is least-squares
 * fitted so the evolved surface tracks it. Resolution levels run coarse to
 * fine so trunk rivers organise at large scale and tributaries emerge at each
 * finer scale. Seeded lithology varies erodibility smoothly (hard uplands,
 * soft basins) and the channel-initiation area (drainage density);
 * low-amplitude heterogeneity in uplift breaks raster symmetry. Random-D8
 * receivers keep valleys off the eight raster directions.
 *
 * Three geomorphic finishing steps follow: accordant upland summits of a
 * surface still being dissected, crest-only reduction of local relief (so
 * channels read as incisions into smoother slopes), and planed floodplains
 * whose width grows with discharge.
 *
 * Units are dimensionless (tile width = 1, elevation = input range); area
 * is a fraction of the tile so the law is consistent across resolutions.
 */
export interface FluvialOptions {
  /** 0 returns the input unchanged; 1 is the fully formed landscape. */
  strength: number;
  seed: number;
  /** Area exponent m (channel concavity); real rivers 0.35–0.6. */
  concavity?: number;
  /** Erodibility and drainage-density contrast between rock types, 0–1. */
  lithology?: number;
  /** Small-scale uplift/rock heterogeneity, 0–1. */
  heterogeneity?: number;
  /** Hillslope diffusion that rounds raster-scale crests, 0–1. */
  ridgeSoftening?: number;
  /** Channel-initiation catchment, in output-resolution cells. */
  channelCells?: number;
  /** Width of planed valley floors along larger rivers, 0–1. */
  floodplain?: number;
  /** Accordant upland summits of a still-dissecting uplifted surface, 0–1. */
  accordance?: number;
  /** Regional variation of drainage density, 0–1 (defaults to lithology). */
  drainageVariation?: number;
  /** Height of interfluve crests relative to the full steady state, 0.2–1. */
  dissectionDepth?: number;
}

/** Defaults shared by the engine and the node registry. */
export const FLUVIAL_DEFAULTS = {
  concavity: 0.56,
  lithology: 0.75,
  floodplain: 0.85,
  accordance: 0.8,
  dissectionDepth: 0.5,
} as const;

const NX = [-1, 0, 1, -1, 1, -1, 0, 1] as const;
const NY = [-1, -1, -1, 0, 0, 1, 1, 1] as const;
const INV_DIST = [Math.SQRT1_2, 1, Math.SQRT1_2, 1, 1, Math.SQRT1_2, 1, Math.SQRT1_2] as const;

export interface FluvialResult {
  height: Float32Array;
  /** Contributing area in cells at the output resolution. */
  drainage: Float32Array;
}

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));

/** Deterministic per-cell white noise in [-0.5, 0.5). */
function cellHash(index: number, salt: number): number {
  let v = Math.imul(index ^ salt, 0x9e3779b1);
  v = Math.imul(v ^ (v >>> 15), 0x85ebca6b);
  v = Math.imul(v ^ (v >>> 13), 0xc2b2ae35);
  return ((v ^ (v >>> 16)) >>> 0) / 4294967296 - 0.5;
}

function bilinear(values: ArrayLike<number>, n: number, x: number, y: number): number {
  const sx = clamp(x, 0, n - 1), sy = clamp(y, 0, n - 1);
  const ix = Math.min(n - 2, Math.floor(sx)), iy = Math.min(n - 2, Math.floor(sy));
  const fx = sx - ix, fy = sy - iy, i = iy * n + ix;
  return values[i] * (1 - fx) * (1 - fy) +
    values[i + 1] * fx * (1 - fy) +
    values[i + n] * (1 - fx) * fy +
    values[i + n + 1] * fx * fy;
}

function resample(values: ArrayLike<number>, n: number, m: number): Float64Array {
  const out = new Float64Array(m * m);
  if (n === m) {
    for (let i = 0; i < out.length; i++) out[i] = values[i];
    return out;
  }
  for (let y = 0; y < m; y++) for (let x = 0; x < m; x++)
    out[y * m + x] = bilinear(values, n, (x * (n - 1)) / (m - 1), (y * (n - 1)) / (m - 1));
  return out;
}

/** Largest grid the solver forms directly (bounded time and memory). */
export const FLUVIAL_MAX_RESOLUTION = 1024;

/** Resolution levels, coarse to fine; trunk drainage forms on the first. */
export function fluvialLevels(n: number): number[] {
  const levels: number[] = [];
  let m = n;
  while (m > 160) {
    levels.unshift(m);
    m = Math.ceil(m / 2);
  }
  levels.unshift(m);
  return levels;
}

export function evolveFluvialLandscape(
  source: Float32Array,
  n: number,
  options: FluvialOptions,
): FluvialResult {
  if (!Number.isInteger(n) || n < 2 || n > 2048 || source.length !== n * n)
    throw new Error('Fluvial formation requires aligned 2–2048 square elevation data.');
  let low = Infinity, high = -Infinity;
  for (const value of source) {
    if (!Number.isFinite(value)) throw new Error('Fluvial formation needs finite elevations.');
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  const strength = clamp(options.strength);
  if (strength === 0 || high - low < 1e-7)
    return { height: source.slice(), drainage: new Float32Array(n * n) };

  const span = high - low;
  const m = clamp(options.concavity ?? FLUVIAL_DEFAULTS.concavity, 0.2, 0.8);
  const lithology = clamp(options.lithology ?? FLUVIAL_DEFAULTS.lithology);
  const heterogeneity = clamp(options.heterogeneity ?? 0.5);
  const softening = clamp(options.ridgeSoftening ?? 0.3);
  // Channels begin above ~18 cells of catchment at the output resolution,
  // varying with rock and soil: dense gullies in some regions, smooth
  // hillslopes cut only by larger channels in others.
  const channelArea = clamp(options.channelCells ?? 18, 1, 400) / ((n - 1) * (n - 1));
  const densityVariation = 1.5 * clamp(options.drainageVariation ?? lithology);
  const envelope = new Float64Array(n * n);
  for (let i = 0; i < envelope.length; i++) envelope[i] = (source[i] - low) / span;
  const noise = new Noise((options.seed ^ 0x2f6b1d3a) >>> 0);

  let z: Float64Array | null = null;
  let previous = 0;
  let drainage = new Float32Array(0);
  for (const level of fluvialLevels(n)) {
    const count = level * level;
    const target = resample(envelope, n, level);
    z = z ? resample(z, previous, level) : target.slice();
    previous = level;
    const dx = 1 / (level - 1);
    const cellArea = dx * dx;

    // Uplift follows the envelope, never vanishing, so lowlands are still
    // dissected (gently). Rock and soil fields are smooth and tile-relative,
    // identical at every level; heterogeneity octaves stop above the raster.
    const uplift = new Float64Array(count);
    const erodibility = new Float64Array(count);
    const initiation = new Float64Array(count);
    for (let y = 0; y < level; y++) for (let x = 0; x < level; x++) {
      const i = y * level + x;
      const u = x / (level - 1), v = y / (level - 1);
      const rock = 0.65 * noise.simplex(u * 2.3 + 7.1, v * 2.3 - 3.7) +
        0.35 * noise.simplex(u * 5.1 - 11.3, v * 5.1 + 2.9);
      erodibility[i] = Math.exp(lithology * 1.6 * rock);
      const soil = 0.6 * noise.simplex(u * 3.1 - 23.9, v * 3.1 + 41.3) +
        0.4 * noise.simplex(u * 7.3 + 5.5, v * 7.3 - 19.1);
      initiation[i] = channelArea * Math.exp(densityVariation * soil);
      let detail = 0, weight = 0.5;
      // Stop well above the raster scale: per-cell uplift noise would
      // incise every pixel into its own groove.
      for (let f = 6; f < level / 6; f *= 2.1) {
        detail += weight * noise.simplex(u * f + 31.7 * weight, v * f - 17.3 * weight);
        weight *= 0.62;
      }
      uplift[i] = (0.12 + 0.88 * target[i]) * Math.max(0.2, 1 + heterogeneity * 0.55 * detail);
    }

    const workspace = createDrainageWorkspace(level);
    const routed = new Float32Array(count);
    const integral = new Float64Array(count);
    const base = new Float64Array(count);
    const iterations = level <= 160 ? 14 : level <= 320 ? 7 : level <= 640 ? 5 : 4;
    for (let pass = 0; pass < iterations; pass++) {
      // The first pass on an upsampled surface breaks its planar facets with
      // a raster-scale jitter so new tributaries are not parallel D8 lines.
      for (let i = 0; i < count; i++)
        routed[i] = z[i] + (pass === 0 ? 0.35 * dx * cellHash(i, options.seed ^ level) : 0);
      routeDrainage(routed, level, options.seed + level, workspace);
      const { order, receiver, rank } = workspace;
      // Random-D8: drain to a downhill neighbor chosen with probability
      // proportional to slope^1.4 instead of always the steepest one. Only
      // earlier-ranked neighbors qualify, so the network stays acyclic.
      // Steepest-only routing straightens valleys onto the eight raster
      // directions; this restores the irregular courses of real channels.
      const salt = (options.seed ^ Math.imul(level, 0x45d9f3b) ^ Math.imul(pass + 1, 0x27d4eb2d)) >>> 0;
      for (let y = 1; y < level - 1; y++) for (let x = 1; x < level - 1; x++) {
        const i = y * level + x;
        let total = 0;
        for (let d = 0; d < 8; d++) {
          const j = (y + NY[d]) * level + x + NX[d];
          const drop = routed[i] - routed[j];
          if (rank[j] < rank[i] && drop > 0) total += Math.pow(drop * INV_DIST[d], 1.4);
        }
        if (total <= 0) continue;
        let pick = (cellHash(i, salt) + 0.5) * total;
        for (let d = 0; d < 8; d++) {
          const j = (y + NY[d]) * level + x + NX[d];
          const drop = routed[i] - routed[j];
          if (rank[j] >= rank[i] || drop <= 0) continue;
          pick -= Math.pow(drop * INV_DIST[d], 1.4);
          if (pick <= 0) { receiver[i] = j; break; }
        }
      }
      const area = accumulateDrainage(workspace, 1, 0);
      let num = 0, den = 0;
      for (let k = 0; k < count; k++) {
        const cell = order[k];
        const parent = receiver[cell];
        if (parent < 0) {
          integral[cell] = 0;
          base[cell] = z[cell];
          continue;
        }
        const diagonal = (cell % level) !== (parent % level) &&
          ((cell / level) | 0) !== ((parent / level) | 0);
        const distance = diagonal ? dx * Math.SQRT2 : dx;
        // Channels: S = U / (K·A^m), flattening downstream (concave). Below
        // the channel-initiation area, slopes are unchannelled hillslopes
        // whose steepness stops growing as catchments shrink, so facets stay
        // planar instead of every raster cell cutting its own groove.
        const a = Math.max(area[cell] * cellArea, initiation[cell]);
        integral[cell] = integral[parent] +
          uplift[cell] * distance / (erodibility[cell] * Math.pow(a, m));
        base[cell] = base[parent];
        const rise = target[cell] - base[cell];
        num += integral[cell] * rise;
        den += integral[cell] * integral[cell];
      }
      // Least-squares 1/K so the formed surface tracks the envelope.
      const inverseK = den > 0 && num > 0 ? num / den : 1;
      const step = pass === iterations - 1 ? 1 : 0.65;
      for (let i = 0; i < count; i++) {
        if (receiver[i] < 0) continue;
        z[i] += step * (base[i] + integral[i] * inverseK - z[i]);
      }
      if (level === n) drainage = Float32Array.from(area);
    }

    // Light hillslope diffusion, strongest on unchannelled crest cells.
    if (softening > 0 && level === n) {
      const area = drainage;
      const next = new Float64Array(z);
      for (let round = 0; round < 2; round++) {
        for (let y = 1; y < level - 1; y++) for (let x = 1; x < level - 1; x++) {
          const i = y * level + x;
          const w = softening * 0.5 * Math.exp(-(area[i] - 1) / 6);
          if (w <= 0.001) continue;
          const mean = (z[i - 1] + z[i + 1] + z[i - level] + z[i + level]) * 0.25;
          next[i] = z[i] + w * (mean - z[i]);
        }
        z.set(next);
      }
    }
  }

  const accordance = clamp(options.accordance ?? FLUVIAL_DEFAULTS.accordance);
  if (accordance > 0) accordUplands(z!, n, accordance);
  // Interfluve height: real uplands carry their large-scale relief from
  // tectonics and rock contrast, with fluvial dissection superimposed. A
  // pure steady state has the same relief ratio at every scale, which reads
  // as coral-like crests. Relative to the broad surface (finer than ~1/40 of
  // the tile), only what rises *above* it, the interfluve crests, is lowered;
  // valleys keep their full incision, so channels stay crisp, narrow lines
  // cut into smoother slopes. Corridors, basins and uplands keep their relief.
  const depth = clamp(options.dissectionDepth ?? FLUVIAL_DEFAULTS.dissectionDepth, 0.2, 1);
  if (depth < 1) {
    const broad = broadComponent(z!, n, n / 40);
    for (let i = 0; i < z!.length; i++) {
      const local = z![i] - broad[i];
      if (local > 0) z![i] = broad[i] + depth * local;
    }
  }
  const floodplain = clamp(options.floodplain ?? FLUVIAL_DEFAULTS.floodplain);
  if (floodplain > 0) planeFloodplains(z!, n, drainage, floodplain, options.seed);

  const height = new Float32Array(n * n);
  for (let i = 0; i < height.length; i++) {
    const formed = low + z![i] * span;
    height[i] = source[i] + strength * (formed - source[i]);
  }
  return { height, drainage };
}

/**
 * Large rivers migrate laterally and plane flat valley floors whose width
 * grows with discharge (hydraulic geometry: width ∝ √area). Every channel
 * cell above a catchment threshold stamps a floor around itself: elevation
 * may only *drop*, to the river level plus a gentle cross-floor rise, and the
 * outer half of the floor blends back into the formed hillslope as a concave
 * toe slope. Taking the lowest candidate from all nearby channel cells makes
 * the floor tilt downstream with its river, so it still drains. Floor width
 * varies smoothly along each river. Hillslopes beyond the floor keep their
 * relief: broad, flat-floored corridors along trunk rivers, V-shaped valleys
 * upstream.
 */
export function planeFloodplains(
  z: Float64Array,
  n: number,
  area: Float32Array,
  amount: number,
  seed = 0,
): void {
  const strength = clamp(amount);
  if (strength <= 0 || area.length !== n * n) return;
  const cellArea = 1 / ((n - 1) * (n - 1));
  // Floors start at 0.2% of the tile's area; at full strength a river
  // draining a tenth of the tile has a floor ~3% of the tile wide.
  const startArea = 0.002;
  const widthScale = 0.05 * strength;
  const variation = new Noise((seed ^ 0x51ed270b) >>> 0);
  const source = z.slice();
  // Gentle cross-floor rise: a fraction of a typical cell drop.
  const rise = 0.15 / (n - 1);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x;
    const a = area[i] * cellArea;
    if (a < startArea) continue;
    const wobble = 1 + 0.4 * variation.simplex((x / n) * 9 + 3.3, (y / n) * 9 - 7.7);
    const half = widthScale * Math.sqrt(a) * (n - 1) * wobble;
    if (half < 1) continue;
    const r = Math.min(Math.ceil(half), Math.round(n / 20));
    const level = source[i];
    for (let dy = -r; dy <= r; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= n) continue;
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= n) continue;
        const distance = Math.hypot(dx, dy);
        if (distance > half) continue;
        const j = yy * n + xx;
        const floor = level + rise * distance;
        if (source[j] <= floor) continue;
        // Flat inner half; smooth concave toe into the wall outside it.
        const t = Math.max(0, (distance / half - 0.5) / 0.5);
        const toe = t * t * (3 - 2 * t);
        const candidate = floor + (source[j] - floor) * toe;
        if (candidate < z[j]) z[j] = candidate;
      }
    }
  }
}

/** Separable box blur, three passes ≈ Gaussian; edges renormalised. */
function broadComponent(z: Float64Array, n: number, radius: number): Float64Array {
  let current = z.slice();
  const temp = new Float64Array(n * n);
  const r = Math.max(1, Math.round(radius));
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < n; y++) {
      const row = y * n;
      let sum = 0, count = 0;
      for (let x = 0; x <= Math.min(r, n - 1); x++) { sum += current[row + x]; count++; }
      for (let x = 0; x < n; x++) {
        temp[row + x] = sum / count;
        const add = x + r + 1, drop = x - r;
        if (add < n) { sum += current[row + add]; count++; }
        if (drop >= 0) { sum -= current[row + drop]; count--; }
      }
    }
    const next = new Float64Array(n * n);
    for (let x = 0; x < n; x++) {
      let sum = 0, count = 0;
      for (let y = 0; y <= Math.min(r, n - 1); y++) { sum += temp[y * n + x]; count++; }
      for (let y = 0; y < n; y++) {
        next[y * n + x] = sum / count;
        const add = y + r + 1, drop = y - r;
        if (add < n) { sum += temp[add * n + x]; count++; }
        if (drop >= 0) { sum -= temp[drop * n + x]; count--; }
      }
    }
    current = next;
  }
  return current;
}

/**
 * Uplifted surfaces that rivers are still cutting into keep accordant
 * summits: interfluve crests across a region reach a common upland level
 * instead of each rising into a steady-state pyramid. Only the *broad*
 * component of the formed surface is compressed above its upland level
 * (the 55th percentile); every valley, spur and fine gully keeps its own
 * relief on top of it, and the broad compression is monotonic, so regional
 * drainage directions are unchanged.
 */
export function accordUplands(z: Float64Array, n: number, amount: number): void {
  const strength = clamp(amount);
  if (strength <= 0) return;
  const broad = broadComponent(z, n, n / 40);
  const sorted = Float64Array.from(broad).sort();
  const knee = sorted[Math.floor(sorted.length * 0.55)];
  const top = sorted[sorted.length - 1];
  if (top - knee < 1e-9) return;
  const keep = 1 - 0.7 * strength;
  for (let i = 0; i < z.length; i++) {
    const b = broad[i];
    if (b <= knee) continue;
    // The broad slope eases from 1 at the knee (C¹-continuous with the
    // untouched lowlands) to `keep` at the top; it never reverses.
    const t = (b - knee) / (top - knee);
    const eased = t - ((1 - keep) * t * t) / 2;
    z[i] += knee + eased * (top - knee) - b;
  }
}
