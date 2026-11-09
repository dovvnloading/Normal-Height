import { Noise } from '../engine/noise';
import type { HeightField, TerrainProject } from '../model/types';

export type SurfaceBiome = 'alpine' | 'arid' | 'volcanic';
export interface SurfaceSettings {
  biome: SurfaceBiome;
  snowLine: number;
  rockSlope: number;
  moisture: number;
  detailMeters: number;
  detailStrength: number;
  aoStrength: number;
}
export const DEFAULT_SURFACE: SurfaceSettings = {
  biome: 'alpine',
  snowLine: 0.73,
  rockSlope: 38,
  moisture: 0.52,
  detailMeters: 24,
  detailStrength: 0.65,
  aoStrength: 0.7,
};
export const SURFACE_LIMITS = {
  snowLine: [0.35, 1] as const,
  rockSlope: [12, 75] as const,
  moisture: [0, 1] as const,
  detailMeters: [4, 200] as const,
  detailStrength: [0, 2] as const,
  aoStrength: [0, 1] as const,
};
export function resolveSurface(settings?: Partial<SurfaceSettings>): SurfaceSettings {
  return { ...DEFAULT_SURFACE, ...settings };
}

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / Math.max(1e-8, b - a));
  return t * t * (3 - 2 * t);
};

export type PBRChannel =
  | 'basecolor'
  | 'roughness'
  | 'ao'
  | 'metallic'
  | 'orm'
  | 'splat'
  | 'curvature'
  | 'normal'
  | 'detailNormal';

export interface PBRMaps {
  resolution: number;
  basecolor: Uint8ClampedArray;
  splat: Uint8ClampedArray;
  roughness: Uint8Array;
  ao: Uint8Array;
  curvature: Uint8Array;
  /** Micro displacement in physical meters; does not change the terrain geometry. */
  detail: Float32Array;
}

/** The four splat channels are always Rock / Soil / Vegetation / Snow. */
export const SPLAT_LAYERS = ['rock', 'soil', 'vegetation', 'snow'] as const;

// sRGB reference palettes. The actual surface color is unlit (not baked with AO).
const PALETTES: Record<SurfaceBiome, readonly (readonly number[])[]> = {
  alpine: [
    [122, 118, 108], // exposed rock
    [118, 100, 78], // sediment / soil
    [83, 106, 68], // vegetation
    [224, 231, 232], // snow
  ],
  arid: [
    [154, 119, 86],
    [191, 151, 102],
    [110, 111, 70],
    [231, 210, 161],
  ],
  volcanic: [
    [68, 67, 68],
    [102, 81, 75],
    [77, 88, 71],
    [219, 225, 228],
  ],
};

function neighbor(values: Float32Array, n: number, x: number, y: number): number {
  return values[clamp(y, 0, n - 1) * n + clamp(x, 0, n - 1)];
}

/**
 * Deterministic terrain material synthesis. Uses geological evidence from the
 * simulation rather than guessing material identity from elevation alone.
 * Work is linear in pixel count and no diagnostic is modified in place.
 */
export function generatePBR(field: HeightField, project: TerrainProject): PBRMaps {
  const n = field.resolution;
  const count = n * n;
  if (n < 2 || field.height.length !== count ||
      field.flow.length !== count || field.wear.length !== count ||
      field.deposition.length !== count) {
    throw new Error('PBR generation requires aligned height and erosion fields.');
  }
  const params = resolveSurface(project.surface);
  const basecolor = new Uint8ClampedArray(count * 4);
  const splat = new Uint8ClampedArray(count * 4);
  const roughness = new Uint8Array(count);
  const ao = new Uint8Array(count);
  const curvature = new Uint8Array(count);
  const detail = new Float32Array(count);
  const noise = new Noise((project.seed + 0x3b9aca07) >>> 0);
  const palette = PALETTES[params.biome];
  const cell = project.worldSize / (n - 1);
  const physicalSlope = project.heightScale / cell;
  const cycles = Math.min(project.worldSize / params.detailMeters, n / 3);
  let min = Infinity, max = -Infinity;
  for (const h of field.height) {
    if (!Number.isFinite(h)) throw new Error('Invalid terrain elevation for PBR synthesis.');
    min = Math.min(min, h);
    max = Math.max(max, h);
  }
  const span = Math.max(1e-8, max - min);
  for (let y = 0; y < n; y++) {
    const v = y / (n - 1);
    for (let x = 0; x < n; x++) {
      const u = x / (n - 1);
      const i = y * n + x, p = i * 4;
      const h = field.height[i];
      const left = neighbor(field.height, n, x - 1, y);
      const right = neighbor(field.height, n, x + 1, y);
      const top = neighbor(field.height, n, x, y - 1);
      const bottom = neighbor(field.height, n, x, y + 1);
      const gx = (right - left) / (x > 0 && x < n - 1 ? 2 : 1);
      const gy = (bottom - top) / (y > 0 && y < n - 1 ? 2 : 1);
      const slope = Math.atan(Math.hypot(gx, gy) * physicalSlope) * 180 / Math.PI;
      const height01 = (h - min) / span;
      const macro = noise.simplex(u * 17.1 + 3.9, v * 17.1 - 7.2);
      const grain = noise.simplex(u * cycles + 11.3, v * cycles - 5.7);
      const fine = noise.simplex(u * Math.min(cycles * 2.1, n / 2.5) - 21.1,
        v * Math.min(cycles * 2.1, n / 2.5) + 8.2);
      const grit = grain * 0.76 + fine * 0.24;
      detail[i] = grit * params.detailStrength * 1.4;
      const flow = clamp(field.flow[i]);
      // These are erosion diagnostics, not calibrated moisture/sediment measurements.
      const deposited = smooth(0, 0.016, field.deposition[i]);
      const worn = smooth(0, 0.016, field.wear[i]);
      const wet = clamp(params.moisture * (flow * 0.65 + deposited * 0.22));
      const exposed = smooth(params.rockSlope - 11, params.rockSlope + 8,
        slope + macro * 3 + worn * 7);
      const snow = params.biome === 'alpine' || params.biome === 'volcanic'
        ? smooth(params.snowLine - 0.1, params.snowLine + 0.08,
            height01 + macro * 0.025) * (1 - exposed * 0.64)
        : 0;
      const vegetation = (params.biome === 'arid' ? 0.22 : params.biome === 'volcanic' ? 0.44 : 1)
        * smooth(0.02, 0.23, height01) * (1 - smooth(0.58, 0.88, height01))
        * (1 - exposed) * (0.24 + params.moisture * 0.92)
        * (1 - snow) * (1 - wet * 0.28);
      const rock = (0.14 + exposed * 2.9 + worn * 0.42) * (1 - snow);
      const soil = (0.34 + deposited * 0.85 + wet * 0.23 + (1 - height01) * 0.15)
        * (1 - exposed * 0.6) * (1 - snow);
      const snowWeight = snow * 3.5;
      const weightSum = Math.max(1e-9, rock + soil + vegetation + snowWeight);
      const weights = [rock, soil, vegetation, snowWeight].map(w => w / weightSum);
      const r = Math.round(weights[0] * 255);
      const g = Math.round(weights[1] * 255);
      const b = Math.min(255 - r - g, Math.round(weights[2] * 255));
      splat[p] = r;
      splat[p + 1] = g;
      splat[p + 2] = b;
      splat[p + 3] = 255 - r - g - b;

      for (let channel = 0; channel < 3; channel++) {
        let c = 0;
        for (let layer = 0; layer < 4; layer++) c += palette[layer][channel] * weights[layer];
        const tint = 1 + macro * 0.075 + grit * (channel === 1 ? 0.095 : 0.07);
        // Water darkens base color, but indirect lighting must not be baked into albedo.
        basecolor[p + channel] = clamp(c * tint * (1 - wet * 0.22), 0, 255);
      }
      basecolor[p + 3] = 255;
      const layerRoughness = [0.88, 0.94, 0.86, 0.76];
      let rough = 0;
      for (let layer = 0; layer < 4; layer++) rough += layerRoughness[layer] * weights[layer];
      roughness[i] = Math.round(clamp(rough + grain * 0.045 - wet * 0.32, 0.25, 1) * 255);

      // Plane-corrected, multi-radius local horizon approximation: a uniformly
      // sloping plane should have no self-occlusion, but a concavity should.
      let horizon = 0;
      const radii = [2, 6, 17];
      for (const radius of radii) {
        for (const [ox, oy] of [[radius, 0], [-radius, 0], [0, radius], [0, -radius]]) {
          const elevation = neighbor(field.height, n, x + ox, y + oy);
          const rise = (elevation - h - gx * ox - gy * oy) * physicalSlope / radius;
          horizon += clamp(rise * 1.8, 0, 1);
        }
      }
      ao[i] = Math.round(255 * clamp(1 - params.aoStrength * horizon / 12 * 2.2, 0.45, 1));
      const laplace = h - (left + right + top + bottom) * 0.25;
      curvature[i] = Math.round(clamp(0.5 + laplace * physicalSlope * 1.8) * 255);
    }
  }
  return { resolution: n, basecolor, splat, roughness, ao, curvature, detail };
}

function grayscale(values: Uint8Array): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(values.length * 4);
  for (let i = 0; i < values.length; i++) {
    const p = i * 4;
    rgba[p] = rgba[p + 1] = rgba[p + 2] = values[i];
    rgba[p + 3] = 255;
  }
  return rgba;
}

/** OpenGL (+Y) normals by default. DX output flips ONLY the green channel. */
export function materialNormalPixels(
  maps: PBRMaps,
  field: HeightField,
  project: TerrainProject,
  detailOnly = false,
  directX = false,
): Uint8ClampedArray {
  const n = maps.resolution;
  const pixels = new Uint8ClampedArray(n * n * 4);
  const cell = project.worldSize / Math.max(1, n - 1);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const l = Math.max(0, x - 1), r = Math.min(n - 1, x + 1);
      const t = Math.max(0, y - 1), b = Math.min(n - 1, y + 1);
      const dx = (maps.detail[y * n + r] - maps.detail[y * n + l] +
        (detailOnly ? 0 : (field.height[y * n + r] - field.height[y * n + l]) * project.heightScale)) /
        ((r - l || 1) * cell);
      const dy = (maps.detail[b * n + x] - maps.detail[t * n + x] +
        (detailOnly ? 0 : (field.height[b * n + x] - field.height[t * n + x]) * project.heightScale)) /
        ((b - t || 1) * cell);
      const length = Math.hypot(dx, dy, 1);
      const p = (y * n + x) * 4;
      pixels[p] = Math.round((-dx / length * 0.5 + 0.5) * 255);
      pixels[p + 1] = Math.round(((directX ? -dy : dy) / length * 0.5 + 0.5) * 255);
      pixels[p + 2] = Math.round((1 / length * 0.5 + 0.5) * 255);
      pixels[p + 3] = 255;
    }
  }
  return pixels;
}

export function pbrPixels(
  maps: PBRMaps,
  field: HeightField,
  project: TerrainProject,
  channel: PBRChannel,
  directX = false,
): Uint8ClampedArray {
  if (channel === 'basecolor') return maps.basecolor;
  if (channel === 'splat') return maps.splat;
  if (channel === 'normal') return materialNormalPixels(maps, field, project, false, directX);
  if (channel === 'detailNormal') return materialNormalPixels(maps, field, project, true, directX);
  if (channel === 'roughness') return grayscale(maps.roughness);
  if (channel === 'ao') return grayscale(maps.ao);
  if (channel === 'curvature') return grayscale(maps.curvature);
  const pixels = new Uint8ClampedArray(maps.resolution * maps.resolution * 4);
  for (let i = 0; i < maps.resolution * maps.resolution; i++) {
    const p = i * 4;
    if (channel === 'orm') {
      pixels[p] = maps.ao[i];
      pixels[p + 1] = maps.roughness[i];
    }
    pixels[p + 3] = 255;
  }
  return pixels; // metallic is black for all supported geological materials
}
