import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createProject } from '../model/presets';
import { DEFAULT_VIEW_SETTINGS } from '../model/viewSettings';
import type { HeightField } from '../model/types';
import { WaterSurface } from './WaterSurface';
import { linkedCoastLevel, resolveWaterLevelMeters, WATER_PALETTES, waterHeightRange,
  waterSceneHeight } from './water';

const field = (heights: number[]): HeightField => ({
  resolution: Math.sqrt(heights.length),
  height: Float32Array.from(heights),
  flow: new Float32Array(heights.length),
  wear: new Float32Array(heights.length),
  deposition: new Float32Array(heights.length),
});

describe('physical waterline and optional rendering', () => {
  it('follows only a coast connected to terrain output', () => {
    const project = createProject('volcanic-island');
    const input = field([0, 0.1, 0.2, 0.3]);
    expect(linkedCoastLevel(project)).toBeCloseTo(0.21 * project.heightScale);
    expect(resolveWaterLevelMeters(project, DEFAULT_VIEW_SETTINGS, input)).toBeCloseTo(504);
    const disconnected = { ...project, graph: { ...project.graph,
      edges: project.graph.edges.filter(edge => edge.source !== 'coast') } };
    expect(linkedCoastLevel(disconnected)).toBeNull();
    expect(resolveWaterLevelMeters(disconnected, DEFAULT_VIEW_SETTINGS, input))
      .toBeCloseTo(0.066 * project.heightScale);
    expect(resolveWaterLevelMeters(project, { ...DEFAULT_VIEW_SETTINGS,
      waterLevelMode: 'manual', waterLevel: -120 }, input)).toBe(-120);
  });

  it('uses true source elevation and preserves world units under exaggeration', () => {
    const project = createProject('alpine');
    const input = field([-1, -0.5, 0.2, 2]);
    expect(waterHeightRange(input, project)).toEqual({
      min: -project.heightScale, max: 2 * project.heightScale,
    });
    expect(waterSceneHeight(100, project, 2)).toBeCloseTo(
      (100 * 2.6 / project.worldSize) * 2,
    );
  });

  it('uploads a single bathymetry texture, reuses it on appearance edits, and disposes it', () => {
    const scene = new THREE.Scene();
    const water = new WaterSurface(scene);
    const project = createProject('volcanic-island');
    const source = field([0, 0.1, 0.2, 0.3]);
    const settings = { ...DEFAULT_VIEW_SETTINGS, waterEnabled: true,
      skyEnabled: true, waterPalette: 'ocean' as const };
    water.update(source, project, settings);
    expect(water.mesh.position.y).toBeCloseTo(waterSceneHeight(504, project, 1) + 0.00012);
    expect(water.mesh.scale.x).toBe(3.4);
    expect(water.mesh.material.uniforms.uHeightScale.value).toBe(project.heightScale);
    const texture = water.mesh.material.uniforms.uHeightMap.value as THREE.DataTexture;
    expect(texture.image.data).toBe(source.height);
    expect(texture.minFilter).toBe(THREE.NearestFilter);
    expect(texture.format).toBe(THREE.RedFormat);
    water.update(source, project, { ...settings, waterWaveHeight: 0, waterSpeed: 0,
      waterHorizon: false });
    expect(water.mesh.scale.x).toBe(1);
    expect(water.mesh.material.uniforms.uHeightMap.value).toBe(texture);
    expect(water.mesh.material.uniforms.uWaveScene.value).toBe(0);
    expect(Object.keys(WATER_PALETTES)).toHaveLength(4);
    const changed = field([0.2, 0.2, 0.2, 0.2]);
    water.update(changed, project, settings);
    expect(water.mesh.material.uniforms.uHeightMap.value).not.toBe(texture);
    expect(scene.children).toContain(water.mesh);
    water.dispose();
    expect(scene.children).not.toContain(water.mesh);
  });
});
