import { describe, expect, it } from 'vitest';
import { createProject } from '../model/presets';
import { createWorldDefinition } from '../model/world';
import type { WorldRegionResult } from '../engine/world/types';
import { materialRanges } from './layerSynthesis';
import { bakeWorldMaterialPreview, worldMaterialPreviewSource } from './worldMaterialPreview';
import { updatePreviewTexture } from '../render/pbrTexture';
import { NoColorSpace, SRGBColorSpace } from 'three';

function fixture() {
  const project = { ...createProject(), worldSize: 640, heightScale: 200 };
  project.materialPaint = [
    { layer: 'rock', radius: 0.12, hardness: 0.7, strength: 0.8, points: [{ u: 0.4, v: 0.5 }] },
  ];
  const world = createWorldDefinition(project);
  Object.assign(world.domain, {
    cellsX: 64,
    cellsZ: 32,
    depth: 640,
    originX: -1280,
    originZ: 2560,
  });
  const width = 65,
    height = 33;
  const heights = Float32Array.from(
    { length: width * height },
    (_, i) => 0.25 + (i % width) / 1024 + Math.floor(i / width) / 512,
  );
  const result: WorldRegionResult = {
    width,
    height,
    heights,
    flow: new Float32Array(heights.length),
    wear: new Float32Array(heights.length),
    deposition: new Float32Array(heights.length),
    min: 0.25,
    max: 0.375,
    spacingX: 10,
    spacingZ: 20,
    stages: [],
    duration: 0,
    backend: 'cpu-reference',
    estimatedPeakBytes: 0,
  };
  const grid = { startX: 0, startZ: 0, cellsX: 64, cellsZ: 32, samplesX: width, samplesZ: height };
  return { project, world, result, grid };
}

describe('physical World material previews', () => {
  it('registers a regional preview in world space and preserves whole-domain painted positions', () => {
    const { project, world, result, grid } = fixture();
    const source = worldMaterialPreviewSource(result, world, grid);
    const ranges = materialRanges(source.field);
    const full = bakeWorldMaterialPreview(source, project, ranges);
    const width = 33,
      height = 17;
    const crop = (values: Float32Array) =>
      Float32Array.from(
        { length: width * height },
        (_, i) => values[(Math.floor(i / width) + 8) * result.width + (i % width) + 16],
      );
    const part = {
      ...result,
      width,
      height,
      heights: crop(result.heights),
      flow: crop(result.flow),
      wear: crop(result.wear),
      deposition: crop(result.deposition),
    };
    const sampling = worldMaterialPreviewSource(part, world, {
      ...grid,
      startX: 16,
      startZ: 8,
      cellsX: 32,
      cellsZ: 16,
      samplesX: width,
      samplesZ: height,
    });
    expect(sampling.sampling.grid.originX).toBe(-1120);
    expect(sampling.sampling.grid.originZ).toBe(2720);
    expect(sampling.sampling.paint).toEqual({
      originX: -1280,
      originZ: 2560,
      width: 640,
      depth: 640,
    });
    const region = bakeWorldMaterialPreview(sampling, project, ranges);
    // An affine DEM has no hidden surrounding occluders. Using shared ranges,
    // physical coordinates and paint registration keeps its ROI colors exact.
    for (let z = 1; z < height - 1; z++)
      for (let x = 1; x < width - 1; x++) {
        const local = (z * width + x) * 4,
          global = ((z + 8) * result.width + x + 16) * 4;
        expect(region.basecolor.slice(local, local + 4)).toEqual(
          full.basecolor.slice(global, global + 4),
        );
      }
    for (let i = 0; i < full.orm.length; i += 4) {
      expect(full.orm[i + 2]).toBe(0);
      expect(full.orm[i + 3]).toBe(255);
      expect(full.detailNormal[i + 3]).toBe(255);
    }
  });

  it('aligns rectangular endpoint samples with texel centers and keeps data channels linear', () => {
    const pixels = new Uint8ClampedArray(7 * 3 * 4);
    const albedo = updatePreviewTexture(undefined, pixels, 7, true, 4, 3);
    const orm = updatePreviewTexture(undefined, pixels, 7, false, 4, 3);
    expect(albedo.colorSpace).toBe(SRGBColorSpace);
    expect(orm.colorSpace).toBe(NoColorSpace);
    expect(albedo.flipY).toBe(true);
    for (let x = 0; x < 7; x++)
      expect((x / 6) * albedo.repeat.x + albedo.offset.x).toBeCloseTo((x + 0.5) / 7, 14);
    for (let z = 0; z < 3; z++)
      expect((1 - z / 2) * albedo.repeat.y + albedo.offset.y).toBeCloseTo(1 - (z + 0.5) / 3, 14);
    expect(updatePreviewTexture(albedo, pixels.slice(), 7, true, 2, 3)).toBe(albedo);
    albedo.dispose();
    orm.dispose();
  });
});
