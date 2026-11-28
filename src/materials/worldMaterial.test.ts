import { describe, expect, it } from 'vitest';
import { materialRanges } from './layerSynthesis';
import {
  bakeWorldMaterial,
  worldMaterialHalo,
  worldMaterialValues,
  WORLD_MATERIAL_MAPS,
} from './worldMaterial';
import { createProject } from '../model/presets';
import { createWorldDefinition } from '../model/world';
import type { HeightField } from '../model/types';
import type { FieldSampling } from '../engine/fields';

function fixture() {
  const project = createProject();
  const world = createWorldDefinition(project);
  world.domain.width = 3200;
  world.domain.depth = 1900;
  world.domain.originX = -1234.75;
  world.domain.originZ = 749.125;
  world.domain.datum = 100;
  const width = 65,
    height = 49;
  const field: HeightField = {
    resolution: width,
    height: new Float32Array(width * height),
    flow: new Float32Array(width * height),
    wear: new Float32Array(width * height),
    deposition: new Float32Array(width * height),
  };
  for (let z = 0; z < height; z++)
    for (let x = 0; x < width; x++) {
      const i = z * width + x;
      field.height[i] =
        0.1 +
        (x / (width - 1)) * 0.3 +
        (z / (height - 1)) * 0.2 +
        Math.cos(x * 0.17 + z * 0.13) * 0.09;
      field.flow[i] = (Math.sin(x * 0.19 - z * 0.13) + 1) * 0.2;
      field.wear[i] = x % 13 ? 0 : (z + 1) * 0.005;
      field.deposition[i] = z % 11 ? 0 : (x + 1) * 0.003;
    }
  project.paintLayers = [
    {
      id: 'paint',
      name: 'Art direction',
      visible: true,
      locked: false,
      opacity: 0.7,
      mask: { slope: [0, 70], breakup: 0.3, scale: 60 },
      strokes: [
        {
          layer: 'soil',
          radius: 0.15,
          hardness: 0.7,
          strength: 0.8,
          texture: 'grain',
          points: [
            { u: 0.3, v: 0.4 },
            { u: 0.7, v: 0.6 },
          ],
        },
        {
          layer: 'snow',
          radius: 0.09,
          hardness: 0.3,
          strength: 0.5,
          mode: 'blend',
          points: [{ u: 0.5, v: 0.5 }],
        },
        {
          layer: 'rock',
          source: 'soil',
          radius: 0.2,
          hardness: 0.6,
          strength: 0.4,
          mode: 'replace',
          points: [{ u: 0.5, v: 0.6 }],
        },
      ],
    },
  ];
  const dx = world.domain.width / (width - 1),
    dz = world.domain.depth / (height - 1);
  const sampling = (left: number, top: number, w: number, h: number): FieldSampling => ({
    grid: {
      width: w,
      height: h,
      originX: world.domain.originX + left * dx,
      originZ: world.domain.originZ + top * dz,
      spacingX: dx,
      spacingZ: dz,
      heightScale: project.heightScale,
      datum: world.domain.datum,
      lattice: {
        originX: world.domain.originX,
        originZ: world.domain.originZ,
        extentX: world.domain.width,
        extentZ: world.domain.depth,
        cellsX: width - 1,
        cellsZ: height - 1,
        offsetX: left,
        offsetZ: top,
      },
    },
    paint: {
      originX: world.domain.originX,
      originZ: world.domain.originZ,
      width: world.domain.width,
      depth: world.domain.depth,
    },
  });
  return { project, world, width, height, field, dx, dz, sampling };
}

describe('regional World material contract', () => {
  it('rejects non-finite diagnostics before quantization can hide them', () => {
    for (const channel of ['height', 'flow', 'wear', 'deposition'] as const)
      for (const invalid of [NaN, Infinity, -Infinity]) {
        const f = fixture(),
          ranges = materialRanges(f.field);
        f.field[channel][123] = invalid;
        expect(() =>
          bakeWorldMaterial(f.field, f.project, ranges, f.sampling(0, 0, f.width, f.height), {
            left: 0,
            top: 0,
            right: f.width,
            bottom: f.height,
          }),
        ).toThrow('non-finite');
      }
  });
  it('matches whole-field synthesis across irregular rectangular partitions, including masked grain paint, Blend, Replace and normals', () => {
    const f = fixture();
    const ranges = materialRanges(f.field),
      halo = worldMaterialHalo(f.project, f.world, f.dx, f.dz);
    const whole = bakeWorldMaterial(
      f.field,
      f.project,
      ranges,
      f.sampling(0, 0, f.width, f.height),
      { left: 0, top: 0, right: f.width, bottom: f.height },
    );
    const oracle = Object.fromEntries(
      WORLD_MATERIAL_MAPS.map((map) => [map, worldMaterialValues(whole, f.project, map)]),
    );
    for (let top = 0; top < f.height; top += 17)
      for (let left = 0; left < f.width; left += 23) {
        const width = Math.min(23, f.width - left),
          height = Math.min(17, f.height - top);
        const l = Math.max(0, left - halo.x),
          t = Math.max(0, top - halo.z);
        const right = Math.min(f.width, left + width + halo.x),
          bottom = Math.min(f.height, top + height + halo.z);
        const w = right - l,
          h = bottom - t;
        const field = { resolution: w } as HeightField;
        for (const key of ['height', 'flow', 'wear', 'deposition'] as const) {
          field[key] = new Float32Array(w * h);
          for (let z = 0; z < h; z++)
            field[key].set(
              f.field[key].subarray((t + z) * f.width + l, (t + z) * f.width + right),
              z * w,
            );
        }
        const bake = bakeWorldMaterial(field, f.project, ranges, f.sampling(l, t, w, h), {
          left: left - l,
          top: top - t,
          right: left - l + width,
          bottom: top - t + height,
        });
        for (const map of WORLD_MATERIAL_MAPS) {
          const actual = worldMaterialValues(bake, f.project, map);
          for (let z = 0; z < height; z++)
            for (let x = 0; x < width; x++)
              for (let c = 0; c < (map === 'relief' ? 1 : 4); c++)
                expect(actual(x, z, c), `${map} at ${left + x},${top + z},${c}`).toBe(
                  oracle[map](left + x, top + z, c),
                );
        }
      }
  });

  it('preserves coverage alpha and exact GL/DX channel inversion', () => {
    const f = fixture(),
      target = { left: 0, top: 0, right: f.width, bottom: f.height };
    const bake = bakeWorldMaterial(
      f.field,
      f.project,
      materialRanges(f.field),
      f.sampling(0, 0, f.width, f.height),
      target,
    );
    const splat = worldMaterialValues(bake, f.project, 'splat');
    const gl = worldMaterialValues(bake, f.project, 'materialNormalGL'),
      dx = worldMaterialValues(bake, f.project, 'materialNormalDX');
    let dataAlpha = false;
    for (let z = 0; z < f.height; z++)
      for (let x = 0; x < f.width; x++) {
        expect([0, 1, 2, 3].reduce((sum, c) => sum + Math.round(splat(x, z, c) * 255), 0)).toBe(
          255,
        );
        dataAlpha ||= splat(x, z, 3) !== 1;
        expect(gl(x, z, 0)).toBe(dx(x, z, 0));
        expect(Math.round(gl(x, z, 1) * 255) + Math.round(dx(x, z, 1) * 255)).toBe(255);
        expect(gl(x, z, 2)).toBe(dx(x, z, 2));
      }
    expect(dataAlpha).toBe(true);
  });
});
