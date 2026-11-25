import type { TerrainProject } from '../model/types';
import type { WorldDefinition } from '../model/world';
import type { WorldRegionResult } from '../engine/world';
import type { WorldEvaluationProgress } from '../engine/world';
import type { WorldRegionStoreStats } from '../engine/worldStore';
import type { ComputeCapability } from '../engine/gpu/pointwise';

export interface WorldGridRequest {
  startX: number;
  startZ: number;
  cellsX: number;
  cellsZ: number;
  samplesX: number;
  samplesZ: number;
}

export type WorldWorkerRequest = {
  type: 'preview';
  id: number;
  project: TerrainProject;
  world: WorldDefinition;
  grid: WorldGridRequest;
  cache?: boolean;
  previewNodeId?: string;
};

export type WorldWorkerResponse =
  | {
      type: 'progress';
      id: number;
      progress: number;
      stage: string;
      detail?: WorldPreviewProgress;
    }
  | {
      type: 'result';
      id: number;
      result: WorldRegionResult;
      cacheHit: boolean;
      store?: WorldRegionStoreStats;
      compute?: ComputeCapability;
      warnings?: string[];
      cacheSource?: 'memory' | 'persistent';
      preparedReused?: boolean;
      /** Preparation, sampling, and optional cache I/O, measured in the worker. */
      elapsedMs?: number;
    }
  | { type: 'error'; id: number; message: string };

export interface WorldPreviewProgress extends Omit<WorldEvaluationProgress, 'phase'> {
  phase: WorldEvaluationProgress['phase'] | 'cache' | 'storing';
}

export type WorldPreviewResult = Extract<WorldWorkerResponse, { type: 'result' }>;
