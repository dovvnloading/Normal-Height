/// <reference lib="webworker" />
import { generatePBR } from './pbr';
import type { HeightField, TerrainProject } from '../model/types';

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.addEventListener('message', (event: MessageEvent<{
  field: HeightField;
  project: TerrainProject;
}>) => {
  try {
    const maps = generatePBR(event.data.field, event.data.project);
    scope.postMessage({ type: 'result', maps }, [
      maps.basecolor.buffer as ArrayBuffer,
      maps.splat.buffer as ArrayBuffer,
      maps.roughness.buffer as ArrayBuffer,
      maps.ao.buffer as ArrayBuffer,
      maps.curvature.buffer as ArrayBuffer,
      maps.detail.buffer as ArrayBuffer,
    ]);
  } catch (error) {
    scope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : 'PBR synthesis failed.',
    });
  }
});
