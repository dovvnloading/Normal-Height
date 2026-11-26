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
  /** Measured work within the named phase. Fractions are not an ETA. */
  onProgressDetail?: (progress: WorldEvaluationProgress) => void;
}

export interface WorldEvaluationProgress {
  phase: 'preparing' | 'transport' | 'sampling';
  stage: string;
  progress: number | null;
  nodeId?: string;
  completed?: number;
  total?: number;
  unit?: 'stages' | 'rows' | 'samples' | 'iterations';
  /** The current graph stage, one-based, when several stages share a phase. */
  stageIndex?: number;
  stageCount?: number;
}
