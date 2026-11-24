import type { ParamValue } from '../model/types';

export interface NoisePreviewRequest {
  id: string;
  params: Record<string, ParamValue>;
  projectSeed: number;
  worldSize: number;
  resolution: number;
}

export interface NoisePreview {
  height: Float32Array;
  resolution: number;
  minimum: number;
  maximum: number;
  mean: number;
  duration: number;
  histogram: number[];
  outsideDisplayRange: number;
}

export type NoisePreviewResponse =
  | { type: 'preview'; id: string; preview: NoisePreview }
  | { type: 'error'; id: string; message: string }
  | { type: 'complete' };

/** IDs identify UI slots, not noise streams. Sampling never depends on them. */
export function noisePreviewKey(request: NoisePreviewRequest): string {
  return JSON.stringify([
    Object.entries(request.params).sort(([a], [b]) => a.localeCompare(b)),
    request.projectSeed,
    request.worldSize,
    request.resolution,
  ]);
}
