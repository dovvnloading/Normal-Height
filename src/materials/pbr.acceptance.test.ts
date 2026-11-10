import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { createProject, PRESETS } from '../model/presets';
import { parseProject } from '../model/project';
import { makeExport } from '../export/heightmap';
import type { HeightField } from '../model/types';
import { generatePBR, linearToSrgbByte, resolveSurface, srgbByteToLinear } from './pbr';
import { Noise } from '../engine/noise';

/** Exact analytic terrain defined in world-normalized coordinates, not pixel space. */
function analyticField(n: number, kind: 'valley' | 'ramp' = 'valley'): HeightField {
  const count = n * n;
  const height = new Float32Array(count);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = x / (n - 1), v = y / (n - 1);
    height[y * n + x] = kind === 'ramp'
      ? v
      : 0.1 + 0.55 * (u - 0.5) ** 2 + 0.35 * (v - 0.5) ** 2;
  }
  return {
    resolution: n, height,
    flow: new Float32Array(count),
    wear: new Float32Array(count),
    deposition: new Float32Array(count),
  };
}

describe('PBR issue acceptance regressions', () => {
  it('initializes and round-trips the biome for every scene preset (#12)', () => {
    const expected: Record<string, string> = {
      'river-gorge': 'alpine', alpine: 'alpine', massif: 'alpine',
      badlands: 'arid', volcano: 'volcanic', highlands: 'alpine',
    };
    expect(PRESETS.map((preset) => preset.id).sort()).toEqual(Object.keys(expected).sort());
    const field = analyticField(64);
    for (const preset of PRESETS) {
      const scene = createProject(preset.id);
      expect(resolveSurface(scene.surface).biome, preset.id).toBe(expected[preset.id]);
      const restored = parseProject(JSON.parse(JSON.stringify(scene)));
      expect(restored.surface).toEqual(scene.surface);
      expect(generatePBR(field, restored).basecolor).toEqual(generatePBR(field, scene).basecolor);
    }
    const custom = createProject('badlands');
    custom.surface = { ...resolveSurface(custom.surface), biome: 'volcanic', moisture: 0.83 };
    const reopened = parseProject(custom);
    expect(reopened.surface).toEqual(custom.surface);
    // Changing presets creates a fresh scene; it does not mutate the saved one.
    expect(createProject('volcano').surface?.moisture).toBe(0.24);
    expect(custom.surface.biome).toBe('volcanic');
  });

  it('exports effective legacy defaults and explicit GL/DX/channel contracts (#16)', () => {
    const legacy = { ...createProject('alpine'), surface: undefined };
    const field = analyticField(64);
    const original = JSON.stringify(legacy);
    const zip = unzipSync(makeExport(field, legacy, 'pbr', false).bytes);
    const meta = JSON.parse(strFromU8(zip['alpine-watershed-material-metadata.json']));
    const restored = parseProject(JSON.parse(strFromU8(zip['alpine-watershed.nhterrain.json'])));
    expect(meta.surfaceSchemaVersion).toBe(1);
    expect(meta.surface).toEqual(resolveSurface());
    expect(restored.surface).toEqual(resolveSurface());
    expect(meta.textureChannels.basecolor.colorSpace).toBe('sRGB');
    expect(meta.textureChannels.normal_dx.channels[1]).toBe('normalY_DirectX');
    expect(JSON.stringify(legacy)).toBe(original);

    for (const [format, colorSpace, channel] of [
      ['normalDX', 'linear-non-color', 'normalY_DirectX'],
      ['basecolor', 'sRGB', 'red'],
      ['orm', 'linear-non-color', 'occlusion'],
    ] as const) {
      const files = unzipSync(makeExport(field, legacy, format, true).bytes);
      const metadata = JSON.parse(strFromU8(files['alpine-watershed-metadata.json']));
      const archived = parseProject(JSON.parse(strFromU8(files['alpine-watershed.nhterrain.json'])));
      expect(metadata.colorSpace).toBe(colorSpace);
      expect(metadata.channelNames[format === 'normalDX' ? 1 : 0]).toBe(channel);
      expect(metadata.surfaceSchemaVersion).toBe(1);
      expect(metadata.surface).toEqual(resolveSurface());
      expect(archived.surface).toEqual(resolveSurface());
      if (format === 'normalDX') expect(metadata.normalConvention).toContain('DirectX -Y');
    }
  });

  it('samples equivalent AO horizons and resolved detail at the same world coordinates (#13)', () => {
    const project = {
      ...createProject(), worldSize: 1000, heightScale: 1400,
      surface: { ...resolveSurface(), detailMeters: 200, detailStrength: 1, aoStrength: 1 },
    };
    const coarse = generatePBR(analyticField(129), project);
    const fine = generatePBR(analyticField(257), project);
    // Coordinates are exactly the same in world space (1/2, 3/8).
    const sampleCoarse = 48 * 129 + 64;
    const sampleFine = 96 * 257 + 128;
    expect(coarse.ao[sampleCoarse]).toBeLessThan(255);
    expect(Math.abs(coarse.ao[sampleCoarse] - fine.ao[sampleFine])).toBeLessThanOrEqual(2);
    expect(Math.abs(coarse.detail[sampleCoarse] - fine.detail[sampleFine])).toBeLessThan(0.00001);
    expect(Math.abs(coarse.basecolor[sampleCoarse * 4] - fine.basecolor[sampleFine * 4]))
      .toBeLessThanOrEqual(2);
  });

  it('keeps the snow/rock/vegetation gradient consistent with independent linear-light pixels (#14)', () => {
    const scene = {
      ...createProject('alpine'), worldSize: 8000,
      surface: { ...resolveSurface(), snowLine: 0.5, rockSlope: 75,
        moisture: 0, detailStrength: 0 },
    };
    const field = analyticField(65, 'ramp');
    const maps = generatePBR(field, scene);
    const palette = [
      [122, 118, 108], [118, 100, 78], [83, 106, 68], [224, 231, 232],
    ];
    const noise = new Noise((scene.seed + 0x3b9aca07) >>> 0);
    let mixed = 0, linearMixAdvantage = 0;
    const n = field.resolution, x = 32;
    for (let y = 1; y < n - 1; y++) {
      const p = (y * n + x) * 4;
      const snow = maps.splat[p + 3];
      if (snow <= 20 || snow >= 235) continue;
      mixed++;
      const weights = Array.from(maps.splat.subarray(p, p + 4), (v) => v / 255);
      const macro = noise.simplex((x / (n - 1)) * 17.1 + 3.9, (y / (n - 1)) * 17.1 - 7.2);
      // At this sampling grid, the 24 m microstructure falls below Nyquist.
      const tint = 1 + macro * 0.075;
      const expected = linearToSrgbByte(
        weights.reduce((sum, w, layer) => sum + srgbByteToLinear(palette[layer][0]) * w, 0) * tint,
      );
      const encodedMix = weights.reduce((sum, w, layer) => sum + palette[layer][0] * w, 0);
      expect(Math.abs(maps.basecolor[p] - expected)).toBeLessThanOrEqual(2);
      if (Math.abs(maps.basecolor[p] - encodedMix) > 4) linearMixAdvantage++;
      expect(maps.basecolor[p + 3]).toBe(255);
    }
    expect(mixed).toBeGreaterThan(3);
    expect(linearMixAdvantage).toBeGreaterThan(1);
  });
});
