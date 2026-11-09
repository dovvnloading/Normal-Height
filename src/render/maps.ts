import { Noise } from '../engine/noise';
import type { HeightField, MapChannel } from '../model/types';

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, value: number) => {
  const t = clamp((value - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// Coherent, seeded 2D noise rather than a sine of x/y pixel coordinates.
// A single sine wave created obvious, evenly spaced bands along snow lines.
const alpineDetailNoise = new Noise(0x4e487421);
/** Resolution-independent alpine material variation in normalized tile coordinates. */
export function alpineMaterialVariation(u: number, v: number): number {
  const broad = alpineDetailNoise.simplex(u * 16.7 + 13.2, v * 16.7 - 9.4);
  const fine = alpineDetailNoise.simplex(u * 48.1 - 3.7, v * 48.1 + 21.3);
  return broad * 0.72 + fine * 0.28;
}

/** OpenGL tangent-space normal map: +X right, +Y up, +Z out of the map. */
export function normalMapPixels(
  field: HeightField,
  worldSize: number,
  heightScale: number,
): Uint8ClampedArray {
  const { resolution: n, height } = field;
  const pixels = new Uint8ClampedArray(n * n * 4);
  const cell = worldSize / Math.max(1, n - 1);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const left = Math.max(0, x - 1),
        right = Math.min(n - 1, x + 1);
      const top = Math.max(0, y - 1),
        bottom = Math.min(n - 1, y + 1);
      const dx =
        ((height[y * n + right] - height[y * n + left]) * heightScale) /
        ((right - left || 1) * cell);
      const dy =
        ((height[bottom * n + x] - height[top * n + x]) * heightScale) /
        ((bottom - top || 1) * cell);
      const length = Math.hypot(dx, dy, 1);
      const p = (y * n + x) * 4;
      pixels[p] = ((-dx / length) * 0.5 + 0.5) * 255;
      pixels[p + 1] = ((dy / length) * 0.5 + 0.5) * 255;
      pixels[p + 2] = ((1 / length) * 0.5 + 0.5) * 255;
      pixels[p + 3] = 255;
    }
  }
  return pixels;
}

/** sRGB alpine palette shared by the raster and mesh previews. */
export function terrainColor(
  elevation: number,
  upNormal: number,
  detail = 0,
): [number, number, number] {
  const t = clamp(elevation);
  const low = [69, 85, 67];
  const grass = [111, 121, 89];
  const rock = [155, 149, 134];
  const snow = [231, 237, 233];
  const grassMix = smooth(0.02, 0.38, t);
  const rockMix = Math.max(smooth(0.28, 0.66, t), smooth(0.94, 0.65, upNormal) * 0.87);
  const snowMix = smooth(0.68, 0.88, t + detail * 0.018) * smooth(0.38, 0.76, upNormal);
  return low.map((c, i) =>
    mix(mix(mix(c, grass[i], grassMix), rock[i], rockMix), snow[i], snowMix),
  ) as [number, number, number];
}

export function sampleSlope(
  field: HeightField,
  x: number,
  y: number,
  worldSize: number,
  heightScale: number,
): { dx: number; dy: number; up: number; degrees: number } {
  const n = field.resolution,
    h = field.height;
  const l = Math.max(0, x - 1),
    r = Math.min(n - 1, x + 1),
    u = Math.max(0, y - 1),
    d = Math.min(n - 1, y + 1);
  const cell = worldSize / Math.max(1, n - 1);
  const dx = ((h[y * n + r] - h[y * n + l]) * heightScale) / ((r - l || 1) * cell);
  const dy = ((h[d * n + x] - h[u * n + x]) * heightScale) / ((d - u || 1) * cell);
  return {
    dx,
    dy,
    up: 1 / Math.hypot(dx, dy, 1),
    degrees: (Math.atan(Math.hypot(dx, dy)) * 180) / Math.PI,
  };
}

function ramp(t: number, colors: number[][]): number[] {
  const scaled = clamp(t) * (colors.length - 1),
    index = Math.min(colors.length - 2, Math.floor(scaled));
  return colors[index].map((v, i) => mix(v, colors[index + 1][i], scaled - index));
}

/** True buffer previews. Height uses the fixed [0,1] encoding, diagnostics a log display curve. */
export function colorizeMap(
  field: HeightField,
  channel: MapChannel,
  worldSize: number,
  heightScale: number,
): Uint8ClampedArray {
  if (channel === 'normal') return normalMapPixels(field, worldSize, heightScale);
  const n = field.resolution;
  const pixels = new Uint8ClampedArray(n * n * 4);
  let minHeight = Infinity,
    maxHeight = -Infinity,
    maxDiagnostic = 0;
  const diagnostic =
    channel === 'flow' || channel === 'wear' || channel === 'deposition' ? field[channel] : null;
  for (let i = 0; i < field.height.length; i++) {
    minHeight = Math.min(minHeight, field.height[i]);
    maxHeight = Math.max(maxHeight, field.height[i]);
    if (diagnostic) maxDiagnostic = Math.max(maxDiagnostic, diagnostic[i]);
  }
  const logMax = Math.log1p(maxDiagnostic) || 1;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const h = field.height[i];
      let color: number[];
      if (channel === 'terrain') {
        const s = sampleSlope(field, x, y, worldSize, heightScale);
        const elevation = (h - minHeight) / Math.max(0.00001, maxHeight - minHeight);
        const light = clamp((-s.dx * -0.45 + 1 * 0.8 + -s.dy * -0.38) / Math.hypot(s.dx, 1, s.dy));
        color = terrainColor(
          elevation,
          s.up,
          alpineMaterialVariation(x / Math.max(1, n - 1), y / Math.max(1, n - 1)),
        ).map((v) => v * (0.58 + light * 0.5));
      } else if (channel === 'slope') {
        const s = sampleSlope(field, x, y, worldSize, heightScale);
        color = ramp(s.degrees / 70, [
          [25, 40, 49],
          [73, 126, 122],
          [176, 190, 126],
          [236, 178, 104],
          [207, 91, 61],
        ]);
      } else if (diagnostic) {
        // The evaluator already log-normalizes flow visits. Wear and deposition
        // retain real height deltas and receive only a display transfer here.
        const t =
          channel === 'flow'
            ? clamp(diagnostic[i])
            : Math.log1p(Math.max(0, diagnostic[i])) / logMax;
        color =
          channel === 'flow'
            ? ramp(t, [
                [13, 27, 34],
                [34, 74, 89],
                [67, 143, 164],
                [174, 230, 227],
              ])
            : channel === 'wear'
              ? ramp(t, [
                  [27, 23, 22],
                  [104, 61, 39],
                  [213, 132, 73],
                  [255, 222, 160],
                ])
              : ramp(t, [
                  [20, 25, 23],
                  [45, 87, 63],
                  [110, 173, 112],
                  [220, 235, 166],
                ]);
      } else {
        const gray = clamp(h) * 255;
        color = [gray, gray, gray];
      }
      pixels.set([color[0], color[1], color[2], 255], i * 4);
    }
  return pixels;
}
