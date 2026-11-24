import { mix, quintic } from './math';
import type { SampleGradient } from './math';

// The FNL gradient table is five repeats of 24 evenly spaced unit vectors,
// followed by eight vectors. Constructing it from angles avoids another large
// copied table. Values agree with the vendored decimal constants to < 2e-15.
const gx = new Float64Array(128),
  gy = new Float64Array(128);
for (let i = 0; i < 128; i++) {
  const angle = ((i < 120 ? 82.5 - (i % 24) * 15 : 67.5 - (i - 120) * 45) * Math.PI) / 180;
  gx[i] = Math.cos(angle);
  gy[i] = Math.sin(angle);
}
const PRIME_X = 501125321,
  PRIME_Y = 1136930381;
const NORMALIZATION = 1.4247691104677813;

function gradientIndex(seed: number, x: number, y: number): number {
  let h = Math.imul(seed ^ Math.imul(x, PRIME_X) ^ Math.imul(y, PRIME_Y), 0x27d4eb2d);
  h ^= h >> 15;
  return (h & 254) >>> 1;
}

/**
 * Exact analytic differentiation of FNL's 2D, quintic, unit-gradient Perlin
 * interpolant. dx/dy are in local lattice coordinates, before octave transforms.
 */
export function perlinGradient(seed: number, x: number, y: number): SampleGradient {
  const ix = Math.floor(x),
    iy = Math.floor(y),
    tx = x - ix,
    ty = y - iy;
  const g00 = gradientIndex(seed, ix, iy),
    g10 = gradientIndex(seed, ix + 1, iy);
  const g01 = gradientIndex(seed, ix, iy + 1),
    g11 = gradientIndex(seed, ix + 1, iy + 1);
  const a = gx[g00] * tx + gy[g00] * ty;
  const b = gx[g10] * (tx - 1) + gy[g10] * ty;
  const c = gx[g01] * tx + gy[g01] * (ty - 1);
  const d = gx[g11] * (tx - 1) + gy[g11] * (ty - 1);
  const u = quintic(tx),
    v = quintic(ty);
  const du = 30 * tx * tx * (tx - 1) * (tx - 1);
  const dv = 30 * ty * ty * (ty - 1) * (ty - 1);
  const low = mix(a, b, u),
    high = mix(c, d, u);
  const dx = mix(
    mix(gx[g00], gx[g10], u) + (b - a) * du,
    mix(gx[g01], gx[g11], u) + (d - c) * du,
    v,
  );
  const dy = mix(mix(gy[g00], gy[g10], u), mix(gy[g01], gy[g11], u), v) + (high - low) * dv;
  return {
    value: mix(low, high, v) * NORMALIZATION,
    dx: dx * NORMALIZATION,
    dy: dy * NORMALIZATION,
  };
}
