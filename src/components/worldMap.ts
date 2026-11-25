import type { WorldRegionResult } from '../engine/world';

export type WorldMapChannel = 'relief' | 'height' | 'flow' | 'wear' | 'deposition';
const ramp = [
  [0, 37, 65, 59],
  [0.2, 74, 99, 76],
  [0.43, 133, 145, 101],
  [0.66, 183, 172, 129],
  [0.82, 207, 202, 178],
  [1, 239, 240, 226],
];

/** Render the actual sampled field; no synthetic detail or image assets. */
export function paintWorldMap(
  canvas: HTMLCanvasElement,
  field: WorldRegionResult,
  channel: WorldMapChannel,
  heightScale: number,
) {
  canvas.width = field.width;
  canvas.height = field.height;
  const context = canvas.getContext('2d');
  if (!context) return;
  const pixels = context.createImageData(field.width, field.height);
  const span = Math.max(1e-8, field.max - field.min);
  const data =
    channel === 'flow'
      ? field.flow
      : channel === 'wear'
        ? field.wear
        : channel === 'deposition'
          ? field.deposition
          : field.heights;
  let maxDiagnostic = 1e-8;
  if (channel !== 'relief' && channel !== 'height')
    for (const v of data) maxDiagnostic = Math.max(maxDiagnostic, v);
  const sample = (x: number, z: number) =>
    field.heights[
      Math.max(0, Math.min(field.height - 1, z)) * field.width +
        Math.max(0, Math.min(field.width - 1, x))
    ];
  for (let z = 0; z < field.height; z++)
    for (let x = 0; x < field.width; x++) {
      const i = z * field.width + x;
      const value = Math.max(0, Math.min(1, (field.heights[i] - field.min) / span));
      let rgb: number[];
      if (channel === 'height') rgb = [value * 255, value * 255, value * 255];
      else if (channel !== 'relief') {
        const v =
          channel === 'flow'
            ? Math.log1p(Math.max(0, data[i]) * 80) / Math.log1p(maxDiagnostic * 80)
            : Math.max(0, data[i]) / maxDiagnostic;
        rgb =
          channel === 'flow'
            ? [27 + 112 * v, 49 + 165 * v, 57 + 179 * v]
            : channel === 'wear'
              ? [51 + 195 * v, 42 + 124 * v, 34 + 72 * v]
              : [31 + 133 * v, 50 + 170 * v, 43 + 117 * v];
      } else {
        const upper = Math.max(
          1,
          ramp.findIndex((stop) => stop[0] >= value),
        );
        const a = ramp[upper - 1],
          b = ramp[upper];
        const f = (value - a[0]) / (b[0] - a[0]);
        const dx =
          ((sample(x + 1, z) - sample(x - 1, z)) * heightScale) /
          Math.max(0.001, field.spacingX * (x === 0 || x === field.width - 1 ? 1 : 2));
        const dz =
          ((sample(x, z + 1) - sample(x, z - 1)) * heightScale) /
          Math.max(0.001, field.spacingZ * (z === 0 || z === field.height - 1 ? 1 : 2));
        const light = Math.max(0, (-dx * -0.58 + 0.69 - dz * -0.43) / Math.hypot(dx, 1, dz));
        const shade = 0.53 + 0.57 * light;
        rgb = [1, 2, 3].map((k) => (a[k] + (b[k] - a[k]) * f) * shade);
      }
      pixels.data[i * 4] = Math.max(0, Math.min(255, rgb[0]));
      pixels.data[i * 4 + 1] = Math.max(0, Math.min(255, rgb[1]));
      pixels.data[i * 4 + 2] = Math.max(0, Math.min(255, rgb[2]));
      pixels.data[i * 4 + 3] = 255;
    }
  context.putImageData(pixels, 0, 0);
}
