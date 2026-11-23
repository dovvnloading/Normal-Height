import { describe, expect, it } from 'vitest';
import { Mesh, Ray, Raycaster, Vector3 } from 'three';
import { buildAdaptiveTerrainGeometry, TERRAIN_TILES } from './terrainMesh';
import { TERRAIN_SIZE } from './GroundExtension';
import { createTerrainPicker } from './terrainPicking';

describe('adaptive terrain picking', () => {
  it('matches triangle raycasts across mixed LOD tiles and at shared edges', () => {
    const segments = Array.from({length: TERRAIN_TILES ** 2}, (_, i) => 2 ** (1 + i % 4));
    const plan = {
      segments, key: 'mixed', maxSegments: 16,
      vertexCount: segments.reduce((sum, s) => sum + (s + 1) ** 2, 0),
      triangleCount: segments.reduce((sum, s) => sum + 2 * s * s, 0),
    };
    const geometry = buildAdaptiveTerrainGeometry({
      resolution: 129, height: (x, y) => Math.cos(x * 18) * Math.sin(y * 9) * .5,
      normal: () => [0, 1, 0],
    }, plan, 700, 1000);
    const mesh = new Mesh(geometry);
    const picker = createTerrainPicker(geometry, plan);
    const origins = [new Vector3(2.3, 1.1, 1.6), new Vector3(-2.1, .4, -1.8), new Vector3(0, 3, 0)];
    for (let i = 0; i < 80; i++) {
      const origin = origins[i % origins.length];
      const target = new Vector3(((i * 13) % 19 / 18 - .5) * 3, -.1, ((i * 17) % 23 / 22 - .5) * 3);
      const dir = target.clone().sub(origin).normalize();
      const p = picker(new Ray(origin, dir));
      const reference = new Raycaster(origin, dir).intersectObject(mesh, false)[0];
      expect(!!p).toBe(!!reference);
      if (p && reference) {
        expect(p.u).toBeCloseTo(reference.point.x / TERRAIN_SIZE + .5, 5);
        expect(p.v).toBeCloseTo(reference.point.z / TERRAIN_SIZE + .5, 5);
      }
    }
    expect(picker(new Ray(new Vector3(0, 3, 0), new Vector3(0, -1, 0)))).toEqual({u: .5, v: .5});
  });
});
