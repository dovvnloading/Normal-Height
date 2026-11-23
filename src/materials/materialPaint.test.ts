import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { createProject } from '../model/presets';
import { parseProject } from '../model/project';
import { makeExport } from '../export/heightmap';
import type { HeightField } from '../model/types';
import { generatePBR, materialNormalPixels, resolveSurface } from './pbr';
import {
  createMaterialPaintRaster,
  parseMaterialPaint,
  type MaterialStroke,
} from './materialPaint';
import { pbrVariantKey } from './pbrClient';

const dab: MaterialStroke = {
  layer: 'rock',
  radius: 0.25,
  hardness: 0.5,
  strength: 1,
  points: [{ u: 0.5, v: 0.5 }],
};
const sample = (strokes: MaterialStroke[], x: number, y: number, n = 17) => {
  const row = createMaterialPaintRaster(strokes, n)!.row(y);
  return Array.from(row.subarray(x * 4, x * 4 + 4));
};

describe('terrain material painting', () => {
  it('evaluates a radius and feather in terrain coordinates at every resolution', () => {
    expect(sample([dab], 8, 8)).toEqual([1, 0, 0, 0]);
    expect(sample([dab], 11, 8)).toEqual([0.5, 0, 0, 0]);
    expect(sample([dab], 22, 16, 33)).toEqual([0.5, 0, 0, 0]);
    expect(sample([dab], 12, 8)).toEqual([0, 0, 0, 0]);
    expect(sample([{ ...dab, hardness: 1 }], 12, 8)).toEqual([1, 0, 0, 0]);
  });
  it('composites a swept stroke once regardless of sample count, intersections or direction', () => {
    const a = { u: 0, v: 0 },
      b = { u: 1, v: 1 },
      mid = { u: 0.5, v: 0.5 };
    const coarse = createMaterialPaintRaster([{ ...dab, strength: 0.4, points: [a, b] }], 33)!;
    const dense = createMaterialPaintRaster(
      [{ ...dab, strength: 0.4, points: [b, mid, a, b, b] }],
      33,
    )!;
    for (let y = 0; y < 33; y++) expect(dense.row(y)).toEqual(coarse.row(y));
    const strokes: MaterialStroke[] = [
      dab,
      { ...dab, layer: 'snow', strength: 0.5 },
      { ...dab, layer: 'erase', strength: 0.5 },
    ];
    expect(sample(strokes, 8, 8)).toEqual([0.25, 0, 0, 0.25]);
  });
  it('replays authored coverage on the complete bake and restores procedural output on erase', () => {
    const n = 65,
      count = n * n;
    const field: HeightField = {
      resolution: n,
      height: new Float32Array(count).fill(0.4),
      flow: new Float32Array(count),
      wear: new Float32Array(count),
      deposition: new Float32Array(count),
    };
    const base = {
      ...createProject(),
      worldSize: 180,
      surface: { ...resolveSurface(), layerColors: { snow: '#dcf7ff' } },
    };
    const painted = { ...base, materialPaint: [{ ...dab, layer: 'snow' as const }] };
    const restored = parseProject(JSON.parse(JSON.stringify(painted)));
    const cleared = {
      ...painted,
      materialPaint: [...painted.materialPaint, { ...dab, layer: 'erase' as const }],
    };
    const raw = generatePBR(field, base),
      edit = generatePBR(field, restored),
      erased = generatePBR(field, cleared);
    expect(restored.materialPaint).toEqual(painted.materialPaint);
    expect(restored.surface).toEqual(base.surface);
    const center = 32 * n + 32,
      p = center * 4;
    expect(Array.from(edit.splat.slice(p, p + 4))).toEqual([0, 0, 0, 255]);
    expect(edit.basecolor[p + 2]).toBeGreaterThan(raw.basecolor[p + 2] + 50);
    expect(edit.roughness[center]).not.toBe(raw.roughness[center]);
    expect(edit.detail[center]).not.toBe(raw.detail[center]);
    for (const key of ['roughness', 'detail', 'ao', 'curvature', 'basecolor', 'splat'] as const) {
      const i = key === 'basecolor' || key === 'splat' ? p : center;
      expect(erased[key][i]).toBe(raw[key][i]);
      expect(edit[key][0]).toBe(raw[key][0]);
    }
    const zip = unzipSync(makeExport(field, restored, 'pbr', true).bytes);
    const projectFile = Object.keys(zip).find((name) => name.endsWith('.nhterrain.json'))!;
    expect(parseProject(JSON.parse(strFromU8(zip[projectFile]))).materialPaint).toEqual(
      restored.materialPaint,
    );
    const relief = Object.keys(zip).find((name) => name.endsWith('-relief16.png'))!;
    expect(Array.from(zip[relief].subarray(24, 26))).toEqual([16, 0]);
    expect(pbrVariantKey(base)).not.toBe(pbrVariantKey(painted));
    expect(pbrVariantKey(painted)).toBe(pbrVariantKey({ ...painted }));
  });
  it('validates imported brushes and retains legacy projects', () => {
    expect(parseProject(createProject()).materialPaint).toBeUndefined();
    for (const bad of [
      { radius: 0 },
      { hardness: NaN },
      { layer: '__proto__' },
      { layer: ['rock'] },
      { points: [] },
      { points: [{ u: 1, v: -0.1 }] },
    ])
      expect(() => parseMaterialPaint([{ ...dab, ...bad }])).toThrow();
    expect(() =>
      parseProject({ ...createProject(), surface: { layerColors: { rock: 'red' } } }),
    ).toThrow();
  });
});

it('detail-only normals reconstruct the combined world normal on an oblique ramp', () => {
  const n = 3,
    data = new Float32Array(n * n);
  const field = {
    resolution: n,
    height: data.map((_, i) => 0.6 * (i % 3) - 0.8 * Math.floor(i / 3)),
    flow: data,
    wear: data,
    deposition: data,
  };
  const project = { ...createProject(), worldSize: 2, heightScale: 1 };
  const maps = generatePBR(field, project);
  maps.detail = data.map((_, i) => 0.25 * (i % 3) + 0.12 * Math.floor(i / 3));
  const pixels = materialNormalPixels(maps, field, project, true);
  const [tx, ty, tz] = Array.from(pixels.slice(16, 19), (x) => x / 127.5 - 1);
  const gx = 0.6,
    gy = -0.8,
    T = Math.hypot(1, gx),
    N = Math.hypot(1, gx, gy);
  const actual = [
    tx / T + (ty * gx * gy) / (N * T) - (tz * gx) / N,
    (tx * gx) / T - (ty * gy) / (N * T) + tz / N,
    (-ty * T) / N - (tz * gy) / N,
  ];
  const expected = [-0.85, 1, 0.68],
    length = Math.hypot(...expected);
  for (let c = 0; c < 3; c++)
    expect(Math.abs(actual[c] - expected[c] / length)).toBeLessThan(0.007);
});
