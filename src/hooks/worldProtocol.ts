import type { TerrainProject } from '../model/types';
import type { WorldDefinition } from '../model/world';
import type { WorldRegionResult } from '../engine/world';
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
};

export type WorldWorkerResponse =
  | { type: 'progress'; id: number; progress: number; stage: string }
  | {
      type: 'result';
      id: number;
      result: WorldRegionResult;
      cacheHit: boolean;
      store?: WorldRegionStoreStats;
      compute?: ComputeCapability;
      warnings?: string[];
    }
  | { type: 'error'; id: number; message: string };
