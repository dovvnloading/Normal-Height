import type { WorldRegionResult } from '../world';
import { canonical } from '../plan/graph';

/** Change whenever world sampling or the stored field contract changes. */
export const WORLD_REGION_CACHE_VERSION = 'world-region-cpu-2';
export const REGION_CHANNELS = ['heights', 'flow', 'wear', 'deposition'] as const;
const encoder = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

function metadata(result: WorldRegionResult) {
  return {
    width: result.width,
    height: result.height,
    min: result.min,
    max: result.max,
    spacingX: result.spacingX,
    spacingZ: result.spacingZ,
    duration: result.duration,
    backend: result.backend,
    estimatedPeakBytes: result.estimatedPeakBytes,
    stages: result.stages.map((stage) => ({
      nodeId: stage.nodeId,
      label: stage.label,
      kind: stage.kind,
      scope: stage.scope,
      mode: stage.mode,
      backend: stage.backend,
      algorithmVersion: stage.algorithmVersion,
      samplesX: stage.samplesX,
      samplesZ: stage.samplesZ,
      spacingX: stage.spacingX,
      spacingZ: stage.spacingZ,
      simulationResolution: stage.simulationResolution,
      reason: stage.reason,
    })),
    transportBudget: result.transportBudget,
  };
}

/** Persist the declared contract only; never retain hidden solver scratch fields. */
export function snapshotRegion(result: WorldRegionResult): WorldRegionResult {
  return structuredClone({
    ...metadata(result),
    heights: result.heights,
    flow: result.flow,
    wear: result.wear,
    deposition: result.deposition,
  });
}

/** CRC32 covers metadata and every semantic channel, including shared arrays. */
export function regionChecksum(result: WorldRegionResult): string {
  let crc = 0xffffffff;
  const feed = (bytes: Uint8Array) => {
    for (let index = 0; index < bytes.length; index++)
      crc = crcTable[(crc ^ bytes[index]) & 255] ^ (crc >>> 8);
  };
  feed(encoder.encode(canonical(metadata(result))));
  for (const channel of REGION_CHANNELS) {
    const array = result[channel];
    feed(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

/** Includes retained backing buffers, serialized metadata/key, and record overhead. */
export function regionBytes(key: string, result: WorldRegionResult): number {
  const buffers = new Set(REGION_CHANNELS.map((channel) => result[channel].buffer));
  return (
    [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0) +
    encoder.encode(canonical(metadata(result))).byteLength +
    encoder.encode(key).byteLength +
    512
  );
}

export function validRegion(value: unknown): value is WorldRegionResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as WorldRegionResult;
  if (
    result.backend !== 'cpu-reference' ||
    !Number.isSafeInteger(result.width) ||
    !Number.isSafeInteger(result.height) ||
    result.width < 1 ||
    result.height < 1 ||
    result.width * result.height > 8192 * 8192 ||
    !Array.isArray(result.stages) ||
    result.stages.length > 257 ||
    ![
      result.min,
      result.max,
      result.spacingX,
      result.spacingZ,
      result.duration,
      result.estimatedPeakBytes,
    ].every(Number.isFinite) ||
    result.min > result.max ||
    result.spacingX <= 0 ||
    result.spacingZ <= 0 ||
    result.duration < 0 ||
    result.estimatedPeakBytes < 0
  )
    return false;
  if (
    result.transportBudget !== undefined &&
    (!result.transportBudget ||
      typeof result.transportBudget !== 'object' ||
      !Object.values(result.transportBudget).every(
        (value) => typeof value === 'number' && Number.isFinite(value),
      ))
  )
    return false;
  if (
    !result.stages.every(
      (stage) =>
        stage &&
        typeof stage === 'object' &&
        stage.backend === 'cpu-reference' &&
        typeof stage.nodeId === 'string' &&
        typeof stage.label === 'string' &&
        typeof stage.reason === 'string' &&
        typeof stage.kind === 'string' &&
        typeof stage.algorithmVersion === 'string' &&
        ['pointwise', 'local', 'global', 'iterative'].includes(stage.scope) &&
        ['native', 'global-reference', 'reconstructed'].includes(stage.mode) &&
        Number.isSafeInteger(stage.samplesX) &&
        stage.samplesX >= 1 &&
        Number.isSafeInteger(stage.samplesZ) &&
        stage.samplesZ >= 1 &&
        Number.isFinite(stage.spacingX) &&
        stage.spacingX > 0 &&
        Number.isFinite(stage.spacingZ) &&
        stage.spacingZ > 0 &&
        (stage.simulationResolution === null ||
          (Number.isSafeInteger(stage.simulationResolution) && stage.simulationResolution >= 1)),
    )
  )
    return false;
  const size = result.width * result.height;
  for (const channel of REGION_CHANNELS) {
    const array = result[channel];
    if (!(array instanceof Float32Array) || array.length !== size) return false;
    for (const value of array) if (!Number.isFinite(value)) return false;
  }
  return true;
}
