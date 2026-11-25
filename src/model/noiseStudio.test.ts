import { describe, expect, it } from 'vitest';
import {
  applyNoisePreset,
  decodeNoiseRecipe,
  deriveSeed,
  encodeNoiseRecipe,
  hashSeedText,
  NOISE_PRESETS,
  parseStudioCurve,
  resolveNoiseSeed,
  resolveStudioSettings,
  STUDIO_DEFAULTS,
  STUDIO_PARAMS,
  studioParamVisible,
  upgradeNoiseParams,
  validateStudioParams,
} from './noiseStudio';
import { createNode } from './registry';
import { parseProject } from './project';
import { createProject, PRESETS } from './presets';
import type { ParamValue } from './types';

const settings = (patch: Record<string, ParamValue> = {}) => ({ ...STUDIO_DEFAULTS, ...patch });
describe('Noise Studio seed and recipe contracts', () => {
  it('uses stable integer streams and distinct named seeds without graph IDs', () => {
    // Published FNV-1a vectors check the string hash independently.
    expect(hashSeedText('')).toBe(2166136261);
    expect(hashSeedText('hello')).toBe(0x4f9f2cab);
    const seeds = Array.from({ length: 1024 }, (_, i) => deriveSeed(42, i));
    expect(new Set(seeds).size).toBe(seeds.length);
    expect(seeds.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff)).toBe(true);
    expect(resolveNoiseSeed(settings({ seedText: 'Granite α' }), 42)).toBe(
      resolveNoiseSeed(settings({ seedText: 'Granite α' }), 42),
    );
    expect(resolveNoiseSeed(settings({ seedText: 'Granite α' }), 42)).not.toBe(
      resolveNoiseSeed(settings({ seedText: 'Granite β' }), 42),
    );
  });
  it('links to the master seed, supports independence, and freezes the resolved stream', () => {
    const linked = settings({ seed: 17, seedText: 'ridge' });
    expect(resolveNoiseSeed(linked, 42)).not.toBe(resolveNoiseSeed(linked, 43));
    expect(resolveNoiseSeed({ ...linked, seedMode: 'fixed' }, 42)).toBe(
      resolveNoiseSeed({ ...linked, seedMode: 'fixed' }, 43),
    );
    const locked = { ...linked, seedLocked: true, lockedSeed: resolveNoiseSeed(linked, 42) };
    expect(resolveNoiseSeed(locked, 43)).toBe(resolveNoiseSeed(linked, 42));
    expect(resolveNoiseSeed({ ...locked, seed: 999, seedText: 'changed' }, 1)).toBe(
      locked.lockedSeed,
    );
    expect(() => validateStudioParams({ seedLocked: true, lockedSeed: 0xffffffff })).not.toThrow();
    expect(
      decodeNoiseRecipe(encodeNoiseRecipe(settings({ seedLocked: true, lockedSeed: 0xffffffff })))
        .lockedSeed,
    ).toBe(0xffffffff);
  });
  it('round-trips every authored recipe without silently moving accepted controls', () => {
    for (const p of NOISE_PRESETS) {
      const values = settings(p.params);
      expect(() => validateStudioParams(values), p.id).not.toThrow();
      expect(decodeNoiseRecipe(encodeNoiseRecipe(values))).toEqual({ ...values, noiseModel: 'v3' });
    }
    const tightRange = settings({ blackPoint: 0.5, whitePoint: 0.51, octaves: 4.125 });
    expect(decodeNoiseRecipe(encodeNoiseRecipe(tightRange))).toEqual({
      ...tightRange,
      noiseModel: 'v3',
    });
    const locked = settings({
      seed: 417,
      seedText: 'shelf',
      seedLocked: true,
      lockedSeed: 0xfedcba98,
      warpSeedMode: 'fixed',
      warpSeed: 55,
    });
    const result = applyNoisePreset(locked, NOISE_PRESETS[0]);
    for (const key of ['seed', 'seedText', 'seedLocked', 'lockedSeed', 'warpSeedMode', 'warpSeed'])
      expect(result[key]).toBe(locked[key as keyof typeof locked]);
  });
  it('rejects unsafe or ambiguous recipes rather than accepting malformed settings', () => {
    for (const patch of [
      { seed: 0.5 },
      { seed: -1 },
      { lockedSeed: 0x100000000 },
      { warpSeed: Infinity },
      { seedText: 'x'.repeat(129) },
      { curve: '[[0,0],[0,1],[1,1]]' },
      { curve: '[[0.1,0],[1,1]]' },
      { curve: '[[0,0],[1,2]]' },
      { curve: '[]' },
      { seedLocked: true },
      { blackPoint: 0.5, whitePoint: 0.5 },
      { blackPoint: 0.5, whitePoint: 0.500001, clampOutput: false, gamma: 0.1 },
      { kernel: 'unknown' },
      { invert: 'yes' },
      { gaborDensity: 2.5 },
    ])
      expect(() => validateStudioParams(patch), JSON.stringify(patch)).toThrow();
    expect(() =>
      decodeNoiseRecipe(
        JSON.stringify({ format: 'normal-height-noise', version: 1, engine: 4, params: {} }),
      ),
    ).toThrow();
    expect(() => decodeNoiseRecipe(' '.repeat(20001))).toThrow();
    expect(parseStudioCurve('[[0,1],[0.5,0],[1,1]]')).toHaveLength(3); // Artist curves may be nonmonotone in Y.
    expect(parseStudioCurve('[[0,0],[0.101,0],[0.102,1],[1,1]]')).toHaveLength(4); // Decimal spacing tolerates binary rounding.
    expect(resolveStudioSettings({ curve: 'malformed', octaves: NaN }).curve).toBe(
      STUDIO_DEFAULTS.curve,
    );
  });
  it('exposes only controls used by the selected feature', () => {
    expect(
      studioParamVisible(
        settings({ kernel: 'cellular', cellularReturn: 'edge' }),
        'cellularMetric',
      ),
    ).toBe(false);
    expect(studioParamVisible(settings({ scaleMode: 'world' }), 'scale')).toBe(false);
    expect(studioParamVisible(settings({ scaleMode: 'world' }), 'featureSize')).toBe(true);
    expect(studioParamVisible(settings({ fractal: 'none' }), 'octaves')).toBe(false);
    expect(
      studioParamVisible(settings({ fractal: 'swiss', kernel: 'perlin' }), 'derivativeDamping'),
    ).toBe(false);
    expect(
      studioParamVisible(settings({ fractal: 'jordan', kernel: 'perlin' }), 'derivativeDamping'),
    ).toBe(true);
    expect(
      studioParamVisible(settings({ fractal: 'swiss', kernel: 'white' }), 'derivativeWarp'),
    ).toBe(false);
    expect(new Set(STUDIO_PARAMS.map((d) => d.key)).size).toBe(STUDIO_PARAMS.length);
  });
});

describe('Studio project integration', () => {
  it('makes new nodes Studio and preserves both older version choices on load', () => {
    const source = createNode('noise', undefined, 'noise');
    expect(source.params.noiseModel).toBe('v3');
    const project = createProject();
    project.graph = { nodes: [source], edges: [] };
    Object.assign(source.params, {
      scale: 63,
      octaves: 11.5,
      persistence: 0,
      lacunarity: 1,
      seedLocked: true,
      lockedSeed: 0xfedcba98,
    });
    expect(parseProject(JSON.parse(JSON.stringify(project)))).toEqual(project);
    source.params.scale = 3.4;
    source.params.octaves = 6;
    source.params.persistence = 0.5;
    source.params.lacunarity = 2.05;
    for (const version of ['legacy', 'v2']) {
      source.params.noiseModel = version;
      expect(
        parseProject(JSON.parse(JSON.stringify(project))).graph.nodes[0].params.noiseModel,
      ).toBe(version);
    }
    delete source.params.noiseModel;
    expect(parseProject(JSON.parse(JSON.stringify(project))).graph.nodes[0].params.noiseModel).toBe(
      'legacy',
    );
  });
  it('validates Studio imports and keeps authored older terrain presets versioned', () => {
    const project = createProject('studio-dunes');
    expect(project.graph.nodes[0].params.noiseModel).toBe('v3');
    project.graph.nodes[0].params.seed = 1.25;
    expect(() => parseProject(project)).toThrow(/integer/);
    for (const p of PRESETS.filter((p) => !p.id.startsWith('studio-')))
      for (const node of p.build())
        if (node.kind === 'noise') expect(node.params.noiseModel).toBe('v2');
    const upgraded = upgradeNoiseParams({ mode: 'voronoi-edge', stretch: 2, seed: 19, scale: 4 });
    expect(upgraded).toMatchObject({
      noiseModel: 'v3',
      kernel: 'cellular',
      cellularReturn: 'gap',
      scaleX: 0.5,
      scaleY: 2,
      seed: 19,
    });
  });
});
