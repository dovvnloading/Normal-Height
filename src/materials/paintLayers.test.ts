import { describe, expect, it } from 'vitest';
import { createProject } from '../model/presets';
import { parseProject } from '../model/project';
import type { HeightField } from '../model/types';
import {
  createMaterialPaintRaster,
  evaluatePaintMask,
  parseMaterialPaint,
  pointInPaintSelection,
  type MaterialStroke,
} from './materialPaint';
import {
  applyPaintStrokes,
  createPaintLayer,
  createProjectPaintRaster,
  floodPaintSelection,
  getPaintLayers,
  getPaintStrokes,
  paintLayerSignature,
  samplePaintMaterial,
  type PaintLayer,
} from './paintLayers';
import { generatePBR } from './pbr';
import { pbrVariantKey } from './pbrClient';
import { paintChangeBounds } from './materialRegion';

const n = 17;
const project = { ...createProject(), worldSize: 160, heightScale: 100 };
const field = (): HeightField => ({
  resolution: n,
  height: new Float32Array(n * n).fill(0.4),
  flow: new Float32Array(n * n),
  wear: new Float32Array(n * n),
  deposition: new Float32Array(n * n),
});
const dab: MaterialStroke = {
  layer: 'snow',
  radius: 0.25,
  hardness: 1,
  strength: 1,
  points: [{ u: 0.5, v: 0.5 }],
};
const layer = (id: string, strokes: MaterialStroke[], opacity = 1): PaintLayer => ({
  ...createPaintLayer(id, id),
  strokes,
  opacity,
});
const sample = (layers: PaintLayer[], x = 8, y = 8, base = [1, 0, 0, 0]) => {
  const raster = createProjectPaintRaster({ ...project, paintLayers: layers }, field(), () => base);
  return raster?.apply(x, y, base) ?? base;
};

describe('authored paint layers', () => {
  it('preserves legacy strokes until an explicit layer edit and round-trips the stack', () => {
    const legacy = { ...project, materialPaint: [dab] };
    expect(getPaintLayers(project)).toMatchObject([{ id: 'paint-base', strokes: [] }]);
    const old = getPaintLayers(legacy);
    expect(old[0].strokes).toBe(legacy.materialPaint);
    expect(getPaintLayers(legacy)).toBe(old);
    const stacked = { ...project, paintLayers: [old[0], layer('Snow caps', [])] };
    const next = applyPaintStrokes(stacked, [{ ...dab, layer: 'soil' }], 'Snow caps');
    expect(stacked.paintLayers[1].strokes).toHaveLength(0);
    expect(next.paintLayers![1].strokes).toHaveLength(1);
    const restored = parseProject(JSON.parse(JSON.stringify(next)));
    expect(restored.paintLayers).toEqual(next.paintLayers);
    expect(getPaintStrokes(next)).toBe(getPaintStrokes(next));
    expect(getPaintStrokes(next)).toHaveLength(2);
    expect(pbrVariantKey(next)).not.toBe(pbrVariantKey(stacked));
    expect(paintLayerSignature(next)).toBe(paintLayerSignature({ ...next }));
    expect(pbrVariantKey(next)).toBe(
      pbrVariantKey({
        ...next,
        paintLayers: next.paintLayers!.map((item) => ({ ...item, name: 'Renamed', locked: true })),
      }),
    );
    expect(applyPaintStrokes(legacy, [dab]).materialPaint).toHaveLength(2);
  });
  it('applies opacity once to a layer and erases only that layer', () => {
    const snow = layer('Snow', [dab, dab], 0.5);
    expect(sample([snow])).toEqual([0.5, 0, 0, 0.5]);
    const soil = layer('Soil', [{ ...dab, layer: 'soil' }]);
    const erased = { ...snow, strokes: [...snow.strokes, { ...dab, layer: 'erase' as const }] };
    expect(sample([soil, erased])).toEqual([0, 1, 0, 0]);
    expect(sample([snow, soil])).toEqual([0, 1, 0, 0]);
    expect(sample([soil, snow])).toEqual([0, 0.5, 0, 0.5]);
    expect(sample([soil, { ...snow, visible: false }])).toEqual([0, 1, 0, 0]);
    expect(() =>
      applyPaintStrokes({ ...project, paintLayers: [{ ...snow, locked: true }] }, [dab], snow.id),
    ).toThrow('locked');
    expect(() =>
      applyPaintStrokes({ ...project, paintLayers: [{ ...snow, visible: false }] }, [dab], snow.id),
    ).toThrow('hidden');
  });
  it('masks a layer once and recomputes the material, roughness and relief from its resulting weights', () => {
    const p = { ...project, paintLayers: [layer('Snow', [dab])] };
    const dem = field(),
      baked = generatePBR(dem, p),
      hidden = generatePBR(dem, {
        ...p,
        paintLayers: [{ ...p.paintLayers[0], mask: { elevation: [50, 100], feather: 0 } }],
      });
    const raw = generatePBR(dem, project),
      i = 8 * n + 8;
    expect(Array.from(baked.splat.slice(i * 4, i * 4 + 4))).toEqual([0, 0, 0, 255]);
    expect(hidden.splat).toEqual(raw.splat);
    expect(baked.roughness[i]).not.toBe(raw.roughness[i]);
    expect(baked.detail[i]).not.toBe(raw.detail[i]);
  });
  it('selectively replaces visible substrate including procedural coverage', () => {
    const replace = layer('Replacement', [
      { ...dab, layer: 'snow', mode: 'replace', source: 'soil', strength: 0.5 },
    ]);
    expect(sample([replace], 8, 8, [0.4, 0.6, 0, 0])).toEqual([0.4, 0.3, 0, 0.3]);
    sample([{ ...replace, opacity: 0.5 }], 8, 8, [0.4, 0.6, 0, 0]).forEach((value, i) =>
      expect(value).toBeCloseTo([0.4, 0.45, 0, 0.15][i]),
    );
  });
  it('smooths material boundaries from earlier strokes, without changing weights far outside the brush', () => {
    const edge: MaterialStroke = {
      ...dab,
      layer: 'snow',
      fullTile: true,
      selection: {
        points: [
          { u: 0, v: 0 },
          { u: 0.48, v: 0 },
          { u: 0.48, v: 1 },
          { u: 0, v: 1 },
        ],
      },
    };
    const before = layer('Snow', [edge]);
    const blend = layer('Blend', [{ ...dab, radius: 0.4, mode: 'blend' }]);
    expect(sample([before], 8, 8)).toEqual([1, 0, 0, 0]);
    const smoothed = sample([before, blend], 8, 8);
    expect(smoothed[0]).toBeLessThan(1);
    expect(smoothed[3]).toBeGreaterThan(0);
    expect(smoothed.reduce((a, b) => a + b)).toBeCloseTo(1);
    expect(sample([before, blend], 16, 16)).toEqual([1, 0, 0, 0]);
  });
  it('rejects duplicate layer ids and invalid optional brush state at the file boundary', () => {
    expect(() =>
      parseProject({ ...project, paintLayers: [layer('same', []), layer('same', [])] }),
    ).toThrow('duplicate');
    for (const bad of [
      { pressure: 'time' },
      { spacing: Infinity },
      { angle: NaN },
      { aspect: 0 },
      { mask: { elevation: [60, 40] } },
      { selection: { points: [{ u: 0, v: 0 }] } },
      { points: [{ u: 0.5, v: 0.5, pressure: -1 }] },
      { selection: { points: [], region: { resolution: 8, runs: [3, 5, 2] } } },
    ]) {
      expect(() => parseMaterialPaint([{ ...dab, ...bad }])).toThrow();
    }
    const advanced: MaterialStroke = {
      ...dab,
      pressure: 'both',
      texture: 'grain',
      aspect: 0.5,
      angle: 30,
      spacing: 0.2,
      seed: 42,
      jitter: 0.3,
      mode: 'replace',
      source: 'soil',
      mask: { elevation: [20, 80], aspect: [300, 60], scale: 24, breakup: 0.6 },
      points: [{ u: 0.5, v: 0.5, pressure: 0.4 }],
    };
    expect(parseMaterialPaint([advanced])).toEqual([advanced]);
  });
});

describe('terrain masks and brush dynamics', () => {
  it('uses physical slope/elevation/flow and feathering', () => {
    const dem = field();
    dem.height = Float32Array.from({ length: n * n }, (_, i) => (i % n) / (n - 1));
    dem.flow.fill(0.6);
    const middle = { u: 0.5, v: 0.5 };
    expect(
      evaluatePaintMask(
        { elevation: [40, 60], slope: [30, 35], flow: [0.5, 0.7], feather: 0 },
        middle,
        dem,
        project,
      ),
    ).toBe(1);
    expect(evaluatePaintMask({ slope: [0, 20] }, middle, dem, project)).toBe(0);
    expect(evaluatePaintMask({ elevation: [50, 80], feather: 0.5 }, middle, dem, project)).toBe(0);
    expect(evaluatePaintMask({ aspect: [240, 300], feather: 0 }, middle, dem, project)).toBe(1);
    expect(evaluatePaintMask({ aspect: [300, 60], feather: 0 }, middle, dem, project)).toBe(0);
  });
  it('keeps the eligibility guide aligned with breakup masks across gesture texture seeds', () => {
    const dem = field();
    const mask = { breakup: 0.8, scale: 12, feather: 0 };
    const point = { u: 0.5, v: 0.5 };
    const expected = evaluatePaintMask(mask, point, dem, project);
    for (const seed of [19, 8123]) {
      const raster = createMaterialPaintRaster([{ ...dab, layer: 'rock', seed, mask }], n, {
        field: dem,
        project,
      })!;
      expect(raster.row(8)[8 * 4]).toBeCloseTo(expected, 6);
    }
  });
  it('uses pressure for radius/strength and supports rotated elliptical brushes', () => {
    const pressure = createMaterialPaintRaster(
      [{ ...dab, layer: 'rock', pressure: 'both', points: [{ u: 0.5, v: 0.5, pressure: 0.5 }] }],
      n,
    )!;
    expect(pressure.row(8)[8 * 4]).toBe(0.5);
    expect(pressure.row(8)[11 * 4]).toBe(0);
    const horizontal = createMaterialPaintRaster([{ ...dab, layer: 'rock', aspect: 0.25 }], n)!;
    const vertical = createMaterialPaintRaster(
      [{ ...dab, layer: 'rock', aspect: 0.25, angle: 90 }],
      n,
    )!;
    expect(horizontal.row(8)[11 * 4]).toBe(1);
    expect(horizontal.row(11)[8 * 4]).toBe(0);
    expect(vertical.row(11)[8 * 4]).toBe(1);
  });
  it('replays grain/breakup deterministically and includes full fills/jitter in dirty bounds', () => {
    const stroke: MaterialStroke = {
      ...dab,
      layer: 'soil',
      texture: 'grain',
      seed: 123,
      mask: { breakup: 0.7, scale: 12 },
    };
    const a = createMaterialPaintRaster([stroke], n, { field: field(), project })!;
    const b = createMaterialPaintRaster([stroke], n, { field: field(), project })!;
    for (let y = 0; y < n; y++) expect(a.row(y)).toEqual(b.row(y));
    expect(paintChangeBounds([], [{ ...dab, fullTile: true }], n)).toEqual({
      left: 0,
      top: 0,
      right: n,
      bottom: n,
    });
    const ordinary = paintChangeBounds([], [dab], n)!,
      jitter = paintChangeBounds([], [{ ...dab, jitter: 1 }], n)!;
    expect(jitter.left).toBeLessThan(ordinary.left);
    expect(jitter.right).toBeGreaterThan(ordinary.right);
  });
  it('clips polygon and connected flood selections, including inversion and disconnected islands', () => {
    const map = new Uint8ClampedArray(n * n * 4);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        map[(y * n + x) * 4 + (x < 5 || x > 12 ? 3 : 0)] = 255;
      }
    expect(samplePaintMaterial(map, n, { u: 0, v: 0.5 })).toBe('snow');
    const selection = floodPaintSelection(map, n, { u: 0, v: 0.5 }, 0);
    expect(pointInPaintSelection(selection, { u: 0.1, v: 0.5 })).toBe(true);
    expect(pointInPaintSelection(selection, { u: 0.9, v: 0.5 })).toBe(false);
    expect(pointInPaintSelection({ ...selection, invert: true }, { u: 0.9, v: 0.5 })).toBe(true);
    const filled = createMaterialPaintRaster([{ ...dab, fullTile: true, selection }], n)!.row(8);
    expect(filled[1 * 4 + 3]).toBe(1);
    expect(filled[15 * 4 + 3]).toBe(0);
    expect(parseMaterialPaint([{ ...dab, fullTile: true, selection }])[0].selection).toEqual(
      selection,
    );
  });
});
