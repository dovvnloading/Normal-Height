import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8, unzlibSync } from 'fflate';
import { createProject } from '../model/presets';
import { parseProject } from '../model/project';
import { makeExport } from '../export/heightmap';
import type { HeightField } from '../model/types';
import { generatePBR, materialNormalPixels, pbrPixels, resolveSurface, srgbByteToLinear, linearToSrgbByte } from './pbr';

/** Inflate real encoded PNG payloads, rejecting incorrect scanline orientation or format. */
function decodePNG(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const compressed: Uint8Array[] = [];
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  for (let off = 8; off < bytes.length;) {
    const size = view.getUint32(off);
    const type = strFromU8(bytes.subarray(off + 4, off + 8));
    const data = bytes.subarray(off + 8, off + 8 + size);
    if (type === 'IHDR') {
      width = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
      height = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(4);
      bitDepth = data[8];
      colorType = data[9];
    }
    if (type === 'IDAT') compressed.push(data);
    off += size + 12;
    if (type === 'IEND') break;
  }
  const joined = new Uint8Array(compressed.reduce((total, p) => total + p.length, 0));
  let offset = 0;
  for (const data of compressed) { joined.set(data, offset); offset += data.length; }
  const scanlines = unzlibSync(joined);
  const bytesPerPixel = colorType === 0 && bitDepth === 16 ? 2 : 4;
  const rowSize = width * bytesPerPixel + 1;
  const pixels = new Uint8Array(width * height * bytesPerPixel);
  expect(scanlines.length).toBe(rowSize * height);
  for (let y = 0; y < height; y++) {
    expect(scanlines[y * rowSize]).toBe(0); // PNG filter None
    pixels.set(scanlines.subarray(y * rowSize + 1, (y + 1) * rowSize), y * width * bytesPerPixel);
  }
  return { width, height, bitDepth, colorType, pixels };
}

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
    expect(parseProject(project).surface).toEqual(resolveSurface());
    expect(parseProject({ ...project, surface: undefined })).not.toHaveProperty('surface');
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
  it('mixes encoded palette colors in linear reflectance, not sRGB byte space', () => {
    const mix = linearToSrgbByte((srgbByteToLinear(83) + srgbByteToLinear(224)) / 2);
    expect(mix).toBe(173);
    expect(mix).toBeGreaterThan(Math.round((83 + 224) / 2));
    for (const sample of [0, 1, 32, 83, 128, 224, 255])
      expect(linearToSrgbByte(srgbByteToLinear(sample))).toBe(sample);
  });

  it('decodes every exported PBR PNG and compares actual channel pixels and row order', () => {
    const field = fixture(16);
    const project = createProject();
    const maps = generatePBR(field, project);
    const files = unzipSync(makeExport(field, project, 'pbr', false).bytes);
    const prefix = 'alpine-watershed-16-';
    for (const [file, channel, directX] of [
      ['basecolor', 'basecolor', false], ['normal-gl', 'normal', false],
      ['normal-dx', 'normal', true], ['detailnormal-gl', 'detailNormal', false],
      ['roughness', 'roughness', false], ['ao', 'ao', false],
      ['metallic', 'metallic', false], ['orm', 'orm', false],
      ['splat-rgba', 'splat', false], ['curvature', 'curvature', false],
      ['unity-hdrp-mask', 'unityMask', false],
    ] as const) {
      const image = decodePNG(files[prefix + file + '.png']);
      expect([image.width, image.height, image.bitDepth, image.colorType])
        .toEqual([16, 16, 8, 6]);
      const expected = pbrPixels(maps, field, project, channel, directX);
      expect([...image.pixels], file).toEqual([...expected]);
    }
    const height = decodePNG(files[prefix + 'height16.png']);
    expect([height.bitDepth, height.colorType]).toEqual([16, 0]);
    const min = Math.min(...field.height), max = Math.max(...field.height);
    const readHeight = (index: number) =>
      (height.pixels[index * 2] << 8) | height.pixels[index * 2 + 1];
    for (const index of [0, 1, 15, 16, 121, 240, 255]) {
      const normalized = (field.height[index] - min) / (max - min);
      expect(readHeight(index)).toBe(Math.round(normalized * 65535));
    }
    const meta = JSON.parse(strFromU8(files['alpine-watershed-material-metadata.json']));
    expect(meta.surface).toEqual(resolveSurface());
    expect(meta.surfaceSchemaVersion).toBe(1);
    expect(meta.textureChannels.normal_dx.channels[1]).toBe('normalY_DirectX');
    expect(meta.textureChannels.basecolor.colorSpace).toBe('sRGB');
    const saved = JSON.parse(strFromU8(files['alpine-watershed.nhterrain.json']));
    expect(saved.surface).toEqual(resolveSurface());
  });

  it('preserves authored meter frequency instead of enlarging undersampled detail', () => {
    const project = { ...createProject(), worldSize: 1600, surface: {
      ...resolveSurface(), detailMeters: 24, detailStrength: 1,
    } };
    const coarse = generatePBR(fixture(64, true), project);
    const fine = generatePBR(fixture(256, true), project);
    expect(coarse.detail.every((value) => value === 0)).toBe(true);
    expect(fine.detail.some((value) => Math.abs(value) > 0.001)).toBe(true);
  });

  it('renders all four calculated splat channels as inspectable grayscale weights', () => {
    const field = fixture(32);
    const project = createProject();
    const maps = generatePBR(field, project);
    for (const [channel, index] of [
      ['rockWeight', 0], ['soilWeight', 1],
      ['vegetationWeight', 2], ['snowWeight', 3],
    ] as const) {
      const pixels = pbrPixels(maps, field, project, channel);
      for (let pixel = 0; pixel < field.height.length; pixel++) {
        const p = pixel * 4;
        expect([...pixels.subarray(p, p + 4)]).toEqual([
          maps.splat[p + index], maps.splat[p + index],
          maps.splat[p + index], 255,
        ]);
      }
    }
  });

});
