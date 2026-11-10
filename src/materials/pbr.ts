import { synthesizeMaterials } from './layerSynthesis';
export { AO_RADII_METERS } from './terrainAnalysis';
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
  /** Physical vertical separation of geological bedding planes, in meters. */
  strataMeters: number;
  /** Physical lateral spacing of coherent exposed-rock fractures, in meters. */
  fractureMeters: number;
}
export const DEFAULT_SURFACE: SurfaceSettings = {
  biome: 'alpine',
  snowLine: 0.73,
  rockSlope: 38,
  moisture: 0.52,
  detailMeters: 24,
  detailStrength: 0.65,
  aoStrength: 0.7,
  strataMeters: 76,
  fractureMeters: 68,
};
export const SURFACE_LIMITS = {
  snowLine: [0.35, 1] as const,
  rockSlope: [12, 75] as const,
  moisture: [0, 1] as const,
  detailMeters: [4, 200] as const,
  detailStrength: [0, 2] as const,
  aoStrength: [0, 1] as const,
  strataMeters: [12, 500] as const,
  fractureMeters: [12, 320] as const,
};
export function resolveSurface(settings?: Partial<SurfaceSettings>): SurfaceSettings {
  return { ...DEFAULT_SURFACE, ...settings };
}

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

export type PBRChannel =
  | 'basecolor'
  | 'roughness'
  | 'ao'
  | 'metallic'
  | 'orm'
  | 'unityMask'
  | 'splat'
  | 'curvature'
  | 'normal'
  | 'detailNormal'
  | 'rockWeight' | 'soilWeight' | 'vegetationWeight' | 'snowWeight';

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

// Palette entries are encoded sRGB, but albedo must be interpolated in linear light.
export function srgbByteToLinear(value: number): number {
  const c = clamp(value, 0, 255) / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
export function linearToSrgbByte(value: number): number {
  const c = clamp(value);
  return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055));
}
const LINEAR_PALETTES: Record<SurfaceBiome, number[][]> = {
  alpine: PALETTES.alpine.map((layer) => layer.map(srgbByteToLinear)),
  arid: PALETTES.arid.map((layer) => layer.map(srgbByteToLinear)),
  volcanic: PALETTES.volcanic.map((layer) => layer.map(srgbByteToLinear)),
};

/**
 * Shared preview/export entrypoint. Physical terrain analysis and material
 * microstructure live in independent modules; map encoding remains unchanged.
 */
export function generatePBR(field: HeightField, project: TerrainProject): PBRMaps {
  const params = resolveSurface(project.surface);
  return synthesizeMaterials(
    field, project, params, LINEAR_PALETTES[params.biome], linearToSrgbByte,
  );
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
      const green = Math.round((dy / length * 0.5 + 0.5) * 255);
      pixels[p + 1] = directX ? 255 - green : green;
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
  // Inspect individual physically synthesized coverage masks as opaque grayscale
  // percentages. These are derived from the exact exported RGBA splat bytes.
  const weightIndex = channel === 'rockWeight' ? 0 :
    channel === 'soilWeight' ? 1 : channel === 'vegetationWeight' ? 2 :
    channel === 'snowWeight' ? 3 : -1;
  if (weightIndex >= 0) {
    const out = new Uint8ClampedArray(maps.resolution * maps.resolution * 4);
    for (let i = 0; i < maps.resolution * maps.resolution; i++) {
      const p = i * 4;
      const weight = maps.splat[p + weightIndex];
      out[p] = out[p + 1] = out[p + 2] = weight;
      out[p + 3] = 255;
    }
    return out;
  }
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
      pixels[p + 3] = 255;
    } else if (channel === 'unityMask') {
      pixels[p + 1] = maps.ao[i];
      pixels[p + 2] = 255; // full detail-mask weight; no authored detail mask yet
      pixels[p + 3] = 255 - maps.roughness[i]; // smoothness
    } else pixels[p + 3] = 255;
  }
  return pixels; // metallic is black for all supported geological materials
}
