/** Stable 32-bit operations: no mutable random stream in a sample evaluator. */
export function hash32(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

export function spatialHash(seed: number, x: number, y: number, channel = 0): number {
  return (
    hash32(
      seed ^
        Math.imul(x | 0, 0x1f123bb5) ^
        Math.imul(y | 0, 0x5f356495) ^
        Math.imul(channel, 0x6c8e9cf5),
    ) / 4294967296
  );
}

export const clamp = (v: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, v));
export const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
export const quintic = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
export const smoothstep = (a: number, b: number, v: number): number => {
  const t = clamp((v - a) / Math.max(1e-12, b - a));
  return t * t * (3 - 2 * t);
};

/** A smooth rolloff for a nominal lattice frequency, not an exact band limit. */
export const octaveVisibility = (footprint: number): number => 1 - smoothstep(0.25, 0.5, footprint);

export const positiveModulo = (value: number, modulus: number): number =>
  value - Math.floor(value / modulus) * modulus;

export interface SampleGradient {
  value: number;
  dx: number;
  dy: number;
}
