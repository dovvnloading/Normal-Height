import type { ExportFormat } from './heightmap';

const SINGLE_PBR_FORMATS = [
  'basecolor', 'roughness', 'ao', 'metallic', 'orm', 'splat', 'curvature',
  'normalGL', 'normalDX', 'detailNormal',
] as const;
type SinglePBRFormat = (typeof SINGLE_PBR_FORMATS)[number];
type PBRExportFormat = 'pbr' | SinglePBRFormat;

export function isSinglePBRExportFormat(format: ExportFormat): format is SinglePBRFormat {
  return SINGLE_PBR_FORMATS.some((channel) => channel === format);
}

export function isPBRExportFormat(format: ExportFormat): format is PBRExportFormat {
  return format === 'pbr' || isSinglePBRExportFormat(format);
}

/**
 * Conservative allocation model for PBR export: source height/diagnostics,
 * synthesis arrays, the active RGBA + scanline buffers, PNG files, ZIP output,
 * structured-clone overhead and a fixed codec/runtime allowance.
 *
 * This is a preflight estimate, NOT a guarantee about browser peak memory.
 * Device memory is an approximate browser hint; never infer available RAM.
 */
const MiB = 1024 * 1024;
export function estimatePBRPeakMiB(
  resolution: number,
  format: PBRExportFormat = 'pbr',
  bundle = false,
): number {
  if (!Number.isInteger(resolution) || resolution < 2 || resolution > 8192)
    throw new Error('Invalid PBR export resolution.');
  // Every standalone map currently synthesizes the complete material field.
  // Retain a conservative allowance for the 16 B/pixel terrain, 15 B/pixel
  // material field, overlapping UI/transfer buffers, RGBA, PNG scratch/copies,
  // and runtime allocation headroom. One PNG needs less retained encoding
  // memory than the full ZIP, but still requires the same synthesis workspace.
  const bytesPerPixel = format === 'pbr' ? 156 : bundle ? 132 : 120;
  return Math.ceil((64 * MiB + resolution * resolution * bytesPerPixel) / MiB);
}

/** Unknown-memory browsers get a conservative budget; 2K needs a strong device hint. */
export function pbrBudgetMiB(deviceMemoryGiB?: number): number {
  if (!deviceMemoryGiB || !Number.isFinite(deviceMemoryGiB)) return 512;
  return Math.max(320, Math.min(1280, Math.floor(deviceMemoryGiB * 1024 * 0.16)));
}
export function checkPBRExportBudget(
  resolution: number,
  budgetMiB: number,
  format: PBRExportFormat = 'pbr',
  bundle = false,
): void {
  const estimate = estimatePBRPeakMiB(resolution, format, bundle);
  if (!Number.isFinite(budgetMiB) || budgetMiB <= 0 || estimate > budgetMiB)
    throw new Error(
      `PBR ${resolution}² export is estimated to need ~${estimate} MiB of temporary memory, ` +
      `above the ${Math.round(budgetMiB)} MiB device budget. Choose a smaller resolution ` +
      'or use a device with more memory. No terrain data was changed.',
    );
}
