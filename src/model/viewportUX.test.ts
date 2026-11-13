import { describe, expect, it } from 'vitest';
import { sampleGrid, sampleTerrain, terrainProfile } from './viewportUX';
import type { HeightField, TerrainProject } from './types';

const field = {
  resolution: 3,
  height: Float32Array.from([0, 0.5, 1, 0, 0.5, 1, 0, 0.5, 1]),
  flow: Float32Array.from({ length: 9 }, (_, i) => i / 8),
  wear: new Float32Array(9),
  deposition: new Float32Array(9),
} as HeightField;
const project = { worldSize: 200, heightScale: 100 } as TerrainProject;

describe('terrain viewport inspection', () => {
  it('samples the authoritative field without interpolating outside the tile', () => {
    expect(sampleGrid(field.height, 3, { u: 0.25, v: 0.5 })).toBeCloseTo(0.25);
    expect(sampleGrid(field.height, 3, { u: 3, v: -2 })).toBe(1);
    expect(sampleGrid(field.height, 3, { u: Number.NaN, v: 1 })).toBe(0);
  });
  it('reports elevation, real-world location and physical slope', () => {
    const value = sampleTerrain(field, project, { u: 0.5, v: 0.5 });
    expect(value.elevation).toBeCloseTo(50);
    expect(value.easting).toBe(100);
    expect(value.northing).toBe(100);
    expect(value.slope).toBeCloseTo(Math.atan(0.5) * 180 / Math.PI);
    expect(value.flow).toBeCloseTo(0.5);
  });
  it('bounds transects to the measured tile before computing physical distance', () => {
    const profile = terrainProfile(field, project,
      { u: -50, v: 0.5 }, { u: 50, v: 0.5 }, 16);
    expect(profile.horizontalDistance).toBeCloseTo(200);
    expect(profile.elevationChange).toBeCloseTo(100);
    expect(profile.grade).toBeCloseTo(50);
  });
  it('reports flat, rising and descending transects correctly', () => {
    const rising = terrainProfile(field, project, { u: 0, v: 0.5 }, { u: 1, v: 0.5 }, 20);
    expect(rising.horizontalDistance).toBe(200);
    expect(rising.elevationChange).toBeCloseTo(100);
    expect(rising.grade).toBeCloseTo(50);
    expect(rising.surfaceDistance).toBeCloseTo(Math.hypot(200, 100));
    expect(rising.ascent).toBeCloseTo(100);
    const falling = terrainProfile(field, project, { u: 1, v: 0.5 }, { u: 0, v: 0.5 });
    expect(falling.descent).toBeCloseTo(100);
    expect(falling.ascent).toBeCloseTo(0);
    const level = terrainProfile(field, project, { u: 0.5, v: 0 }, { u: 0.5, v: 1 });
    expect(level.elevationChange).toBeCloseTo(0);
    expect(level.surfaceDistance).toBeCloseTo(200);
  });
});
