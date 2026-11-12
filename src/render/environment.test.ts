import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildGroundApron, TERRAIN_SIZE } from './GroundExtension';
import { skyLighting } from './Atmosphere';
import type { HeightField, TerrainProject, ViewSettings } from '../model/types';

const settings: ViewSettings = {
  material: 'pbr', nearFieldDetail: true, meshQuality: 'high', sunAzimuth: 315, sunElevation: 38, exaggeration: 1,
  contours: false, wireframe: false, autoRotate: false,
  skyEnabled: true, skyTurbidity: 4.5, skyRayleigh: 2.2, skyExposure: 1,
  cloudCoverage: 0.42, cloudSpeed: 0.35, cloudShadowStrength: 0.72,
  expandGround: false, groundReach: 5,
};

function flatField(height: number): HeightField {
  return {
    resolution: 17,
    height: new Float32Array(17 * 17).fill(height),
    flow: new Float32Array(17 * 17),
    wear: new Float32Array(17 * 17),
    deposition: new Float32Array(17 * 17),
  };
}

const project = { worldSize: 1000, heightScale: 350, seed: 1234 } as TerrainProject;

describe('the non-destructive landscape extension', () => {
  it('connects exactly to all four original tile edges and flattens the outer perimeter', () => {
    for (const elevation of [-0.5, 0, 0.7]) {
      for (const exaggeration of [0.5, 1, 3]) {
        const field = flatField(elevation);
        const base = Math.min(0, elevation * TERRAIN_SIZE * project.heightScale / project.worldSize)
          * exaggeration - 0.048;
        const geometry = buildGroundApron(field, project, exaggeration, base, 13);
        const position = geometry.getAttribute('position');
        const normal = geometry.getAttribute('normal');
        const count = 16 * 4;
        for (let i = 0; i < count; i++) {
          expect(position.getY(i)).toBeCloseTo(
            elevation * TERRAIN_SIZE * project.heightScale / project.worldSize * exaggeration,
            5,
          );
          expect(Math.max(Math.abs(position.getX(i)), Math.abs(position.getZ(i)))).toBeCloseTo(
            TERRAIN_SIZE / 2, 5,
          );
          const outer = position.count - count + i;
          expect(position.getY(outer)).toBeCloseTo(base, 5);
          expect(Math.max(Math.abs(position.getX(outer)), Math.abs(position.getZ(outer)))).toBeCloseTo(
            TERRAIN_SIZE / 2 + 0.74, 5,
          );
          expect(normal.getY(outer)).toBeGreaterThan(0);
        }
        geometry.dispose();
      }
    }
  });

  it('matches every vertex of a non-flat tile border with no geometric cracks', () => {
    const n = 65;
    const values = new Float32Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++)
      values[y * n + x] = Math.sin(x * 0.21) * 0.17 + Math.cos(y * 0.16) * 0.26;
    const field: HeightField = { resolution: n, height: values,
      flow: values.slice(), wear: values.slice(), deposition: values.slice() };
    const geo = buildGroundApron(field, project, 2, -0.3, 13);
    const positions = geo.getAttribute('position');
    const scale = TERRAIN_SIZE * project.heightScale / project.worldSize * 2;
    const segments = n - 1;
    for (let step = 0; step < segments; step++) {
      expect(positions.getY(step)).toBeCloseTo(values[step] * scale, 5);
      expect(positions.getY(segments + step))
        .toBeCloseTo(values[step * n + segments] * scale, 5);
      expect(positions.getY(segments * 2 + step))
        .toBeCloseTo(values[(n - 1) * n + (segments - step)] * scale, 5);
      expect(positions.getY(segments * 3 + step))
        .toBeCloseTo(values[(segments - step) * n] * scale, 5);
    }
    geo.dispose();
  });

  it('does not change the generated Float32 heights', () => {
    const field = flatField(0.42);
    const before = field.height.slice();
    const geometry = buildGroundApron(field, project, 2, -0.05, 13);
    expect(field.height).toEqual(before);
    geometry.dispose();
  });
});

describe('sky lighting', () => {
  it('produces warmer, dimmer sunlight at low sun elevation', () => {
    const noon = skyLighting({ ...settings, sunElevation: 75 });
    const sunset = skyLighting({ ...settings, sunElevation: 3 });
    expect(noon.sunIntensity).toBeGreaterThan(sunset.sunIntensity);
    expect(sunset.sunColor.r - sunset.sunColor.b).toBeGreaterThan(
      noon.sunColor.r - noon.sunColor.b,
    );
  });

  it('adapts atmospheric lighting and view distance to changing weather and ground reach', () => {
    const clear = skyLighting(settings);
    const hazy = skyLighting({ ...settings, skyTurbidity: 16 });
    const extended = skyLighting({ ...settings, expandGround: true });
    expect(hazy.sunIntensity).toBeLessThan(clear.sunIntensity);
    expect(extended.fogFar).toBeGreaterThan(clear.fogFar);
    expect(clear.ambientSky).toBeInstanceOf(THREE.Color);
  });
});
