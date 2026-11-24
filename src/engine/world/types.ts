import type { WorldBackend } from '../../model/world';
import type { WorldMassBudget } from './hydrology';

export interface WorldSampleGrid {
  startX: number;
  startZ: number;
  cellsX: number;
  cellsZ: number;
  samplesX: number;
  samplesZ: number;
  /** Optional exact export grid. Every strip uses the same integer global sample numerator. */
  outputCellsX?: number;
  outputCellsZ?: number;
  outputSampleOffsetX?: number;
  outputSampleOffsetZ?: number;
  outputOriginX?: number;
  outputOriginZ?: number;
  outputExtentX?: number;
  outputExtentZ?: number;
}

export interface WorldStageReport {
  nodeId: string;
  label: string;
  kind: string;
  scope: 'pointwise' | 'local' | 'global' | 'iterative';
  mode: 'native' | 'global-reference' | 'reconstructed';
  backend: Exclude<WorldBackend, 'auto'>;
  algorithmVersion: string;
  samplesX: number;
  samplesZ: number;
  spacingX: number;
  spacingZ: number;
  simulationResolution: number | null;
  reason: string;
}

export interface WorldCapability {
  supported: boolean;
  native: boolean;
  fullGraph: boolean;
  requiresGlobal: boolean;
  warnings: string[];
  reason?: string;
}

export interface WorldRegionResult {
  width: number;
  height: number;
  heights: Float32Array;
  flow: Float32Array;
  wear: Float32Array;
  deposition: Float32Array;
  min: number;
  max: number;
  stages: WorldStageReport[];
  spacingX: number;
  spacingZ: number;
  duration: number;
  backend: 'cpu-reference' | 'webgpu';
  estimatedPeakBytes: number;
  transportBudget?: WorldMassBudget;
}

export interface WorldRunOptions {
  signal?: AbortSignal;
  onProgress?: (progress: number, stage: string) => void;
}
