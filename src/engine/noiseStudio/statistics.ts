import type { StudioSettings } from '../../model/noiseStudio';
import { createKernel } from './kernels';
import { clamp, positiveModulo } from './math';

export interface KernelMoments {
  raw: number;
  absolute: number;
  square: number;
  ridge: number;
  pingpong: number;
}

export function ridgeSignal(n: number, s: StudioSettings): number {
  const e = s.ridgeSoftness;
  const absolute =
    e === 0 ? Math.abs(n) : (Math.sqrt(n * n + e * e) - e) / (Math.sqrt(1 + e * e) - e);
  return Math.pow(clamp(1 - absolute), s.ridgeSharpness);
}
export function pingPongSignal(n: number, strength: number): number {
  const p = positiveModulo((n + 1) * strength, 2);
  return p < 1 ? p : 2 - p;
}

const cache = new Map<string, KernelMoments>();
const keys: (keyof StudioSettings)[] = [
  'kernel',
  'cellularMetric',
  'cellularReturn',
  'cellularJitter',
  'cellularSmoothness',
  'cellularEdgeWidth',
  'gaborFrequency',
  'gaborBandwidth',
  'gaborOrientation',
  'gaborSpread',
  'gaborDensity',
  'spotDensity',
  'spotRadius',
  'spotSoftness',
  'craterRim',
  'waveProfile',
  'wavePhase',
  'waveAsymmetry',
  'phaseNoise',
  'ridgeSoftness',
  'ridgeSharpness',
  'pingPongStrength',
];

/**
 * Fixed 1024-point lattice-space quadrature, never output-image normalization.
 * Folded noise must fade toward E[fold(N)], not fold(E[N]); the latter wrongly
 * turns unresolved ridges into solid white and unresolved turbulence into black.
 * Exact symmetry supplies the raw mean where available. The remaining moments
 * are deterministic estimates, shared across seeds, resolutions and tile strips.
 */
export function calibrationFor(s: StudioSettings): () => KernelMoments {
  let moments: KernelMoments | undefined;
  return () => {
    if (moments) return moments;
    const key = JSON.stringify(keys.map((k) => s[k]));
    const found = cache.get(key);
    if (found) return (moments = found);
    const kernel = createKernel(s, 0x4d595df4);
    const sums: KernelMoments = { raw: 0, absolute: 0, square: 0, ridge: 0, pingpong: 0 };
    const count = 1024;
    for (let i = 0; i < count; i++) {
      // A two-dimensional additive low-discrepancy sequence over many cells.
      const x = positiveModulo(0.5 + (i + 1) * 0.7548776662466927, 1) * 257.13 - 128;
      const y = positiveModulo(0.5 + (i + 1) * 0.5698402909980532, 1) * 251.79 - 125;
      const n = clamp(kernel.sample(x, y), -1, 1);
      sums.raw += n;
      sums.absolute += Math.abs(n);
      sums.square += n * n;
      sums.ridge += ridgeSignal(n, s);
      sums.pingpong +=
        kernel.mean === 0
          ? (pingPongSignal(n, s.pingPongStrength) + pingPongSignal(-n, s.pingPongStrength)) * 0.5
          : pingPongSignal(n, s.pingPongStrength);
    }
    moments = {
      raw: kernel.mean ?? sums.raw / count,
      absolute: sums.absolute / count,
      square: sums.square / count,
      ridge: sums.ridge / count,
      pingpong: sums.pingpong / count,
    };
    if (cache.size >= 32) cache.delete(cache.keys().next().value!);
    cache.set(key, moments);
    return moments;
  };
}
