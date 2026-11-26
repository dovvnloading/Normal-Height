import type { HeightField, TerrainProject } from '../model/types';
import type { ExportFormat } from './heightmap';

interface EncodeTerrainRequest {
  type: 'encode';
  id: number;
  field: HeightField;
  project: TerrainProject;
  format: ExportFormat;
  outputNodeId?: string;
  bundle: boolean;
  memoryBudgetMiB?: number;
}

export interface EncodeTileRequest {
  type: 'encodeTiles';
  id: number;
  project: TerrainProject;
  resolution: number;
  format: 'detailTiles';
  bundle: true;
  memoryBudgetMiB?: number;
}

export type EncodeRequest = EncodeTerrainRequest | EncodeTileRequest;

export type EncodeResponse =
  | { type: 'progress'; id: number; stage: string }
  | { type: 'error'; id: number; message: string }
  | { type: 'result'; id: number; bytes: ArrayBuffer; filename: string; mime: string };
