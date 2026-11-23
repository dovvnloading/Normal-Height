/// <reference lib="webworker" />
import type { HeightField, TerrainProject } from '../model/types';
import type { MaterialRanges } from './layerSynthesis';
import type { TexelRect } from './materialRegion';
import { bakePreview } from './previewBake';

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.addEventListener(
  'message',
  (
    event: MessageEvent<{
      field: HeightField;
      project: TerrainProject;
      dirty?: TexelRect;
      ranges?: MaterialRanges;
    }>,
  ) => {
    try {
      const { field, project, dirty, ranges } = event.data;
      const bake = bakePreview(field, project, dirty, ranges);
      const arrays = [...Object.values(bake.buffers), ...Object.values(bake.packed)];
      scope.postMessage(
        { type: 'result', bake },
        arrays.map((a) => a.buffer as ArrayBuffer),
      );
    } catch (error) {
      scope.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : 'PBR synthesis failed.',
      });
    }
  },
);
