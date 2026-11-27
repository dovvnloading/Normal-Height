import { describe, expect, it } from 'vitest';
import { buildWorldTerrainMesh } from '../src/components/world/worldTerrainMesh';
import type { WorldSnapshot } from '../src/components/world/worldViewMath';
import { createProject } from '../src/model/presets';
import { createWorldDefinition } from '../src/model/world';

describe('physical World display mesh', () => {
  it('caps geometry and derives normals from the original anisotropic field with north-aligned UVs', () => {
    const world = createWorldDefinition(createProject());
    Object.assign(world.domain, {
      width: 512,
      depth: 512,
      cellsX: 512,
      cellsZ: 256,
      heightScale: 1024,
    });
    const width = 513,
      height = 257;
    const heights = Float32Array.from(
      { length: width * height },
      (_, i) => ((i % width) + Math.floor(i / width) * 4) / 1024,
    );
    const zero = new Float32Array(heights.length);
    const snapshot: WorldSnapshot = {
      world,
      grid: { startX: 0, startZ: 0, cellsX: 512, cellsZ: 256, samplesX: width, samplesZ: height },
      result: {
        width,
        height,
        heights,
        flow: zero,
        wear: zero,
        deposition: zero,
        min: 0,
        max: 1.5,
        spacingX: 1,
        spacingZ: 2,
        stages: [],
        duration: 0,
        backend: 'cpu-reference',
        estimatedPeakBytes: 0,
      },
    };
    const mesh = buildWorldTerrainMesh(snapshot);
    expect([mesh.columns, mesh.rows]).toEqual([257, 257]);
    expect(mesh.positions.length).toBe(257 * 257 * 3);
    expect([...mesh.uv.slice(0, 2)]).toEqual([0, 1]);
    expect([...mesh.uv.slice(-2)]).toEqual([1, 0]);
    const normal = [-1 / Math.sqrt(6), 1 / Math.sqrt(6), -2 / Math.sqrt(6)];
    for (let i = 0; i < mesh.normals.length; i += 1023) {
      expect(mesh.normals[i]).toBeCloseTo(normal[0], 6);
      expect(mesh.normals[i + 1]).toBeCloseTo(normal[1], 6);
      expect(mesh.normals[i + 2]).toBeCloseTo(normal[2], 6);
    }
    expect(mesh.indices.every((index) => index < mesh.columns * mesh.rows)).toBe(true);
    expect(mesh.walls.every(Number.isFinite)).toBe(true);
  });
});
