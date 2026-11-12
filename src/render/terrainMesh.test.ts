import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createProject } from '../model/presets';
import type { HeightField } from '../model/types';
import { buildGroundApron, TERRAIN_SIZE } from './GroundExtension';
import {
  buildAdaptiveTerrainGeometry, createTerrainSampler,
  planTerrainMesh, planUniform512Reference, TERRAIN_TILES,
} from './terrainMesh';
import type { TerrainMeshPlan, TerrainSampler } from './terrainMesh';

const field = (n: number, fn: (x: number, y: number) => number): HeightField => {
  const height = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++)
    height[y * n + x] = fn(x / (n - 1), y / (n - 1));
  return { resolution: n, height,
    flow: new Float32Array(n * n), wear: new Float32Array(n * n),
    deposition: new Float32Array(n * n),
  };
};

const fixedPlan = (segments: number[]): TerrainMeshPlan => ({
  segments, key: segments.join(','),
  vertexCount: segments.reduce((total, s) => total + (s + 1) ** 2, 0),
  triangleCount: segments.reduce((total, s) => total + 2 * s * s, 0),
  maxSegments: Math.max(...segments),
});

describe('physically faithful heightfield reconstruction', () => {
  it('exactly reproduces planes and continuous, physical slope normals at the border', () => {
    const map = field(33, (u, v) => 0.24 + 0.43 * u - 0.19 * v);
    const sampler = createTerrainSampler(map.height, 33, 1800, 6000);
    for (const u of [0, 0.01, 0.17, 0.49, 0.83, 0.99, 1])
      for (const v of [0, 0.04, 0.23, 0.54, 0.88, 1]) {
        expect(sampler.height(u, v)).toBeCloseTo(0.24 + 0.43 * u - 0.19 * v, 5);
        const actual = sampler.normal(u, v);
        const expected = new THREE.Vector3(-0.43 * 1800 / 6000, 1,
          0.19 * 1800 / 6000).normalize();
        expect(actual[0]).toBeCloseTo(expected.x, 5);
        expect(actual[1]).toBeCloseTo(expected.y, 5);
        expect(actual[2]).toBeCloseTo(expected.z, 5);
      }
  });

  it('does not overshoot spikes or erase the original Float32 heightfield', () => {
    const map = field(33, (u, v) =>
      u > 0.5 && v > 0.5 ? 0.91 : 0.13);
    const copy = map.height.slice();
    const sampler = createTerrainSampler(map.height, 33, 1900, 8000);
    for (let j = 0; j <= 150; j++)
      for (let i = 0; i <= 150; i++) {
        const u = i / 150, v = j / 150;
        const value = sampler.height(u, v);
        expect(value).toBeGreaterThanOrEqual(0.13 - 1e-6);
        expect(value).toBeLessThanOrEqual(0.91 + 1e-6);
        expect(sampler.normal(u, v).every(Number.isFinite)).toBe(true);
      }
    expect(map.height).toEqual(copy);
  });
});

describe('budgeted camera-adaptive terrain mesh', () => {
  const simpleSampler: TerrainSampler = {
    resolution: 1024,
    height: (u, v) => 0.4 + 0.1 * u - 0.06 * v,
    normal: () => [0, 1, 0],
  };
  const camera = (x: number, y: number, z: number) => {
    const cam = new THREE.PerspectiveCamera(36, 1.5, 0.002, 40);
    cam.position.set(x, y, z);
    cam.lookAt(0, 0.35, 0);
    cam.updateMatrixWorld();
    return cam;
  };
  it('spends more vertices near the camera while respecting each quality budget', () => {
    const far = planTerrainMesh(simpleSampler, camera(0, 5, 9), 860, 1.5,
      1800, 8000, 1, 'high');
    const near = planTerrainMesh(simpleSampler, camera(0, 0.4, 0.45), 860, 1.5,
      1800, 8000, 1, 'high');
    const ultra = planTerrainMesh(simpleSampler, camera(0, 0.4, 0.45), 860, 1.5,
      1800, 8000, 1, 'ultra');
    expect(near.vertexCount).toBeGreaterThan(far.vertexCount);
    expect(near.maxSegments).toBeGreaterThan(far.maxSegments);
    expect(near.vertexCount).toBeLessThanOrEqual(680000);
    expect(ultra.vertexCount).toBeLessThanOrEqual(970000);
    expect(ultra.vertexCount).toBeGreaterThanOrEqual(near.vertexCount);
    expect(near.segments.some((value) => value < near.maxSegments)).toBe(true);
    expect(planTerrainMesh(simpleSampler, camera(0, 0.4, 0.45), 860, 1.5,
      1800, 8000, 1, 'high')).toEqual(near);
  });

  it('offers a reproducible uniform reference for matched-camera hardware benchmarks', () => {
    const reference = planUniform512Reference();
    expect(reference.maxSegments).toBe(64);
    expect(reference.vertexCount).toBe(8 * 8 * 65 * 65);
    expect(reference.triangleCount).toBe(8 * 8 * 2 * 64 * 64);
    expect(reference.segments.every(value => value === 64)).toBe(true);
    expect(reference).toEqual(planUniform512Reference());
  });

  it('keeps mesh density stable across small camera motion, then downgrades when far away', () => {
    const near = planTerrainMesh(simpleSampler, camera(0, 0.4, 0.45),
      860, 1.5, 1800, 8000, 1, 'high');
    const drift = planTerrainMesh(simpleSampler, camera(0, 0.4, 0.455),
      860, 1.5, 1800, 8000, 1, 'high', near);
    expect(drift.key).toBe(near.key);
    const far = planTerrainMesh(simpleSampler, camera(0, 6, 10),
      860, 1.5, 1800, 8000, 1, 'high', near);
    expect(far.vertexCount).toBeLessThan(near.vertexCount);
    expect(far.maxSegments).toBeLessThan(near.maxSegments);
  });

  it('stitches unequal-resolution borders without cracks or differing border normals', () => {
    const n = 33, source = field(n, (u, v) =>
      0.42 + 0.17 * u + 0.2 * v + 0.09 * Math.sin(u * 16) * Math.cos(v * 9));
    const sampler = createTerrainSampler(source.height, n, 1400, 4000);
    const segments = new Array<number>(TERRAIN_TILES ** 2).fill(16);
    segments[0] = 64;
    const geometry = buildAdaptiveTerrainGeometry(sampler, fixedPlan(segments), 1400, 4000);
    const positions = geometry.getAttribute('position');
    const normals = geometry.getAttribute('normal');
    const first = 0, second = (64 + 1) ** 2;
    for (let y = 0; y <= 64; y++) {
      const high = first + y * 65 + 64;
      const step = y / 4, k = Math.floor(step), f = step - k;
      const low0 = second + Math.min(k, 16) * 17;
      const low1 = second + Math.min(k + 1, 16) * 17;
      const expected = positions.getY(low0) * (1 - f) + positions.getY(low1) * f;
      expect(positions.getY(high)).toBeCloseTo(expected, 5);
      // Fine-edge normals must match the interpolation of coarse-edge
      // normals even between shared vertices (no lighting seams).
      for (let axis = 0; axis < 3; axis++) {
        const expectedNormal = normals.getComponent(low0, axis) * (1 - f) +
          normals.getComponent(low1, axis) * f;
        expect(normals.getComponent(high, axis)).toBeCloseTo(expectedNormal, 5);
      }
    }
    expect(geometry.index!.count).toBe(fixedPlan(segments).triangleCount * 3);
    geometry.dispose();
  });

  it('uses the exact adaptive mesh outline for skirts and meadow-apron geometry', () => {
    const map = field(33, (u, v) =>
      0.31 + u * 0.2 + v * 0.26 + 0.03 * Math.cos(15 * u));
    const sampler = createTerrainSampler(map.height, map.resolution, 2000, 5000);
    const segments = new Array<number>(TERRAIN_TILES ** 2).fill(16);
    segments[0] = 64; segments[7] = 32; segments[56] = 32;
    const geometry = buildAdaptiveTerrainGeometry(sampler, fixedPlan(segments), 2000, 5000);
    const perimeter = geometry.userData.nhPerimeterIndices as number[];
    const positions = geometry.getAttribute('position');
    const project = createProject();
    project.heightScale = 2000; project.worldSize = 5000;
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
    const apron = buildGroundApron(map, project, 1.7, -0.1, TERRAIN_SIZE * 5, mesh);
    const apronPositions = apron.getAttribute('position');
    expect(apron.userData.edgeVertexCount).toBe(perimeter.length);
    expect(perimeter.length).toBeGreaterThan(8 * 16 * 4);
    for (let i = 0; i < perimeter.length; i++) {
      const j = perimeter[i];
      expect(apronPositions.getX(i)).toBeCloseTo(positions.getX(j), 5);
      expect(apronPositions.getY(i)).toBeCloseTo(positions.getY(j) * 1.7, 5);
      expect(apronPositions.getZ(i)).toBeCloseTo(positions.getZ(j), 5);
    }
    apron.dispose(); geometry.dispose(); mesh.material.dispose();
  });
});
