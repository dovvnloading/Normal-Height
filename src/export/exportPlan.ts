import type { ExportFormat } from './heightmap';
import { estimatePBRPeakMiB, isPBRExportFormat, pbrBudgetMiB } from './budget';

export const EXPORT_RESOLUTIONS = [256, 512, 768, 1024, 2048] as const;

const descriptions: Record<ExportFormat, string> = {
  png16: '16-bit grayscale normalized to the actual elevation range. Keep the metadata to reconstruct elevation in meters.',
  raw32: 'Headerless, little-endian Float32 elevation in meters. No normalization or quantization to integer levels.',
  mask16: '16-bit linear grayscale weights. Black is zero, white is one; the mask is not normalized to its own range.',
  normal: 'Terrain-only tangent-space normals, OpenGL +Y. Uses physical dimensions, not viewport exaggeration.',
  flow: 'Colorized flow visualization, not raw flow accumulation or water depth.',
  wear: 'Colorized erosion wear visualization, not a physical sediment-depth raster.',
  deposition: 'Colorized deposition visualization, not a physical sediment-depth raster.',
  detailTiles: 'Four seamless substrate sets for the active biome: albedo, 16-bit local relief, GL/DX normals, roughness and ORM. Independent of terrain extent; repeat at the supplied meter scale.',
  pbr: '13 maps: height and relief (16-bit), base color, OpenGL and DirectX normals, micro-normal, roughness, AO, metallic, ORM, Unity HDRP mask, layer weights and curvature. Includes project and metadata.',
  basecolor: 'sRGB material color without lighting or ambient occlusion baked in.',
  roughness: 'Linear data: black is smooth, white is rough.',
  ao: 'Linear ambient occlusion: black is occluded, white is unoccluded.',
  metallic: 'Linear metallic data. The current terrain materials are dielectric (zero metallic).',
  orm: 'Linear packed glTF-style data: R = occlusion, G = roughness, B = metallic.',
  splat: 'Linear RGBA layer weights: rock, soil, vegetation and snow.',
  curvature: 'Linear material curvature visualization. Not an elevation or slope map.',
  normalGL: 'OpenGL +Y tangent-space normals including terrain and material microdetail.',
  detailNormal: 'OpenGL +Y microdetail only; use with displaced terrain to avoid doubling geometry normals.',
  normalDX: 'DirectX −Y tangent-space normals including terrain and microdetail; green is inverted relative to OpenGL.',
};

export function exportDescription(format: ExportFormat): string {
  return descriptions[format];
}

/** Decoded pixel payload, excluding PNG compression, metadata and ZIP overhead.
 * Complete PBR contains eleven RGBA8 and two grayscale16 maps.
 */
export function mapPayloadBytes(format: ExportFormat, resolution: number): number {
  const bytesPerPixel = format === 'detailTiles' ? 88 : format === 'pbr' ? 48 : format === 'png16' || format === 'mask16' ? 2 : 4;
  return resolution * resolution * bytesPerPixel;
}

export function formatExportSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KiB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function pbrPreflight(
  format: ExportFormat,
  resolution: number,
  bundle: boolean,
  deviceMemoryGiB?: number,
) {
  if (!isPBRExportFormat(format)) return null;
  const budget = pbrBudgetMiB(deviceMemoryGiB);
  const estimate = estimatePBRPeakMiB(resolution, format, bundle);
  const suggested = [...EXPORT_RESOLUTIONS].reverse().find(
    (size) => size < resolution && estimatePBRPeakMiB(size, format, bundle) <= budget,
  );
  return { budget, estimate, overBudget: estimate > budget, suggested };
}
