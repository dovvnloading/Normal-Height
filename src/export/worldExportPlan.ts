import { describeWorldGraph } from '../engine/world/capabilities';
import {
  checkWorldExportBudget,
  estimateWorldExport,
  type WorldExportEstimate,
  type WorldExportOptions,
  type WorldExportProfile,
} from './worldExport';

export const WORLD_DOWNLOAD_LIMIT_BYTES = 192 * 1048576;
export const WORLD_EXPORT_SAMPLE_PRESETS: Record<WorldExportProfile, readonly number[]> = {
  generic: [256, 512, 1024, 2048, 4096, 8192],
  unreal: [127, 253, 505, 1009, 2017, 4033, 8129],
  unity: [257, 513, 1025, 2049, 4097, 8193],
};

export interface WorldExportSinkPlan {
  estimate: WorldExportEstimate | null;
  error: string | null;
  /** The largest smaller preset that passes this sink's actual budget guard. */
  smallerSamples: number | null;
}

export interface WorldDeliveryPlan {
  memory: WorldExportSinkPlan;
  file: WorldExportSinkPlan;
  widthMeters: number;
  depthMeters: number;
  spacingX: number;
  spacingZ: number;
  mapCount: number;
  files: number;
  referenceSpacing: [number, number] | null;
  warnings: string[];
}

/** Profiles have exact sample counts. Generic Z follows the physical footprint. */
export function worldExportSamplesZ(
  options: Pick<WorldExportOptions, 'world' | 'region' | 'profile'>,
  samplesX: number,
): number {
  if (options.profile !== 'generic') return samplesX;
  const d = options.world.domain;
  const width = (d.width * (options.region?.cellsX ?? d.cellsX)) / d.cellsX;
  const depth = (d.depth * (options.region?.cellsZ ?? d.cellsZ)) / d.cellsZ;
  return Math.max(16, Math.min(8192, Math.round(((samplesX - 1) * depth) / width) + 1));
}

/** All capability and budget checks happen before a picker or worker is opened. */
export function preflightWorldExport(options: WorldExportOptions): WorldExportEstimate {
  const estimate = estimateWorldExport(options);
  const { capability } = describeWorldGraph(options.project, options.world);
  if (!capability.supported)
    throw new Error(capability.reason || 'This graph cannot be exported as a world.');
  for (const mask of options.masks ?? []) {
    const { capability: maskCapability } = describeWorldGraph(
      options.project,
      options.world,
      mask.nodeId,
    );
    if (!maskCapability.supported)
      throw new Error(
        `${mask.name}: ${maskCapability.reason || 'This mask cannot be evaluated in world coordinates.'}`,
      );
  }
  checkWorldExportBudget(options);
  if (options.sink !== 'file' && estimate.archiveBytes > WORLD_DOWNLOAD_LIMIT_BYTES)
    throw new Error(
      'The archive exceeds the 192 MiB browser download budget. Save directly to file, reduce samples, or export a smaller region.',
    );
  return estimate;
}

export function planWorldExport(options: WorldExportOptions): WorldDeliveryPlan {
  const d = options.world.domain;
  const widthMeters = (d.width * (options.region?.cellsX ?? d.cellsX)) / d.cellsX;
  const depthMeters = (d.depth * (options.region?.cellsZ ?? d.cellsZ)) / d.cellsZ;
  const maps = new Set([
    'height',
    ...(options.maps ?? []),
    ...(options.diagnostics ? ['flow', 'wear', 'deposition', 'slope'] : []),
    ...(options.normals ? ['normalGL'] : []),
  ]);
  const mapCount = maps.size + (options.masks?.length ?? 0);
  const sinkPlan = (sink: 'memory' | 'file'): WorldExportSinkPlan => {
    const value = { ...options, sink };
    let estimate: WorldExportEstimate | null = null;
    try {
      estimate = estimateWorldExport(value);
      preflightWorldExport(value);
      return { estimate, error: null, smallerSamples: null };
    } catch (error) {
      let smallerSamples: number | null = null;
      for (const samplesX of [...WORLD_EXPORT_SAMPLE_PRESETS[options.profile]].reverse()) {
        if (samplesX >= options.samplesX) continue;
        try {
          preflightWorldExport({
            ...value,
            samplesX,
            samplesZ: worldExportSamplesZ(value, samplesX),
          });
          smallerSamples = samplesX;
          break;
        } catch {
          /* A smaller grid must pass the same guard as execution. */
        }
      }
      return {
        estimate,
        error: error instanceof Error ? error.message : 'Invalid world export settings.',
        smallerSamples,
      };
    }
  };
  const memory = sinkPlan('memory');
  const file = sinkPlan('file');
  let referenceSpacing: [number, number] | null = null;
  let warnings: string[] = [];
  try {
    const { stages, capability } = describeWorldGraph(options.project, options.world);
    const global = stages.filter((stage) => stage.mode !== 'native');
    if (global.length)
      referenceSpacing = [
        Math.max(...global.map((stage) => stage.spacingX)),
        Math.max(...global.map((stage) => stage.spacingZ)),
      ];
    warnings = capability.warnings;
  } catch {
    /* The sink plans already carry the actionable validation error. */
  }
  return {
    memory,
    file,
    widthMeters,
    depthMeters,
    spacingX: widthMeters / (options.samplesX - 1),
    spacingZ: depthMeters / (options.samplesZ - 1),
    mapCount,
    files: (memory.estimate?.tileCount ?? file.estimate?.tileCount ?? 0) * mapCount + 3,
    referenceSpacing,
    warnings,
  };
}
