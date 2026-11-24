import FastNoiseLite, { NoiseType } from './vendor/FastNoiseLite';
import type { StudioSettings } from '../../model/noiseStudio';
import { deriveSeed } from '../../model/noiseStudio';
import { cellularSample, smoothCellular } from './cellular';
import { clamp, mix, positiveModulo, quintic, smoothstep, spatialHash } from './math';
import type { SampleGradient } from './math';
import { perlinGradient } from './perlin';
import { broadenSpot, filteredEdgeMask } from './coverage';

export interface StudioKernelEvaluator {
  /** Signed, bounded [-1,1], with spatial scale fixed in lattice coordinates. */
  sample(x: number, y: number, footprint?: number): number;
  gradient(x: number, y: number, footprint?: number): SampleGradient;
  derivative: 'analytic' | 'numerical' | 'discontinuous';
  /** Nominal frequency used for conservative octave rolloff; not a bandlimit. */
  bandwidth: number;
  /** Exact symmetry where available; other means use fixed lattice quadrature. */
  mean?: number;
}

const TAU = 2 * Math.PI;
const vendorTypes = {
  opensimplex2s: NoiseType.OpenSimplex2S,
  opensimplex2: NoiseType.OpenSimplex2,
  perlin: NoiseType.Perlin,
  value: NoiseType.Value,
  'value-cubic': NoiseType.ValueCubic,
} as const;

function vendor(seed: number, type: NoiseType): (x: number, y: number) => number {
  const noise = new FastNoiseLite(seed | 0);
  noise.SetFrequency(1);
  noise.SetNoiseType(type);
  return (x, y) => noise.GetNoise(x, y);
}

/** Symmetric differences in local kernel coordinates, deliberately not a pseudo-derivative. */
function numericalGradient(
  sample: (x: number, y: number, footprint?: number) => number,
  x: number,
  y: number,
  footprint: number,
): SampleGradient {
  const h = 0.0001;
  return {
    value: sample(x, y, footprint),
    dx: (sample(x + h, y, footprint) - sample(x - h, y, footprint)) / (2 * h),
    dy: (sample(x, y + h, footprint) - sample(x, y - h, footprint)) / (2 * h),
  };
}

interface Impulse {
  x: number;
  y: number;
  dx: number;
  dy: number;
  phase: number;
}

/**
 * Jittered sparse Gabor convolution, independently implemented from its formula.
 * Fixed impulses per cell are not a Poisson process. The Gaussian is smoothly
 * truncated at exp(-pi*a²*r²)=0.002, then variance-scaled and smoothly bounded.
 */
function gaborKernel(s: StudioSettings, seed: number): (x: number, y: number) => number {
  const a = s.gaborBandwidth,
    density = s.gaborDensity;
  const radius = Math.sqrt(-Math.log(0.002) / Math.PI) / a,
    radius2 = radius * radius;
  const inner2 = radius2 * 0.64,
    span2 = radius2 - inner2,
    window = Math.ceil(radius);
  const orientation = (s.gaborOrientation * Math.PI) / 180,
    spread = (s.gaborSpread * Math.PI) / 180;
  const carrier = TAU * s.gaborFrequency;
  // Random phase has E[cos²]=1/2; integral of exp(-2*pi*a²*r²)=1/(2a²).
  const normalization = (2 * a) / (3 * Math.sqrt(density));
  const cache = new Map<string, Impulse[]>();
  const impulses = (cx: number, cy: number): Impulse[] => {
    const key = `${cx},${cy}`;
    const found = cache.get(key);
    if (found) return found;
    const list: Impulse[] = [];
    for (let k = 0; k < density; k++) {
      const channel = k * 5;
      const angle = orientation + (spatialHash(seed, cx, cy, channel + 2) * 2 - 1) * spread;
      list.push({
        x: cx + spatialHash(seed, cx, cy, channel),
        y: cy + spatialHash(seed, cx, cy, channel + 1),
        dx: Math.cos(angle) * carrier,
        dy: Math.sin(angle) * carrier,
        phase: TAU * spatialHash(seed, cx, cy, channel + 3),
      });
    }
    // This is an acceleration cache only: eviction never changes any value.
    if (cache.size >= 4096) cache.clear();
    cache.set(key, list);
    return list;
  };
  return (x, y) => {
    const ix = Math.floor(x),
      iy = Math.floor(y);
    let sum = 0;
    for (let dy = -window; dy <= window; dy++)
      for (let dx = -window; dx <= window; dx++) {
        const cx = ix + dx,
          cy = iy + dy;
        const bx = Math.max(0, Math.abs(x - cx - 0.5) - 0.5);
        const by = Math.max(0, Math.abs(y - cy - 0.5) - 0.5);
        if (bx * bx + by * by >= radius2) continue;
        for (const impulse of impulses(cx, cy)) {
          const qx = x - impulse.x,
            qy = y - impulse.y,
            r2 = qx * qx + qy * qy;
          if (r2 >= radius2) continue;
          const taper = r2 <= inner2 ? 1 : 1 - quintic((r2 - inner2) / span2);
          sum +=
            Math.exp(-Math.PI * a * a * r2) *
            taper *
            Math.cos(impulse.dx * qx + impulse.dy * qy + impulse.phase);
        }
      }
    return Math.tanh(sum * normalization);
  };
}

function featureKernel(
  s: StudioSettings,
  seed: number,
): (x: number, y: number, footprint?: number) => number {
  const crater = s.kernel === 'crater',
    power = 2 + s.spotSoftness * (crater ? 2 : 6);
  const maxRadius = s.spotRadius * 1.15;
  return (x, y, footprint = 0) => {
    const support = crater
      ? Math.max(
          broadenSpot(maxRadius, power, footprint).radius,
          maxRadius + 2 * Math.sqrt((maxRadius * s.craterRim) ** 2 + (footprint * footprint) / 6),
        )
      : broadenSpot(maxRadius, power, footprint).radius;
    const window = Math.ceil(support);
    const ix = Math.floor(x),
      iy = Math.floor(y);
    let sum = 0,
      uncovered = 1;
    for (let dy = -window; dy <= window; dy++)
      for (let dx = -window; dx <= window; dx++) {
        const cx = ix + dx,
          cy = iy + dy;
        if (spatialHash(seed, cx, cy, 0) >= s.spotDensity) continue;
        const px = cx + spatialHash(seed, cx, cy, 1),
          py = cy + spatialHash(seed, cx, cy, 2);
        const radius = s.spotRadius * mix(0.7, 1.15, spatialHash(seed, cx, cy, 3));
        const distance = Math.hypot(x - px, y - py);
        const profile = broadenSpot(radius, power, footprint),
          q = distance / profile.radius;
        if (crater) {
          const originalWidth = radius * s.craterRim;
          const rimWidth = Math.sqrt(originalWidth * originalWidth + (footprint * footprint) / 6);
          if (q >= 1 && distance >= radius + 2 * rimWidth) continue;
          const bowl = q < 1 ? -0.85 * profile.amplitude * Math.pow(1 - q * q, power) : 0;
          // Radial Gaussian width broadening preserves line-integrated rim mass;
          // ring curvature and compact tapers make this a local approximation.
          const rim =
            ((0.45 * originalWidth) / rimWidth) *
            Math.exp(-Math.pow((distance - radius * 0.92) / rimWidth, 2)) *
            smoothstep(0, radius * 0.4, distance) *
            (1 - smoothstep(radius + rimWidth, radius + 2 * rimWidth, distance));
          sum += (bowl + rim) * mix(0.65, 1, spatialHash(seed, cx, cy, 4));
        } else if (q < 1) {
          const spot = profile.amplitude * Math.pow(1 - q * q, power);
          uncovered *= 1 - spot * mix(0.65, 1, spatialHash(seed, cx, cy, 4));
        }
      }
    return crater ? Math.tanh(sum * 1.4) : 1 - 2 * uncovered;
  };
}

function patternKernel(s: StudioSettings, seed: number): (x: number, y: number) => number {
  const modulation = vendor(deriveSeed(seed, 81), NoiseType.OpenSimplex2S);
  const seedPhase = spatialHash(seed, 0, 0, 12);
  return (x, y) => {
    const irregularity = s.phaseNoise === 0 ? 0 : s.phaseNoise * modulation(x * 0.23, y * 0.23);
    let p = x + s.wavePhase + seedPhase + irregularity;
    if (s.kernel === 'strata')
      p +=
        0.45 * Math.sin(y * 0.55 + seedPhase * TAU) +
        s.phaseNoise * 0.5 * modulation(x * 0.11 + 25.2, y * 0.16 - 19.1);
    p = positiveModulo(p, 1);
    if (s.kernel === 'strata') return 2 * Math.pow(Math.sin(Math.PI * p), 4) - 1;
    if (s.kernel === 'dunes') {
      const triangular =
        p < s.waveAsymmetry ? p / s.waveAsymmetry : (1 - p) / (1 - s.waveAsymmetry);
      return 2 * quintic(triangular) - 1;
    }
    if (s.waveProfile === 'saw') return p * 2 - 1;
    if (s.waveProfile === 'triangle')
      return 2 * (p < s.waveAsymmetry ? p / s.waveAsymmetry : (1 - p) / (1 - s.waveAsymmetry)) - 1;
    return Math.sin(p * TAU);
  };
}

export function createKernel(s: StudioSettings, seed: number): StudioKernelEvaluator {
  let sample: (x: number, y: number, footprint?: number) => number, mean: number | undefined;
  let bandwidth = 1,
    derivative: StudioKernelEvaluator['derivative'] = 'numerical';
  if (s.kernel in vendorTypes) {
    sample = vendor(seed, vendorTypes[s.kernel as keyof typeof vendorTypes]);
    mean = 0;
    if (s.kernel === 'perlin') derivative = 'analytic';
  } else if (s.kernel === 'cellular') {
    const metric = s.cellularReturn === 'edge' ? 'euclidean' : s.cellularMetric;
    const scale1 = metric === 'euclidean' ? Math.SQRT2 : metric === 'manhattan' ? 2 : 1;
    const scale2 = metric === 'euclidean' ? Math.sqrt(3.25) : metric === 'manhattan' ? 2.5 : 1.5;
    sample = (x, y, footprint = 0) => {
      if (s.cellularReturn === 'smooth')
        return (
          2 *
            clamp(
              (smoothCellular(seed, x, y, s.cellularJitter, metric, s.cellularSmoothness) +
                s.cellularSmoothness) /
                (scale1 + s.cellularSmoothness),
            ) -
          1
        );
      const n = cellularSample(seed, x, y, s.cellularJitter, metric, s.cellularReturn === 'edge');
      let value: number;
      switch (s.cellularReturn) {
        case 'f2':
          value = n.f2 / scale2;
          break;
        case 'gap':
          value = (n.f2 - n.f1) / scale2;
          break;
        case 'ratio':
          value = n.f2 > 1e-12 ? n.f1 / n.f2 : 0;
          break;
        case 'cell':
          value = n.id;
          break;
        case 'edge':
          value = 1 - filteredEdgeMask(n.edge, s.cellularEdgeWidth, footprint);
          break;
        default:
          value = n.f1 / scale1;
      }
      return 2 * clamp(value) - 1;
    };
    if (s.cellularReturn === 'cell') {
      derivative = 'discontinuous';
      mean = 0;
    }
  } else if (s.kernel === 'gabor') {
    sample = gaborKernel(s, seed);
    bandwidth = s.gaborFrequency + s.gaborBandwidth;
    mean = 0;
  } else if (s.kernel === 'sparse' || s.kernel === 'crater') {
    sample = featureKernel(s, seed);
  } else if (s.kernel === 'white' || s.kernel === 'gaussian') {
    derivative = 'discontinuous';
    mean = 0;
    sample =
      s.kernel === 'white'
        ? (x, y) => 2 * spatialHash(seed, Math.floor(x), Math.floor(y), 0) - 1
        : (x, y) => {
            const ix = Math.floor(x),
              iy = Math.floor(y);
            const u = Math.max(1 / 4294967296, spatialHash(seed, ix, iy, 0));
            return clamp(
              (Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * spatialHash(seed, ix, iy, 1))) / 3,
              -1,
              1,
            );
          };
  } else {
    sample = patternKernel(s, seed);
    if (s.kernel === 'wave' && s.waveProfile === 'saw') derivative = 'discontinuous';
    if (s.phaseNoise === 0) mean = s.kernel === 'strata' ? -0.25 : 0;
  }
  return {
    sample,
    derivative,
    bandwidth,
    mean,
    gradient:
      derivative === 'analytic'
        ? (x, y) => perlinGradient(seed, x, y)
        : derivative === 'discontinuous'
          ? (x, y, footprint = 0) => ({ value: sample(x, y, footprint), dx: 0, dy: 0 })
          : (x, y, footprint = 0) => numericalGradient(sample, x, y, footprint),
  };
}
