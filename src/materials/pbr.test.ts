import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { createProject } from '../model/presets';
import { parseProject } from '../model/project';
import { makeExport } from '../export/heightmap';
import type { HeightField } from '../model/types';
import { generatePBR, materialNormalPixels, pbrPixels, resolveSurface } from './pbr';

function fixture(n = 16, flat = false): HeightField {
  const size = n * n;
  return {
    resolution: n,
    height: Float32Array.from({ length: size }, (_, i) =>
      flat ? 0.5 : 0.08 + 0.85 * (Math.floor(i / n) / (n - 1)) +
        0.07 * Math.sin((i % n) / n * Math.PI * 4)),
    flow: Float32Array.from({ length: size }, (_, i) => i % 13 === 0 ? 1 : 0),
    wear: Float32Array.from({ length: size }, (_, i) => i % 11 === 0 ? 0.03 : 0),
    deposition: Float32Array.from({ length: size }, (_, i) => i % 7 === 0 ? 0.05 : 0),
  };
}

describe('material maps', () => {
  it('creates deterministic, aligned maps without changing the simulation output', () => {
    const project = createProject();
    const field = fixture();
    const before = Array.from(field.height);
    const a = generatePBR(field, project);
    const b = generatePBR(field, project);
    expect(a.basecolor).toEqual(b.basecolor);
    expect(a.roughness).toEqual(b.roughness);
    expect(a.splat).toEqual(b.splat);
    expect(a.ao).toEqual(b.ao);
    expect(a.basecolor).toHaveLength(16 * 16 * 4);
    expect(a.roughness).toHaveLength(16 * 16);
    for (let i = 0; i < field.height.length; i++) {
      const p = i * 4;
      expect(a.splat[p] + a.splat[p + 1] + a.splat[p + 2] + a.splat[p + 3]).toBe(255);
      expect(a.roughness[i]).toBeGreaterThan(0);
      expect(a.ao[i]).toBeGreaterThanOrEqual(115);
      expect(a.ao[i]).toBeLessThanOrEqual(255);
    }
    expect([...field.height]).toEqual(before);
    expect(generatePBR(field, { ...project, seed: project.seed + 1 }).basecolor).not.toEqual(a.basecolor);
  });

  it('keeps flat-terrain AO white, curvature neutral and normal oriented correctly', () => {
    const field = fixture(8, true);
    const project = { ...createProject(), surface: { ...resolveSurface(), detailStrength: 0 } };
    const maps = generatePBR(field, project);
    expect([...maps.ao]).toEqual(new Array(64).fill(255));
    expect([...maps.curvature]).toEqual(new Array(64).fill(128));
    const normals = materialNormalPixels(maps, field, project);
    for (let i = 0; i < normals.length; i += 4)
      expect([...normals.slice(i, i + 4)]).toEqual([128, 128, 255, 255]);
  });

  it('uses physical height and detail to build normals with exact DirectX green inversion', () => {
    const project = createProject();
    const field = fixture(32);
    const maps = generatePBR(field, project);
    const gl = materialNormalPixels(maps, field, project);
    const dx = materialNormalPixels(maps, field, project, false, true);
    const detail = materialNormalPixels(maps, field, project, true);
    let macroDifference = 0;
    for (let i = 0; i < gl.length; i += 4) {
      expect(dx[i]).toBe(gl[i]);
      expect(dx[i + 1] + gl[i + 1]).toBe(255);
      expect(dx[i + 2]).toBe(gl[i + 2]);
      expect(detail[i + 3]).toBe(255);
      macroDifference += Math.abs(gl[i] - detail[i]) + Math.abs(gl[i + 1] - detail[i + 1]);
    }
    expect(macroDifference).toBeGreaterThan(500);
  });

  it('creates glTF ORM and Unity HDRP mask maps with documented channels', () => {
    const project = createProject();
    const field = fixture();
    const maps = generatePBR(field, project);
    const orm = pbrPixels(maps, field, project, 'orm');
    const hdrp = pbrPixels(maps, field, project, 'unityMask');
    const metal = pbrPixels(maps, field, project, 'metallic');
    for (let i = 0; i < maps.ao.length; i++) {
      const p = i * 4;
      expect([...orm.slice(p, p + 4)]).toEqual([maps.ao[i], maps.roughness[i], 0, 255]);
      expect([...hdrp.slice(p, p + 4)]).toEqual([0, maps.ao[i], 255, 255 - maps.roughness[i]]);
      expect([...metal.slice(p, p + 4)]).toEqual([0, 0, 0, 255]);
    }
  });

  it('changes materials by biome and preserves valid settings through project import', () => {
    const project = createProject();
    const alpine = generatePBR(fixture(), project);
    const next = { ...project, surface: { ...resolveSurface(), biome: 'arid' as const } };
    expect(generatePBR(fixture(), next).basecolor).not.toEqual(alpine.basecolor);
    expect(parseProject(next).surface).toEqual(next.surface);
    expect(parseProject(project)).not.toHaveProperty('surface');
    expect(() => parseProject({ ...project, surface: { detailMeters: -5 } })).toThrow('PBR');
    expect(() => parseProject({ ...project, surface: { biome: 'bogus' } })).toThrow('biome');
  });

  it('exports a complete PBR ZIP with height, material maps and color-space metadata', () => {
    const project = createProject();
    const result = makeExport(fixture(), project, 'pbr', false);
    expect(result.filename).toBe('alpine-watershed-16-pbr.zip');
    expect(result.mime).toBe('application/zip');
    const files = unzipSync(result.bytes);
    const prefix = 'alpine-watershed-16-';
    for (const suffix of [
      'height16.png', 'basecolor.png', 'normal-gl.png', 'normal-dx.png',
      'detailnormal-gl.png', 'roughness.png', 'ao.png', 'metallic.png', 'orm.png',
      'splat-rgba.png', 'curvature.png', 'unity-hdrp-mask.png',
    ]) {
      expect(files[prefix + suffix]).toBeDefined();
      expect([...files[prefix + suffix].slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    }
    const metadata = JSON.parse(strFromU8(files['alpine-watershed-material-metadata.json']));
    expect(metadata.packedMaps.splat_rgba).toEqual(['rock', 'soil', 'vegetation', 'snow']);
    expect(metadata.baseColorSpace).toContain('sRGB');
    expect(metadata.elevationEncoding).toContain('16-bit');
    const archived = JSON.parse(strFromU8(files['alpine-watershed.nhterrain.json']));
    expect(archived.graph).toEqual(project.graph);
  });

  it('rejects arrays whose size does not match the claimed resolution', () => {
    expect(() => generatePBR({ ...fixture(), resolution: 10 }, createProject())).toThrow('aligned');
  });
});
