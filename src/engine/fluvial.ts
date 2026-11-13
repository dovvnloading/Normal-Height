import { Noise } from './noise';
import { accumulateDrainage, createDrainageWorkspace, routeDrainage } from './hydrology';
import type { DrainageWorkspace } from './hydrology';

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
  /** Channel-initiation catchment in m² when the physical scale is known. */
  channelHeadArea?: number;
  /** Width of planed valley floors along larger rivers, 0–1. */
  floodplain?: number;
  /** Accordant upland summits of a still-dissecting uplifted surface, 0–1. */
  accordance?: number;
  /** Regional variation of drainage density, 0–1 (defaults to lithology). */
  drainageVariation?: number;
  /** Height of interfluve crests relative to the full steady state, 0.2–1. */
  dissectionDepth?: number;
  /**
   * Physical tile width and the elevation of a height of 1, in meters.
   * With both set, hillslopes are limited to `criticalSlope` in real angle.
   */
  worldSize?: number;
  heightScale?: number;
  /** Threshold hillslope angle in degrees (soil/rock failure), 20–65. */
  criticalSlope?: number;
  /** Soil-creep crest rounding (convex hilltops), 0–1; physical scale only. */
  crestRounding?: number;
}

/** Defaults shared by the engine and the node registry. */
export const FLUVIAL_DEFAULTS = {
  concavity: 0.56,
  lithology: 0.75,
  floodplain: 0.85,
  accordance: 0.8,
  dissectionDepth: 0.5,
  criticalSlope: 36,
  crestRounding: 0.6,
} as const;


const NX = [-1, 0, 1, -1, 1, -1, 0, 1] as const;
const NY = [-1, -1, -1, 0, 0, 1, 1, 1] as const;
const INV_DIST = [Math.SQRT1_2, 1, Math.SQRT1_2, 1, 1, Math.SQRT1_2, 1, Math.SQRT1_2] as const;
/**
 * Debris-flow valleys: slope falls from the hillslope threshold at the
 * channel head as S ∝ A^-θ (Stock & Dietrich 2003: θ ≈ 0.3 between ~10³ and
 * 10⁶ m²) until the fluvial stream-power slope is gentler.
 */
const DEBRIS_FLOW_EXPONENT = 0.3;
/** Index offsets of the eight neighbours, in NX/NY order. */
function neighbourOffsets(n: number): Int32Array {
  const offsets = new Int32Array(8);
  for (let d = 0; d < 8; d++) offsets[d] = NY[d] * n + NX[d];
  return offsets;
}
/** Effective contour length per direction in cells (Quinn et al. 1991). */
const CONTOUR = [0.354, 0.5, 0.354, 0.5, 0.5, 0.354, 0.5, 0.354] as const;

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
  // Channels begin above a critical catchment (Montgomery & Dietrich 1988),
  // varying with rock and soil: dense gullies in some regions, smooth
  // hillslopes cut only by larger channels in others. With a physical scale
  // it is a real area (default 2 ha) and never under ~4 cells; otherwise
  // ~18 output cells.
  const physicalHead = (options.worldSize ?? 0) > 0 && (options.heightScale ?? 0) > 0;
  // Converts a solver slope (elevation range per tile width) to real m/m.
  const headScale = physicalHead && options.channelCells === undefined
    ? (high - low) * options.heightScale! / options.worldSize! : 0;
  const channelArea = physicalHead && options.channelCells === undefined
    ? Math.max(4 / ((n - 1) * (n - 1)),
      clamp(options.channelHeadArea ?? 20000, 500, 500000) / (options.worldSize! * options.worldSize!))
    : clamp(options.channelCells ?? 18, 1, 400) / ((n - 1) * (n - 1));
  const densityVariation = 1.5 * clamp(options.drainageVariation ?? lithology);
  // With a physical scale, slopes follow real transport laws in m/m and are
  // converted to this solver's units (elevation range = 1 per tile width).
  const physical = (options.worldSize ?? 0) > 0 && (options.heightScale ?? 0) > 0;
  const criticalAngle = clamp(options.criticalSlope ?? FLUVIAL_DEFAULTS.criticalSlope, 20, 65);
  const criticalSlope = Math.tan((criticalAngle * Math.PI) / 180);
  const toSolver = physical ? options.worldSize! / ((high - low) * options.heightScale!) : 0;
  // Crest-rounding length L = D/U of soil creep, tied to the hillslope
  // length (√ of the channel-head area): ~100 m by default for a 2 ha head.
  const roundingLength = physical
    ? clamp(options.crestRounding ?? FLUVIAL_DEFAULTS.crestRounding, 0, 1) * 1.2 *
      Math.sqrt(channelArea) * options.worldSize! + 1e-6
    : 0;
  let finalLimit: Float64Array | null = null;
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
    // Smooth per-cell fields: single precision keeps the working set small.
    const erodibility = new Float32Array(count);
    const initiation = new Float32Array(count);
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

    // Harder rock stands steeper (cliffs), soft rock fails at gentler angles.
    const critical = physical ? new Float32Array(count) : null;
    if (critical) for (let i = 0; i < count; i++)
      critical[i] = criticalSlope * Math.pow(erodibility[i], -0.35);
    const formed = physical ? new Float64Array(count) : null;
    const spread = physical ? new Float64Array(count) : null;
    const channel = physical ? new Uint8Array(count) : null;
    const meters = physical ? options.worldSize! / (level - 1) : 0;
    let relief = 1;
    const slopeHead = new Float32Array(count).fill(1);
    const workspace = createDrainageWorkspace(level);
    const routed = new Float32Array(count);
    const integral = new Float64Array(count);
    const base = new Float64Array(count);
    const weights = new Float64Array(8);
    const iterations = level <= 160 ? 14 : level <= 320 ? 7 : level <= 640 ? 5 : 4;
    for (let pass = 0; pass < iterations; pass++) {
      // The first pass on an upsampled surface breaks its planar facets with
      // a raster-scale jitter so new tributaries are not parallel D8 lines.
      for (let i = 0; i < count; i++)
        routed[i] = z[i] + (pass === 0 ? 0.35 * dx * cellHash(i, options.seed ^ level) : 0);
      routeDrainage(routed, level, options.seed + level, workspace);
      // Channels start at smaller catchments on steeper ground (A_c·S² ≈
      // constant; Montgomery & Dietrich 1992): steep faces carry dense chutes
      // and couloirs, gentle slopes stay smooth. Reference slope 20°.
      if (headScale) {
        for (let y = 0; y < level; y++) for (let x = 0; x < level; x++) {
          const i = y * level + x;
          let steepest = 0;
          for (let d = 0; d < 8; d++) {
            const xx = x + NX[d], yy = y + NY[d];
            if (xx < 0 || yy < 0 || xx >= level || yy >= level) continue;
            steepest = Math.max(steepest, (z[i] - z[yy * level + xx]) * INV_DIST[d]);
          }
          const slope = steepest / dx * headScale;
          slopeHead[i] = clamp((0.364 / Math.max(slope, 0.05)) ** 2, 0.15, 4);
        }
      }
      const { order, receiver, rank } = workspace;
      // Random-D8: drain to a downhill neighbor chosen with probability
      // proportional to slope^1.4 instead of always the steepest one. Only
      // earlier-ranked neighbors qualify, so the network stays acyclic.
      // Steepest-only routing straightens valleys onto the eight raster
      // directions; this restores the irregular courses of real channels.
      const salt = (options.seed ^ Math.imul(level, 0x45d9f3b) ^ Math.imul(pass + 1, 0x27d4eb2d)) >>> 0;
      const offsets = neighbourOffsets(level);
      for (let y = 1; y < level - 1; y++) for (let x = 1; x < level - 1; x++) {
        const i = y * level + x;
        let total = 0;
        for (let d = 0; d < 8; d++) {
          const j = i + offsets[d];
          const drop = routed[i] - routed[j];
          const w = rank[j] < rank[i] && drop > 0 ? Math.pow(drop * INV_DIST[d], 1.4) : 0;
          weights[d] = w;
          total += w;
        }
        if (total <= 0) continue;
        let pick = (cellHash(i, salt) + 0.5) * total;
        for (let d = 0; d < 8; d++) {
          if (weights[d] <= 0) continue;
          pick -= weights[d];
          if (pick <= 0) { receiver[i] = i + offsets[d]; break; }
        }
      }
      const area = accumulateDrainage(workspace, 1, 0);
      if (critical && formed && spread && channel) {
        // Channel heads where routed (concentrated) flow reaches the head
        // area, but never within the creep length of a divide: soil creep
        // keeps the hilltop convex and unchannelled (cells × cell width is
        // the flow-path length on planar slopes, shorter in hollows, where
        // flow converges). Channels persist downstream.
        channel.fill(0);
        for (let k = count - 1; k >= 0; k--) {
          const cell = order[k], parent = receiver[cell];
          if (area[cell] * cellArea >= initiation[cell] * slopeHead[cell] &&
            area[cell] * meters >= roundingLength) channel[cell] = 1;
          if (channel[cell] && parent >= 0) channel[parent] = 1;
        }
        // Contributing area: dispersive on unchannelled hillslopes, so the
        // specific catchment area grows smoothly downslope, stays small on
        // noses and gathers in hollows; concentrated along the routed
        // receivers in channels. (Single-direction area is a per-cell
        // lottery on hillslopes; a transport law driven by it pits the
        // surface with one-cell notches.)
        hybridArea(routed, level, workspace, spread, channel);
        // Hillslopes: steady-state nonlinear creep (Roering et al. 1999),
        // q = D·S / (1 − (S/Sc)²) with q = U·a, a = specific catchment area.
        // Slope grows from 0 at the divide (convex, rounded crests) toward
        // the critical angle and never crosses it.
        // Channels: stream power S = G·U/(K·A^m), saturating smoothly at the
        // debris-flow valley slope. G is fitted so the formed surface tracks
        // the envelope (hillslope relief is physical, fixed).
        const hillslope = (cell: number) => {
          const sc = critical[cell];
          const r = (spread[cell] * meters) / roundingLength;
          return r > 1e-9 ? (sc * sc * (Math.sqrt(1 + (4 * r * r) / (sc * sc)) - 1)) / (2 * r) : 0;
        };
        // First sweep: least-squares gain G for the channel integral, with
        // hillslope relief (physical, fixed) estimated along the receivers.
        let num = 0, den = 0;
        for (let k = 0; k < count; k++) {
          const cell = order[k], parent = receiver[cell];
          if (parent < 0) { integral[cell] = 0; formed[cell] = 0; base[cell] = z[cell]; continue; }
          const diagonal = (cell % level) !== (parent % level) &&
            ((cell / level) | 0) !== ((parent / level) | 0);
          const distance = diagonal ? dx * Math.SQRT2 : dx;
          base[cell] = base[parent];
          if (!channel[cell]) {
            formed[cell] = formed[parent] + hillslope(cell) * toSolver * distance;
            integral[cell] = integral[parent];
          } else {
            formed[cell] = formed[parent];
            integral[cell] = integral[parent] +
              uplift[cell] * distance / (erodibility[cell] * Math.pow(spread[cell] * cellArea, m));
          }
          const rise = target[cell] - base[cell] - formed[cell];
          num += integral[cell] * rise;
          den += integral[cell] * integral[cell];
        }
        const gain = (den > 0 && num > 0 ? num / den : 1) * relief;
        // Second sweep: the saturated steady state with the fitted gain.
        // A hillslope cell stands above the flow-weighted mean of the cells
        // it drains to (the dispersive weights of its area), so adjacent
        // slopes agree instead of each following its own one-cell path.
        // Only interior cells drain, so neighbours need no bounds checks.
        for (let k = 0; k < count; k++) {
          const cell = order[k], parent = receiver[cell];
          if (parent < 0) { formed[cell] = z[cell]; continue; }
          const diagonal = (cell % level) !== (parent % level) &&
            ((cell / level) | 0) !== ((parent / level) | 0);
          const distance = diagonal ? dx * Math.SQRT2 : dx;
          if (!channel[cell]) {
            const rise = hillslope(cell) * toSolver;
            const here = routed[cell], ranked = rank[cell];
            let wsum = 0, fsum = 0;
            for (let d = 0; d < 8; d++) {
              const j = cell + offsets[d], drop = here - routed[j];
              if (drop <= 0 || rank[j] >= ranked) continue;
              const w = drop * INV_DIST[d] * CONTOUR[d];
              wsum += w;
              fsum += w * (formed[j] + (rise * dx) / INV_DIST[d]);
            }
            formed[cell] = wsum > 0 ? fsum / wsum : formed[parent] + rise * distance;
            continue;
          }
          // Steep small channels are scoured by debris flows: a valley starts
          // at the hillslope angle at its head and flattens downstream, so
          // gullies begin as shallow swales and deepen with catchment.
          // At the head the valley continues the creep slope above it.
          const a = spread[cell] * cellArea;
          const head = initiation[cell] * slopeHead[cell];
          const sd = toSolver * Math.min(hillslope(cell),
            critical[cell] * Math.pow(Math.max(1, a / head), -DEBRIS_FLOW_EXPONENT));
          const stream = gain * uplift[cell] / (erodibility[cell] * Math.pow(a, m));
          formed[cell] = formed[parent] + sd * Math.tanh(stream / sd) * distance;
        }
        const last = pass === iterations - 1;
        const step = last ? 1 : 0.65;
        let formedRise = 0, targetRise = 0;
        for (let i = 0; i < count; i++) {
          if (receiver[i] < 0) continue;
          z[i] += step * (formed[i] - z[i]);
          formedRise += formed[i] - base[i];
          targetRise += target[i] - base[i];
        }
        // Where saturation binds, channels steepen to carry authored relief.
        if (formedRise > 0 && targetRise > 0)
          relief = clamp(relief * clamp((targetRise / formedRise) ** 0.8, 0.8, 1.6), 1, 8);
        if (level === n) drainage = Float32Array.from(area);
        continue;
      }
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
        const a = Math.max(area[cell] * cellArea, initiation[cell] * slopeHead[cell]);
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

    if (critical) {
      // Bound lateral steps between flow paths before the next level routes
      // on this surface. The finest level is bounded once, after finishing.
      const limit = new Float64Array(count);
      for (let i = 0; i < count; i++) limit[i] = critical[i] * toSolver * dx;
      if (level === n) finalLimit = limit;
      else limitSlopeIsotropic(z, level, limit);
    }

    // Light hillslope diffusion, strongest on unchannelled crest cells.
    if (softening > 0 && level === n && !critical) {
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
  if (floodplain > 0) planeFloodplains(z!, n, drainage, floodplain, options.seed, finalLimit ?? undefined);
  if (finalLimit) {
    // Soil creep: a steady-state hilltop has curvature U/D = 1/L, and no
    // crest can be sharper. Where the two sides of a divide formed along
    // separate flow paths meet in a crease, the crest is rounded to that
    // curvature (all other relief is untouched).
    const meters = options.worldSize! / (n - 1);
    roundHilltops(z!, n, (meters * meters * toSolver) / (2 * roundingLength * options.worldSize!));
    // The finishing steps reshape relief; the threshold still bounds every
    // slope afterwards (floodplain edges included).
    limitSlopeIsotropic(z!, n, finalLimit);
  }

  const height = new Float32Array(n * n);
  for (let i = 0; i < height.length; i++) {
    const formed = low + z![i] * span;
    height[i] = source[i] + strength * (formed - source[i]);
  }
  return { height, drainage };
}

/**
 * Large rivers migrate laterally and plane flat valley floors whose width
 * grows with discharge (hydraulic geometry: width ∝ √area). Every cell takes
 * the floor of its nearest river cell above a catchment threshold (Euclidean
 * nearest, so the floor outline is a smooth offset of the river, not a union
 * of stamped discs): the river level plus a gentle cross-floor rise, so the
 * floor tilts downstream with its river and still drains. Elevation may only
 * drop. Floor width varies smoothly along each river.
 *
 * Beyond the flat inner half of the floor, the valley wall either blends
 * back into the formed hillslope (dimensionless), or, given a wall slope per
 * cell (physical scale), rises from the floor edge through a concave
 * colluvial toe to that slope: the undercut wall retreats parallel to itself
 * and meets the hillslope where they cross, never steeper than the limit.
 * Broad, flat-floored corridors along trunk rivers, V-shaped valleys upstream.
 */
export function planeFloodplains(
  z: Float64Array,
  n: number,
  area: Float32Array,
  amount: number,
  seed = 0,
  wallSlope?: Float64Array,
): void {
  const strength = clamp(amount);
  if (strength <= 0 || area.length !== n * n) return;
  const cellArea = 1 / ((n - 1) * (n - 1));
  // Floors start at 0.2% of the tile's area; at full strength a river
  // draining a tenth of the tile has a floor ~3% of the tile wide.
  const startArea = 0.002;
  const widthScale = 0.05 * strength;
  const variation = new Noise((seed ^ 0x51ed270b) >>> 0);
  const half = new Float64Array(n * n);
  let rivers = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x;
    const a = area[i] * cellArea;
    if (a < startArea) continue;
    const wobble = 1 + 0.4 * variation.simplex((x / n) * 9 + 3.3, (y / n) * 9 - 7.7);
    const width = widthScale * Math.sqrt(a) * (n - 1) * wobble;
    if (width < 1) continue;
    half[i] = Math.min(width, Math.round(n / 20));
    rivers++;
  }
  if (!rivers) return;
  const { source, distance } = nearestMarked(n, half);
  const level = z.slice();
  // Gentle cross-floor rise: a fraction of a typical cell drop.
  const rise = 0.15 / (n - 1);
  for (let j = 0; j < z.length; j++) {
    const river = source[j];
    if (river < 0) continue;
    const width = half[river], d = distance[j];
    const floor = level[river] + rise * d;
    if (z[j] <= floor) continue;
    let candidate: number;
    if (wallSlope) {
      const flat = 0.5 * width;
      if (d <= flat) candidate = floor;
      else {
        const toe = Math.max(2, 0.5 * width), out = d - flat, wall = 0.97 * wallSlope[j];
        candidate = level[river] + rise * flat +
          (out < toe ? (wall * out * out) / (2 * toe) : wall * (out - toe / 2));
      }
    } else {
      if (d > width) continue;
      // Flat inner half; smooth concave toe into the wall outside it.
      const t = Math.max(0, (d / width - 0.5) / 0.5);
      candidate = floor + (z[j] - floor) * t * t * (3 - 2 * t);
    }
    if (candidate < z[j]) z[j] = candidate;
  }
  if (!wallSlope) return;
  // Each cell takes its nearest river cell's level, which steps down the
  // river cell by cell: relax the lowered zone (floor, toe and wall) with a
  // few isotropic averaging passes. Elevation still only drops, and river
  // cells, the lowest in their neighbourhood, keep their level.
  const zone: number[] = [];
  for (let j = 0; j < z.length; j++) {
    const x = j % n, y = (j - x) / n;
    if (x > 0 && y > 0 && x < n - 1 && y < n - 1 && z[j] < level[j]) zone.push(j);
  }
  const next = new Float64Array(zone.length);
  for (let pass = 0; pass < 3; pass++) {
    for (let k = 0; k < zone.length; k++) {
      const i = zone[k];
      const mean = (4 * (z[i - 1] + z[i + 1] + z[i - n] + z[i + n]) +
        z[i - n - 1] + z[i - n + 1] + z[i + n - 1] + z[i + n + 1]) / 20;
      next[k] = Math.min(level[i], 0.5 * (z[i] + mean));
    }
    for (let k = 0; k < zone.length; k++) z[zone[k]] = next[k];
  }
}

/**
 * Nearest marked (non-zero) cell for every cell and the Euclidean distance
 * to it, in cells: two raster passes propagating source indices (8SSEDT).
 */
function nearestMarked(n: number, marked: Float64Array): { source: Int32Array; distance: Float64Array } {
  const count = n * n;
  const source = new Int32Array(count).fill(-1);
  const squared = new Float64Array(count).fill(Infinity);
  for (let i = 0; i < count; i++) if (marked[i] > 0) { source[i] = i; squared[i] = 0; }
  const relax = (i: number, x: number, y: number, j: number) => {
    const s = source[j];
    if (s < 0) return;
    const sx = s % n, sy = (s - sx) / n;
    const d = (x - sx) * (x - sx) + (y - sy) * (y - sy);
    if (d < squared[i]) { squared[i] = d; source[i] = s; }
  };
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      if (x > 0) relax(i, x, y, i - 1);
      if (y > 0) {
        relax(i, x, y, i - n);
        if (x > 0) relax(i, x, y, i - n - 1);
        if (x < n - 1) relax(i, x, y, i - n + 1);
      }
    }
    for (let x = n - 2; x >= 0; x--) relax(y * n + x, x, y, y * n + x + 1);
  }
  for (let y = n - 1; y >= 0; y--) {
    for (let x = n - 1; x >= 0; x--) {
      const i = y * n + x;
      if (x < n - 1) relax(i, x, y, i + 1);
      if (y < n - 1) {
        relax(i, x, y, i + n);
        if (x < n - 1) relax(i, x, y, i + n + 1);
        if (x > 0) relax(i, x, y, i + n - 1);
      }
    }
    for (let x = 1; x < n; x++) relax(y * n + x, x, y, y * n + x - 1);
  }
  const distance = new Float64Array(count);
  for (let i = 0; i < count; i++) distance[i] = Math.sqrt(squared[i]);
  return { source, distance };
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

/**
 * Isotropic threshold hillslopes: the maximal Lipschitz minorant. Returns
 * the highest surface w ≤ z whose gradient magnitude nowhere exceeds the
 * per-cell critical slope (`slopePerCell`, height per cell of distance),
 * by Fast Marching on the eikonal |∇w| = S with z as an obstacle. The
 * upwind quadratic update approximates the Euclidean metric, so limited
 * slopes form cones and their intersections follow the terrain, not the
 * eight raster directions (a chamfer limit cuts octagonal facets). Every
 * cell can only be lowered; slopes already below the limit are untouched.
 */
export function limitSlopeIsotropic(z: Float64Array, n: number, slopePerCell: Float64Array): void {
  const count = n * n;
  const accepted = new Uint8Array(count);
  // Binary heap of (value, cell) with lazy deletion of stale entries.
  let capacity = count * 2;
  let keys = new Float64Array(capacity), cells = new Int32Array(capacity), size = 0;
  const push = (value: number, cell: number) => {
    if (size === capacity) {
      capacity *= 2;
      const k = new Float64Array(capacity); k.set(keys); keys = k;
      const c = new Int32Array(capacity); c.set(cells); cells = c;
    }
    let at = size++;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (keys[parent] <= value) break;
      keys[at] = keys[parent]; cells[at] = cells[parent]; at = parent;
    }
    keys[at] = value; cells[at] = cell;
  };
  const pop = () => {
    const cell = cells[0];
    const value = keys[--size], last = cells[size];
    let at = 0;
    while (true) {
      let child = at * 2 + 1;
      if (child >= size) break;
      if (child + 1 < size && keys[child + 1] < keys[child]) child++;
      if (keys[child] >= value) break;
      keys[at] = keys[child]; cells[at] = cells[child]; at = child;
    }
    keys[at] = value; cells[at] = last;
    return cell;
  };
  for (let i = 0; i < count; i++) if (Number.isFinite(z[i])) push(z[i], i);
  const neighbour = (x: number, y: number) =>
    x < 0 || y < 0 || x >= n || y >= n ? Infinity : (accepted[y * n + x] ? z[y * n + x] : Infinity);
  while (size > 0) {
    const value = keys[0];
    const cell = pop();
    if (accepted[cell] || value > z[cell]) continue;
    accepted[cell] = 1;
    const cx = cell % n, cy = (cell / n) | 0;
    for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]) {
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const j = ny * n + nx;
      if (accepted[j]) continue;
      const a = Math.min(neighbour(nx - 1, ny), neighbour(nx + 1, ny));
      const b = Math.min(neighbour(nx, ny - 1), neighbour(nx, ny + 1));
      const h = slopePerCell[j];
      let candidate: number;
      if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < h)
        candidate = (a + b + Math.sqrt(2 * h * h - (a - b) * (a - b))) / 2;
      else candidate = Math.min(a, b) + h;
      if (candidate < z[j]) {
        z[j] = candidate;
        push(candidate, j);
      }
    }
  }
}

/**
 * Contributing area in cells. On hillslopes flow disperses to every lower,
 * earlier-routed neighbour in proportion to slope × contour length (multiple
 * flow direction, Quinn et al. 1991); `channel` cells pass everything to
 * their routed receiver.
 */
function hybridArea(
  routed: ArrayLike<number>, n: number, workspace: DrainageWorkspace,
  spread: Float64Array, channel: Uint8Array,
): void {
  const { order, receiver, rank } = workspace;
  const weights = new Float64Array(8);
  const offsets = neighbourOffsets(n);
  spread.fill(1);
  for (let k = n * n - 1; k >= 0; k--) {
    const cell = order[k], parent = receiver[cell];
    if (parent < 0) continue;
    const own = spread[cell];
    if (channel[cell]) {
      spread[parent] += own;
      continue;
    }
    // Draining cells are interior (the tile boundary is the outlet set).
    const here = routed[cell], ranked = rank[cell];
    let total = 0;
    for (let d = 0; d < 8; d++) {
      const drop = here - routed[cell + offsets[d]];
      const w = drop > 0 && rank[cell + offsets[d]] < ranked ? drop * INV_DIST[d] * CONTOUR[d] : 0;
      weights[d] = w;
      total += w;
    }
    if (total <= 0) { spread[parent] += own; continue; }
    const share = own / total;
    for (let d = 0; d < 8; d++)
      if (weights[d] > 0) spread[cell + offsets[d]] += share * weights[d];
  }
}

/**
 * Bounds convex curvature: the morphological opening of the surface by the
 * paraboloid d² · `curvature` (height per cell²). Every crest or summit
 * sharper than the paraboloid is replaced by the paraboloid's cap; planar
 * and concave relief (slopes, valleys) is unchanged, and the surface can
 * only drop. Exact and O(n²): separable lower envelopes of parabolas
 * (Felzenszwalb & Huttenlocher 2012). Each line continues past the tile
 * edge by odd reflection, so slopes running into the edge are not crests.
 */
export function roundHilltops(z: Float64Array, n: number, curvature: number): void {
  if (!(curvature > 0) || !Number.isFinite(curvature) || n < 2) return;
  const pad = Math.min(n - 1, 128), total = n + 2 * pad;
  const line = new Float64Array(total), out = new Float64Array(total);
  const sites = new Int32Array(total), bounds = new Float64Array(total + 1);
  const values = new Float64Array(n);
  // Pads `values` into `line` (odd reflection about each end sample).
  const extend = () => {
    for (let x = 0; x < n; x++) line[pad + x] = values[x];
    for (let k = 1; k <= pad; k++) {
      line[pad - k] = 2 * values[0] - values[Math.min(k, n - 1)];
      line[pad + n - 1 + k] = 2 * values[n - 1] - values[Math.max(n - 1 - k, 0)];
    }
  };
  // Lower envelope: out[p] = min_q line[q] + c·(p − q)².
  const envelope = (c: number) => {
    let k = 0;
    sites[0] = 0;
    bounds[0] = -Infinity;
    bounds[1] = Infinity;
    for (let q = 1; q < total; q++) {
      let r = sites[k];
      let cross = (line[q] + c * q * q - (line[r] + c * r * r)) / (2 * c * (q - r));
      while (cross <= bounds[k]) {
        k--;
        r = sites[k];
        cross = (line[q] + c * q * q - (line[r] + c * r * r)) / (2 * c * (q - r));
      }
      k++;
      sites[k] = q;
      bounds[k] = cross;
      bounds[k + 1] = Infinity;
    }
    k = 0;
    for (let p = 0; p < total; p++) {
      while (bounds[k + 1] < p) k++;
      const q = sites[k];
      out[p] = line[q] + c * (p - q) * (p - q);
    }
  };
  // Separable 2D lower envelope of field·sign (in place on work).
  const lower = (work: Float64Array) => {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) values[x] = work[y * n + x];
      extend();
      envelope(curvature);
      for (let x = 0; x < n; x++) work[y * n + x] = out[pad + x];
    }
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) values[y] = work[y * n + x];
      extend();
      envelope(curvature);
      for (let y = 0; y < n; y++) work[y * n + x] = out[pad + y];
    }
  };
  // Erosion (min of z + c·d²), then dilation (max of e − c·d²).
  const work = z.slice();
  lower(work);
  for (let i = 0; i < work.length; i++) work[i] = -work[i];
  lower(work);
  for (let i = 0; i < z.length; i++) z[i] = Math.min(z[i], -work[i]);
}
