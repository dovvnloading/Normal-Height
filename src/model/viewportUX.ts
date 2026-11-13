import type { HeightField, TerrainProject } from './types';

export type TerrainPoint = { u: number; v: number };
export type ViewportTool = 'navigate' | 'inspect' | 'measure' | 'profile';
export type MapFraming = { zoom: number; offset: { x: number; y: number } };
export type TerrainSample = {
  point: TerrainPoint;
  easting: number;
  northing: number;
  elevation: number;
  slope: number;
  flow: number;
  wear: number;
  deposition: number;
};
export type TerrainProfile = {
  samples: TerrainSample[];
  horizontalDistance: number;
  surfaceDistance: number;
  elevationChange: number;
  ascent: number;
  descent: number;
  grade: number;
};

export const DEFAULT_MAP_FRAMING: MapFraming = { zoom: 1, offset: { x: 0, y: 0 } };
export const clamp01 = (x: number) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));

export function validPoint(point: TerrainPoint): TerrainPoint {
  return { u: clamp01(point.u), v: clamp01(point.v) };
}

/** Bilinear interpolation in the authoritative source grid, not the adaptive 3D mesh. */
export function sampleGrid(values: Float32Array, resolution: number, point: TerrainPoint): number {
  if (resolution < 2 || values.length < resolution * resolution) return 0;
  const { u, v } = validPoint(point);
  const x = u * (resolution - 1), y = v * (resolution - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(resolution - 1, x0 + 1), y1 = Math.min(resolution - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const a = values[y0 * resolution + x0] * (1 - fx) +
    values[y0 * resolution + x1] * fx;
  const b = values[y1 * resolution + x0] * (1 - fx) +
    values[y1 * resolution + x1] * fx;
  return a * (1 - fy) + b * fy;
}

export function sampleTerrain(
  field: HeightField, project: TerrainProject, point: TerrainPoint,
): TerrainSample {
  const p = validPoint(point);
  const step = 1 / Math.max(1, field.resolution - 1);
  const height = (u: number, v: number) =>
    sampleGrid(field.height, field.resolution, { u, v }) * project.heightScale;
  const width = Math.max(1, project.worldSize);
  const dx = Math.max(1e-9, (clamp01(p.u + step) - clamp01(p.u - step)) * width);
  const dy = Math.max(1e-9, (clamp01(p.v + step) - clamp01(p.v - step)) * width);
  const eastGradient = (height(p.u + step, p.v) - height(p.u - step, p.v)) / dx;
  const southGradient = (height(p.u, p.v + step) - height(p.u, p.v - step)) / dy;
  return {
    point: p,
    easting: p.u * width,
    northing: (1 - p.v) * width,
    elevation: height(p.u, p.v),
    slope: Math.atan(Math.hypot(eastGradient, southGradient)) * 180 / Math.PI,
    flow: sampleGrid(field.flow, field.resolution, p),
    wear: sampleGrid(field.wear, field.resolution, p),
    deposition: sampleGrid(field.deposition, field.resolution, p),
  };
}

/** Sample a terrain transect with physical horizontal and surface distances. */
export function terrainProfile(
  field: HeightField, project: TerrainProject,
  start: TerrainPoint, end: TerrainPoint, segments = 96,
): TerrainProfile {
  const count = Math.max(2, Math.min(512, Math.round(segments)));
  const samples: TerrainSample[] = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    samples.push(sampleTerrain(field, project, {
      u: start.u + (end.u - start.u) * t,
      v: start.v + (end.v - start.v) * t,
    }));
  }
  const horizontalDistance = Math.hypot(
    (end.u - start.u) * project.worldSize, (end.v - start.v) * project.worldSize,
  );
  let surfaceDistance = 0, ascent = 0, descent = 0;
  const horizontalStep = horizontalDistance / count;
  for (let i = 1; i < samples.length; i++) {
    const rise = samples[i].elevation - samples[i - 1].elevation;
    surfaceDistance += Math.hypot(horizontalStep, rise);
    if (rise >= 0) ascent += rise;
    else descent -= rise;
  }
  const elevationChange = samples.at(-1)!.elevation - samples[0].elevation;
  return {
    samples, horizontalDistance, surfaceDistance, elevationChange, ascent, descent,
    grade: horizontalDistance > 0 ? elevationChange / horizontalDistance * 100 : 0,
  };
}

export function formatMeters(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: value < 10 ? 1 : 0 }) + ' m';
}
