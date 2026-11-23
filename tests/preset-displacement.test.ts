import { PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import { evaluateGraph } from '../src/engine';
import { generatePBR } from '../src/materials/pbr';
import { createProject, PRESETS } from '../src/model/presets';
import { TERRAIN_SIZE } from '../src/render/GroundExtension';
import { createDisplacedTerrainSampler } from '../src/render/terrainDisplacement';
import { buildAdaptiveTerrainGeometry, createTerrainSampler, planTerrainMesh } from '../src/render/terrainMesh';

describe('displacement on the studio landscapes', () => {
  it.each(PRESETS)('moves triangles on $name at its authored world scale', ({ id }) => {
    const project = createProject(id);
    const { field } = evaluateGraph(project, { resolution: 128 });
    const maps = generatePBR(field, project);
    const displaced = createDisplacedTerrainSampler(field.height, maps, project);
    const terrain = createTerrainSampler(field.height, field.resolution, project.heightScale, project.worldSize);
    const camera = new PerspectiveCamera(36, 1, 0.002, 40);
    const y = terrain.height(0.5, 0.5) * TERRAIN_SIZE * project.heightScale / project.worldSize;
    camera.position.set(0.018, y + 0.036, 0.03);
    camera.lookAt(0, y, 0);
    const plan = planTerrainMesh(displaced, camera, 640, 1, project.heightScale, project.worldSize, 1, 'balanced');
    const mesh = buildAdaptiveTerrainGeometry(displaced, plan, project.heightScale, project.worldSize);
    const base = buildAdaptiveTerrainGeometry(terrain, plan, project.heightScale, project.worldSize);
    const positions = mesh.getAttribute('position'), reference = base.getAttribute('position');
    let maxMeters = 0;
    for (let i = 0; i < positions.count; i++) {
      const difference = Math.abs(positions.getY(i) - reference.getY(i));
      maxMeters = Math.max(maxMeters, difference * project.worldSize / TERRAIN_SIZE);
    }
    mesh.dispose();
    base.dispose();
    expect(maxMeters).toBeGreaterThan(0.01);
  }, 20_000);
});
