/**
 * Conservative allocation model for PBR export: source height/diagnostics,
 * synthesis arrays, the active RGBA + scanline buffers, PNG files, ZIP output,
 * structured-clone overhead and a fixed codec/runtime allowance.
 *
 * This is a preflight estimate, NOT a guarantee about browser peak memory.
 * Device memory is an approximate browser hint; never infer available RAM.
 */
const MiB = 1024 * 1024;
export function estimatePBRPeakMiB(resolution: number): number {
  if (!Number.isInteger(resolution) || resolution < 2 || resolution > 8192)
    throw new Error('Invalid PBR export resolution.');
  return Math.ceil((64 * MiB + resolution * resolution * 150) / MiB);
}

/** Unknown-memory browsers get a conservative budget; 2K needs a strong device hint. */
export function pbrBudgetMiB(deviceMemoryGiB?: number): number {
  if (!deviceMemoryGiB || !Number.isFinite(deviceMemoryGiB)) return 512;
  return Math.max(320, Math.min(1280, Math.floor(deviceMemoryGiB * 1024 * 0.16)));
}
export function checkPBRExportBudget(resolution: number, budgetMiB: number): void {
  const estimate = estimatePBRPeakMiB(resolution);
  if (!Number.isFinite(budgetMiB) || budgetMiB <= 0 || estimate > budgetMiB)
    throw new Error(
      `PBR ${resolution}² export is estimated to need ~${estimate} MiB of temporary memory, ` +
      `above the ${Math.round(budgetMiB)} MiB device budget. Choose a smaller resolution ` +
      'or use a device with more memory. No terrain data was changed.',
    );
}
