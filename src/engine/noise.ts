/** Deterministic scalar noise. The named artistic variants are our own formulas. */
export function randomGenerator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFrom(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return hash >>> 0;
}

export const clamp = (value: number, low = 0, high = 1): number =>
  Math.min(high, Math.max(low, value));
export const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (low: number, high: number, value: number): number => {
  const t = clamp((value - low) / Math.max(1e-9, high - low));
  return t * t * (3 - 2 * t);
};

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const gradientX = [1, -1, 1, -1, 1, -1, 0, 0];
const gradientY = [1, 1, -1, -1, 0, 0, 1, -1];

export class Noise {
  private readonly permutation = new Uint16Array(512);
  private readonly seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    const random = randomGenerator(seed);
    const values = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [values[i], values[j]] = [values[j], values[i]];
    }
    for (let i = 0; i < 512; i++) this.permutation[i] = values[i & 255];
  }

  private hash(x: number, y: number, channel = 0): number {
    let h =
      Math.imul(x | 0, 374761393) ^
      Math.imul(y | 0, 668265263) ^
      this.seed ^
      Math.imul(channel, 1274126177);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  perlin(x: number, y: number): number {
    const ix = Math.floor(x),
      iy = Math.floor(y);
    const fx = x - ix,
      fy = y - iy;
    const px = ix & 255,
      py = iy & 255;
    const p = this.permutation;
    const a = p[p[px] + py] & 7,
      b = p[p[px + 1] + py] & 7;
    const c = p[p[px] + py + 1] & 7,
      d = p[p[px + 1] + py + 1] & 7;
    return (
      mix(
        mix(
          gradientX[a] * fx + gradientY[a] * fy,
          gradientX[b] * (fx - 1) + gradientY[b] * fy,
          fade(fx),
        ),
        mix(
          gradientX[c] * fx + gradientY[c] * (fy - 1),
          gradientX[d] * (fx - 1) + gradientY[d] * (fy - 1),
          fade(fx),
        ),
        fade(fy),
      ) * 1.42
    );
  }

  simplex(x: number, y: number): number {
    const f = 0.3660254037844386,
      g = 0.21132486540518713;
    const skew = (x + y) * f;
    const ix = Math.floor(x + skew),
      iy = Math.floor(y + skew);
    const unskew = (ix + iy) * g;
    const x0 = x - (ix - unskew),
      y0 = y - (iy - unskew);
    const i1 = x0 > y0 ? 1 : 0,
      j1 = 1 - i1;
    const x1 = x0 - i1 + g,
      y1 = y0 - j1 + g;
    const x2 = x0 - 1 + 2 * g,
      y2 = y0 - 1 + 2 * g;
    const p = this.permutation,
      px = ix & 255,
      py = iy & 255;
    const corner = (dx: number, dy: number, hash: number) => {
      const t = 0.5 - dx * dx - dy * dy;
      if (t <= 0) return 0;
      const h = hash & 7;
      return t * t * t * t * (gradientX[h] * dx + gradientY[h] * dy);
    };
    return (
      70 *
      (corner(x0, y0, p[px + p[py]]) +
        corner(x1, y1, p[px + i1 + p[py + j1]]) +
        corner(x2, y2, p[px + 1 + p[py + 1]]))
    );
  }

  value(x: number, y: number): number {
    const ix = Math.floor(x),
      iy = Math.floor(y),
      fx = fade(x - ix),
      fy = fade(y - iy);
    return (
      mix(
        mix(this.hash(ix, iy), this.hash(ix + 1, iy), fx),
        mix(this.hash(ix, iy + 1), this.hash(ix + 1, iy + 1), fx),
        fy,
      ) *
        2 -
      1
    );
  }

  cellular(x: number, y: number): { f1: number; edge: number; cell: number } {
    const ix = Math.floor(x),
      iy = Math.floor(y);
    let first = Infinity,
      second = Infinity,
      cell = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const cx = ix + dx,
          cy = iy + dy;
        const px = cx + this.hash(cx, cy, 1),
          py = cy + this.hash(cx, cy, 2);
        const distance = (px - x) ** 2 + (py - y) ** 2;
        if (distance < first) {
          second = first;
          first = distance;
          cell = this.hash(cx, cy, 3);
        } else if (distance < second) second = distance;
      }
    return { f1: Math.sqrt(first), edge: Math.sqrt(second) - Math.sqrt(first), cell };
  }

  fractal(
    x: number,
    y: number,
    octaves = 6,
    persistence = 0.5,
    lacunarity = 2,
    mode = 'fbm',
    ridgeSoftness = 0,
  ): number {
    let sum = 0,
      weight = 0,
      amplitude = 1,
      feedback = 1;
    for (let octave = 0; octave < octaves; octave++) {
      const n = this.perlin(x + octave * 19.19, y + octave * 7.73);
      let v = n;
      if (mode === 'ridged') {
        // Mountain sources can round the absolute-value cusp without blurring
        // the heightfield or removing small drainage detail. The standalone
        // ridged noise mode keeps its classic sharp kernel by default.
        const folded =
          ridgeSoftness > 0
            ? (Math.sqrt(n * n + ridgeSoftness * ridgeSoftness) - ridgeSoftness) /
              (Math.sqrt(1 + ridgeSoftness * ridgeSoftness) - ridgeSoftness)
            : Math.abs(n);
        v = Math.max(0, 1 - folded);
        v = v * v * feedback;
        feedback = clamp(v * 2.1);
      } else if (mode === 'billow') v = Math.pow(Math.abs(n), 0.65);
      else if (mode === 'turbulence') v = Math.abs(n);
      sum += v * amplitude;
      weight += amplitude;
      const nextX = (x * 0.8 + y * 0.6) * lacunarity;
      y = (-x * 0.6 + y * 0.8) * lacunarity;
      x = nextX;
      amplitude *= persistence;
    }
    return sum / Math.max(weight, 1e-9);
  }

  sample(
    mode: string,
    x: number,
    y: number,
    octaves: number,
    persistence: number,
    lacunarity: number,
    warp: number,
  ): number {
    switch (mode) {
      case 'perlin':
        return clamp(this.perlin(x, y) * 0.5 + 0.5);
      case 'simplex':
        return clamp(this.simplex(x, y) * 0.5 + 0.5);
      case 'ridged':
        return clamp(this.fractal(x, y, octaves, persistence, lacunarity, 'ridged'));
      case 'billow':
        return clamp(this.fractal(x, y, octaves, persistence, lacunarity, 'billow'));
      case 'turbulence':
        return clamp(this.fractal(x, y, octaves, persistence, lacunarity, 'turbulence') * 1.5);
      case 'voronoi':
        return clamp(this.cellular(x, y).f1 / 1.15);
      case 'voronoi-edge':
        return clamp(this.cellular(x, y).edge * 1.65);
      case 'cellular':
        return this.cellular(x, y).cell;
      case 'wave':
        return (Math.sin(x * Math.PI * 2 + warp * this.fractal(x, y, 3) * 5) + 1) * 0.5;
      case 'warped': {
        const u = x + this.fractal(x * 0.7 + 31, y * 0.7, 3) * warp * 3;
        const v = y + this.fractal(x * 0.7, y * 0.7 + 47, 3) * warp * 3;
        return clamp(this.fractal(u, v, octaves, persistence, lacunarity) * 0.5 + 0.5);
      }
      case 'naki': {
        // Independent Naki-inspired artistic variant, not Maxon's proprietary noise.
        const u = x + this.simplex(x * 0.55 + 11.4, y * 0.55) * (0.4 + warp);
        const v = y + this.value(x * 0.8, y * 0.8 + 5.7) * (0.4 + warp);
        const lobes = Math.sin(
          this.simplex(u, v) * 3.5 +
            this.fractal(u * 1.7, v * 1.7, octaves, persistence, lacunarity) * 2,
        );
        return clamp(0.5 + 0.5 * lobes);
      }
      default:
        return clamp(this.fractal(x, y, octaves, persistence, lacunarity) * 0.5 + 0.5);
    }
  }
}
