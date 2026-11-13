/**
 * Physical comparison of two authoritative Float32 heightfields.
 *
 * This intentionally runs in a worker for the interactive UI. A pure function
 * permits numerical tests independently of Chromium and WebGL.
 */
export interface DifferenceMapInput {
  current: Float32Array;
  baseline: Float32Array;
  currentSize: number;
  baselineSize: number;
  currentScale: number;
  baselineScale: number;
  outputSize: number;
  worldSize: number;
}

export interface DifferenceStatistics {
  maxAbs: number;
  minDelta: number;
  maxDelta: number;
  /** Sampled-grid trapezoidal estimates, not hydraulic sediment budgets. */
  cutVolumeM3: number;
  fillVolumeM3: number;
}

export interface DifferenceMapResult extends DifferenceStatistics {
  pixels: Uint8ClampedArray;
  resolution: number;
}

const clamp = (x: number) => Math.max(0, Math.min(1, x));

function sample(values: Float32Array, n: number, u: number, v: number): number {
  const x = clamp(u) * (n - 1), y = clamp(v) * (n - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(n - 1, x0 + 1), y1 = Math.min(n - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const a = values[y0 * n + x0] * (1 - fx) + values[y0 * n + x1] * fx;
  const b = values[y1 * n + x0] * (1 - fx) + values[y1 * n + x1] * fx;
  return a * (1 - fy) + b * fy;
}

export function buildDifferenceMap(input: DifferenceMapInput): DifferenceMapResult {
  const {
    current, baseline, currentSize, baselineSize,
    currentScale, baselineScale, outputSize: n, worldSize,
  } = input;
  if (![currentSize, baselineSize, n].every(x => Number.isInteger(x) && x >= 2) ||
      n > 512 || current.length !== currentSize * currentSize ||
      baseline.length !== baselineSize * baselineSize ||
      ![currentScale, baselineScale, worldSize].every(x => Number.isFinite(x) && x > 0)) {
    throw new Error('Comparison requires aligned square fields and positive physical dimensions.');
  }
  const differences = new Float32Array(n * n);
  const cellArea = (worldSize / (n - 1)) ** 2;
  let maxAbs = 0, minDelta = Infinity, maxDelta = -Infinity;
  let cutVolumeM3 = 0, fillVolumeM3 = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = x / (n - 1), v = y / (n - 1);
    const diff = sample(current, currentSize, u, v) * currentScale -
      sample(baseline, baselineSize, u, v) * baselineScale;
    differences[y * n + x] = diff;
    maxAbs = Math.max(maxAbs, Math.abs(diff));
    minDelta = Math.min(minDelta, diff);
    maxDelta = Math.max(maxDelta, diff);
    // Trapezoidal integration avoids counting boundary samples as full cells.
    const edgeWeight = (x === 0 || x === n - 1 ? 0.5 : 1) *
      (y === 0 || y === n - 1 ? 0.5 : 1);
    const volume = diff * cellArea * edgeWeight;
    if (volume < 0) cutVolumeM3 -= volume;
    else fillVolumeM3 += volume;
  }
  const pixels = new Uint8ClampedArray(n * n * 4);
  const scale = Math.max(maxAbs, 0.00001);
  for (let i = 0; i < differences.length; i++) {
    // Perceptual sqrt mapping reveals small changes. The legend must not
    // imply that color intensity is linearly proportional to elevation.
    const t = Math.sqrt(Math.min(1, Math.abs(differences[i]) / scale));
    const positive = differences[i] >= 0;
    const r = positive ? 44 : 166, g = positive ? 132 : 76, b = positive ? 162 : 53;
    pixels[i * 4] = Math.round(39 * (1 - t) + r * t);
    pixels[i * 4 + 1] = Math.round(53 * (1 - t) + g * t);
    pixels[i * 4 + 2] = Math.round(48 * (1 - t) + b * t);
    pixels[i * 4 + 3] = 255;
  }
  return { pixels, resolution: n, maxAbs, minDelta, maxDelta, cutVolumeM3, fillVolumeM3 };
}
