import type { GENESIS_ALGORITHM_VERSION } from '../../model/genesis';
import type { WorldDrainage } from '../world/hydrology';

export interface GenesisLevelReport {
  width: number;
  height: number;
  spacingX: number;
  spacingZ: number;
  iterations: number;
  durationYears: number;
}

export interface GenesisReport {
  algorithmVersion: typeof GENESIS_ALGORITHM_VERSION;
  mode: 'multiscale-stream-power';
  width: number;
  height: number;
  spacingX: number;
  spacingZ: number;
  levels: GenesisLevelReport[];
  durationYears: number;
  /** Signed tectonic contribution, including the downthrown side of a fault. */
  upliftVolumeM3: number;
  /** Rock removed by the incision operator, not sediment delivered to outlets. */
  incisedVolumeM3: number;
  hillslopeRedistributedVolumeM3: number;
  /** Measured terrain-volume change caused by conservative pair exchanges. */
  hillslopeResidualM3: number;
  /** Change in integrated displacement due to coarse-to-fine reconstruction. */
  reconstructionVolumeM3: number;
  finalVolumeChangeM3: number;
  outletCount: number;
  maxDrainageAreaM2: number;
  drainageAreaResidualM2: number;
  durationMs: number;
  limitations: string[];
}

export interface GenesisResult {
  width: number;
  height: Float64Array;
  /** Row count. `height` is the physical elevation field. */
  rows: number;
  sourceHeight: Float64Array;
  hardness: Float32Array;
  lithology: Uint8Array;
  uplift: Float32Array;
  incision: Float32Array;
  drainageArea: Float32Array;
  channel: Float32Array;
  drainage: WorldDrainage;
  report: GenesisReport;
}

export interface GenesisOptions {
  signal?: AbortSignal;
  onProgress?: (fraction: number, stage: string) => void;
}

/** Input and output elevations are absolute local-Cartesian metres. */
export type GenesisSource = (x: number, z: number, spacingX: number, spacingZ: number) => number;

export interface GenesisGeologySample {
  hardness: number;
  lithology: number;
}
