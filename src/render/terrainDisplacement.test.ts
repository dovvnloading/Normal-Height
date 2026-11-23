import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { evaluateGraph } from '../engine';
import { createTerrainPicker } from './terrainPicking';
import { generatePBR, resolveSurface } from '../materials/pbr';
import { createProject } from '../model/presets';
import type { HeightField } from '../model/types';
import { TERRAIN_SIZE } from './GroundExtension';
import { createDisplacedTerrainSampler } from './terrainDisplacement';
import {
  buildAdaptiveTerrainGeometry, createTerrainSampler, MESH_VERTEX_BUDGET,
  planTerrainMesh, planUniform512Reference, TERRAIN_TILES, type TerrainMeshPlan,
} from './terrainMesh';

function plan(segments: number[]): TerrainMeshPlan {
  return {
    segments, key: segments.join(','), maxSegments: Math.max(...segments),
    vertexCount: segments.reduce((n, s) => n + (s + 1) ** 2, 0),
    triangleCount: segments.reduce((n, s) => n + 2 * s * s, 0),
  };
}

describe('material relief in the displayed triangle mesh', () => {
  it('uses the painted substrate for fine displacement inside each brush stroke', () => {
    const n = 33;
    const values = new Float32Array(n * n);
    const field = { resolution: n, height: values, wear: values, deposition: values, flow: values };
    const project = { ...createProject(), worldSize: 512, heightScale: 100 };
    const relief = (painted: typeof project) =>
      createDisplacedTerrainSampler(values, generatePBR(field, painted), painted).heightForSpacing!(0.25);
    const untouched = relief(project);
    const profiles = (['rock', 'soil', 'vegetation', 'snow'] as const).map(layer => {
      const sample = relief({ ...project, materialPaint: [{
        layer, radius: 0.2, hardness: 1, strength: 1, points: [{ u: 0.5, v: 0.5 }],
      }] });
      expect(sample(0.125, 0.125)).toBe(untouched(0.125, 0.125));
      return Array.from({ length: 17 }, (_, i) => sample((56 + i) / 128, 0.5));
    });
    for (let i = 0; i < profiles.length; i++) {
      for (let j = 0; j < i; j++) {
        const difference = profiles[i].map((h, k) => Math.abs(h - profiles[j][k]) * project.heightScale);
        expect(Math.max(...difference)).toBeGreaterThan(0.001);
      }
    }
  });

  it('adds signed metres once, preserving absolute source elevations and export buffers', () => {
    const n = 65, height = new Float32Array(n * n).fill(-0.1);
    const project = { ...createProject(), worldSize: 3200, heightScale: 160 };
    const maps = {
      resolution: n, detail: new Float32Array(n * n), splat: new Uint8ClampedArray(n * n * 4),
    };
    for (let i = 0; i < height.length; i++) maps.detail[i] = ((i % n) - 32) / 16;
    const before = maps.detail.slice();
    const surface = createDisplacedTerrainSampler(height, maps, project);
    const mesh = buildAdaptiveTerrainGeometry(surface, plan(new Array(64).fill(8)), 160, 3200);
    const pos = mesh.getAttribute('position');
    const factor = TERRAIN_SIZE / project.worldSize;
    for (let i = 0; i < 81; i++) {
      const x = i % 9;
      expect(pos.getY(i)).toBeCloseTo((height[0] * 160 + (x - 32) / 16) * factor, 7);
    }
    expect(surface.slopes!().x[32]).toBeCloseTo((4 / 3200), 5);
    expect(height.every(v => v === Math.fround(-0.1))).toBe(true);
    expect(maps.detail).toEqual(before);
    mesh.dispose();
  });

  it('forms new non-coplanar sub-source triangles even when a coarse flat bake contains no relief', () => {
    const n = 65, values = new Float32Array(n * n);
    const field: HeightField = { resolution: n, height: values, wear: values, flow: values, deposition: values };
    const project = createProject();
    project.worldSize = 3200; project.heightScale = 300;
    project.surface = resolveSurface({ detailMeters: 24, detailStrength: 1, biome: 'alpine' });
    const maps = generatePBR(field, project);
    // At 50 metres per texel a 24 metre vegetation crown cannot enter this bake.
    expect(maps.detail.every(value => value === 0)).toBe(true);
    const surface = createDisplacedTerrainSampler(values, maps, project);
    const segments = new Array(TERRAIN_TILES ** 2).fill(8);
    segments[9] = 128;
    const spec = plan(segments);
    const geometry = buildAdaptiveTerrainGeometry(surface, spec, project.heightScale, project.worldSize);
    const pos = geometry.getAttribute('position'), slopes = geometry.getAttribute('nhDetailSlope');
    const offset = 9 * 81, stride = 129;
    let maxMeters = 0, maxInteriorDeparture = 0, maxSlope = 0;
    for (let y = 4; y < 124; y++) for (let x = 4; x < 124; x++) {
      const k = offset + y * stride + x;
      const meters = project.worldSize / TERRAIN_SIZE;
      maxMeters = Math.max(maxMeters, Math.abs(pos.getY(k)) * meters);
      const linear = (pos.getY(k - 1) + pos.getY(k + 1)) / 2;
      maxInteriorDeparture = Math.max(maxInteriorDeparture, Math.abs(pos.getY(k) - linear) * meters);
      maxSlope = Math.max(maxSlope, Math.abs(slopes.getX(k)), Math.abs(slopes.getY(k)));
    }
    expect(maxMeters).toBeGreaterThan(0.05);
    expect(maxInteriorDeparture).toBeGreaterThan(0.01);
    expect(maxSlope).toBeGreaterThan(0.001);
    for (let i = 0; i < stride; i++) {
      // The adjoining coarse tiles are flat; the fine tile must hit all four edges exactly.
      for (const k of [offset + i, offset + stride * 128 + i,
        offset + stride * i, offset + stride * i + 128]) {
        expect(pos.getY(k)).toBe(0);
        expect(Math.abs(slopes.getX(k))).toBe(0);
      }
    }
    const disabled = createDisplacedTerrainSampler(values, maps, {
      ...project, surface: resolveSurface({ ...project.surface, detailStrength: 0 }),
    });
    expect(disabled.heightForSpacing!(0.1)(0.21, 0.21)).toBe(0);
    geometry.dispose();
  });

  it('resolves physical relief on the 36 km Dissected uplands preset at a close camera', () => {
    const project = createProject('uplands');
    const { field } = evaluateGraph(project, { resolution: 128 });
    const surface = createDisplacedTerrainSampler(field.height, generatePBR(field, project), project);
    const base = createTerrainSampler(field.height, field.resolution, project.heightScale, project.worldSize);
    const heightUnits = TERRAIN_SIZE * project.heightScale / project.worldSize;
    const target = new THREE.Vector3(0, heightUnits * base.height(0.5, 0.5), 0);
    const camera = new THREE.PerspectiveCamera(36, 1.5, 0.001, 40);
    camera.position.copy(target).add(new THREE.Vector3(0, 0.02, 0.045));
    camera.lookAt(target); camera.updateMatrixWorld();
    const lod = planTerrainMesh(surface, camera, 900, 1, project.heightScale, project.worldSize, 1, 'balanced');
    const tiles = lod.tilesPerSide!;
    expect(tiles).toBeGreaterThan(TERRAIN_TILES);
    expect(project.worldSize / (tiles * lod.maxSegments)).toBeLessThan(24 / 2);
    expect(lod.vertexCount).toBeLessThanOrEqual(MESH_VERTEX_BUDGET.balanced);
    const tile = lod.segments.indexOf(lod.maxSegments);
    const offset = lod.segments.slice(0, tile).reduce((sum, s) => sum + (s + 1) ** 2, 0);
    const mesh = buildAdaptiveTerrainGeometry(surface, lod, project.heightScale, project.worldSize);
    const heights = mesh.getAttribute('position'), picker = createTerrainPicker(mesh, lod);
    let peak = 0;
    for (let y = 16; y < lod.maxSegments - 16; y += 7) for (let x = 16; x < lod.maxSegments - 16; x += 7) {
      const u = (tile % tiles + x / lod.maxSegments) / tiles;
      const v = (Math.floor(tile / tiles) + y / lod.maxSegments) / tiles;
      const drawn = heights.getY(offset + y * (lod.maxSegments + 1) + x);
      expect(picker.heightAt(u, v)).toBeCloseTo(drawn, 7);
      peak = Math.max(peak, Math.abs(drawn / heightUnits - base.height(u, v)) * project.heightScale);
    }
    expect(peak).toBeGreaterThan(0.02);
    mesh.dispose();
  });

  it('lets every quality tier subdivide a coarse DEM past its old cap inside its vertex budget', () => {
    const n = 65, data = new Float32Array(n * n);
    const project = createProject();
    const surface = createDisplacedTerrainSampler(data, {
      resolution: n, detail: data, splat: new Uint8ClampedArray(n * n * 4),
    }, project);
    const base = createTerrainSampler(data, n, project.heightScale, project.worldSize);
    const camera = new THREE.PerspectiveCamera(36, 1, 0.001, 40);
    camera.position.set(0.16, 0.04, 0.16);
    camera.lookAt(0.16, 0, 0); camera.updateMatrixWorld();
    for (const quality of ['balanced', 'high', 'ultra'] as const) {
      const args = [camera, 800, 1, project.heightScale, project.worldSize, 1, quality] as const;
      const previous = planTerrainMesh(base, ...args), next = planTerrainMesh(surface, ...args);
      expect(next.maxSegments).toBeGreaterThan(previous.maxSegments);
      expect(next.vertexCount).toBeLessThanOrEqual(MESH_VERTEX_BUDGET[quality]);
    }
    expect(planUniform512Reference().segments.every(s => s === 64)).toBe(true);
  });
});
