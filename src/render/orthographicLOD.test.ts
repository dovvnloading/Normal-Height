import { expect, it } from 'vitest';
import * as THREE from 'three';
import { planTerrainMesh } from './terrainMesh';
import type { TerrainSampler } from './terrainMesh';

const sampler: TerrainSampler = {
  resolution: 512,
  height: () => 0,
  normal: () => [0, 1, 0],
};

function ortho(extent: number) {
  const camera = new THREE.OrthographicCamera(
    -extent, extent, extent, -extent, 0.01, 40,
  );
  camera.position.set(0, 6, 0.0001);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}

it('plans orthographic LOD from screen-space coverage rather than camera distance', () => {
  const far = planTerrainMesh(sampler, ortho(6), 900, 1, 1500, 8000, 1, 'high');
  const near = planTerrainMesh(sampler, ortho(0.5), 900, 1, 1500, 8000, 1, 'high');
  expect(near.vertexCount).toBeGreaterThan(far.vertexCount);
  expect(near.vertexCount).toBeLessThanOrEqual(680000);
  expect(near.segments.every(x => Number.isInteger(x) && x > 0)).toBe(true);
  expect(near.triangleCount).toBeGreaterThan(0);
});
