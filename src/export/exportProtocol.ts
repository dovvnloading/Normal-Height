import type { HeightField, TerrainProject } from '../model/types';
import type { ExportFormat } from './heightmap';

export interface EncodeRequest {
  type: 'encode';
  id: number;
  field: HeightField;
  project: TerrainProject;
  format: ExportFormat;
  outputNodeId?: string;
  bundle: boolean;
  memoryBudgetMiB?: number;
}

export type EncodeResponse =
  | { type: 'progress'; id: number; stage: string }
  | { type: 'error'; id: number; message: string }
  | { type: 'result'; id: number; bytes: ArrayBuffer; filename: string; mime: string };
