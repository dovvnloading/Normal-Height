import { describe, expect, it } from 'vitest';
import { strFromU8, unzlibSync, unzipSync } from 'fflate';
import { encodeHeightPNG, encodeRawHeight, makeExport } from '../src/export/heightmap';
import type { HeightField, TerrainProject } from '../src/model/types';

const field = (values: number[], resolution = Math.sqrt(values.length)): HeightField => ({
  resolution,
  height: new Float32Array(values),
  flow: new Float32Array(values.length),
  wear: new Float32Array(values.length),
  deposition: new Float32Array(values.length),
});

/** Read the public PNG container and inflate its scanlines, independently of the encoder. */
function readPNG(bytes: Uint8Array) {
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = new Map<string, Uint8Array[]>();
  for (let offset = 8; offset < bytes.length;) {
    const length = view.getUint32(offset, false),
      type = strFromU8(bytes.subarray(offset + 4, offset + 8));
    expect(offset + length + 12).toBeLessThanOrEqual(bytes.length);
    chunks.set(type, [...(chunks.get(type) || []), bytes.slice(offset + 8, offset + 8 + length)]);
    offset += length + 12;
  }
  expect(chunks.has('IEND')).toBe(true);
  const header = chunks.get('IHDR')![0],
    headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const parts = chunks.get('IDAT')!,
    compressed = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let position = 0;
  for (const part of parts) {
    compressed.set(part, position);
    position += part.length;
  }
  return {
    width: headerView.getUint32(0),
    height: headerView.getUint32(4),
    bitDepth: header[8],
    colorType: header[9],
    scanlines: unzlibSync(compressed),
  };
}

function fixtureProject(): TerrainProject {
  return {
    version: 1,
    name: 'Alpine Test',
    seed: 128419,
    resolution: 512,
    worldSize: 4200,
    heightScale: 1600,
    presetId: 'custom',
    graph: {
      nodes: [
        {
          id: 'group',
          kind: 'group',
          label: 'Drainage study',
          params: {},
          position: { x: 0, y: 30 },
          width: 840,
          height: 420,
        },
        {
          id: 'range',
          kind: 'mountain',
          label: 'Range α',
          params: { seed: 7, profile: 'range', roughness: 0.48 },
          position: { x: 10, y: 60 },
          parentId: 'group',
        },
        {
          id: 'rain',
          kind: 'hydraulic',
          label: 'Tributaries',
          params: { seed: 9, droplets: 76000, multiscale: true },
          position: { x: 290, y: 60 },
          parentId: 'group',
          bypassed: false,
        },
        {
          id: 'note',
          kind: 'note',
          label: 'Field note',
          params: { text: 'Preserve this seed and the narrow ridge.' },
          position: { x: 300, y: 260 },
          parentId: 'group',
        },
        {
          id: 'out',
          kind: 'output',
          label: 'Terrain output',
          params: {},
          position: { x: 980, y: 90 },
        },
      ],
      edges: [
        { id: 'a', source: 'range', target: 'rain', sourceHandle: 'height', targetHandle: 'in' },
        { id: 'b', source: 'rain', target: 'out', sourceHandle: 'height', targetHandle: 'in' },
      ],
    },
  };
}

describe('heightmap interchange', () => {
  it('encodes an actual 16-bit grayscale PNG with big-endian samples and full-range precision', () => {
    const png = readPNG(encodeHeightPNG(field([-0.25, 0.25, 0.75, 1.75])));
    expect({
      width: png.width,
      height: png.height,
      bitDepth: png.bitDepth,
      colorType: png.colorType,
    }).toEqual({ width: 2, height: 2, bitDepth: 16, colorType: 0 });
    // Two rows, each starting with PNG filter type 0. A quarter and a half of
    // the elevation span become 0x4000 and 0x8000, preserving the low byte.
    expect([...png.scanlines]).toEqual([0, 0, 0, 64, 0, 0, 128, 0, 255, 255]);
    const intermediate = readPNG(encodeHeightPNG(field([0, 1 / 65535, 257 / 65535, 1])));
    expect([...intermediate.scanlines]).toEqual([0, 0, 0, 0, 1, 0, 1, 1, 255, 255]);
  });

  it('handles a constant elevation without division artifacts or invented relief', () => {
    const height = field([0.375, 0.375, 0.375, 0.375]);
    const png = readPNG(encodeHeightPNG(height));
    expect([...png.scanlines]).toEqual(new Array(10).fill(0));
    const files = unzipSync(makeExport(height, fixtureProject(), 'png16', true).bytes);
    const metadata = JSON.parse(strFromU8(files['alpine-test-metadata.json']));
    expect(metadata.elevationMinMeters).toBe(600);
    expect(metadata.elevationMaxMeters).toBe(600);
  });

  it('writes headerless IEEE Float32 little-endian elevations in meters', () => {
    const bytes = encodeRawHeight(field([0.125, -0.5, 1.25, 0]), 1000);
    expect(bytes.byteLength).toBe(16);
    // 125.0 is IEEE-754 0x42fa0000; the least significant byte comes first.
    expect([...bytes.subarray(0, 4)]).toEqual([0, 0, 250, 66]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect([0, 1, 2, 3].map((i) => view.getFloat32(i * 4, true))).toEqual([125, -500, 1250, 0]);
  });

  it('bundles actual export dimensions, physical scale, seed, and the editable graph without mutating it', () => {
    const project = fixtureProject(),
      before = JSON.stringify(project),
      values = Array.from({ length: 64 * 64 }, (_, i) => -0.25 + i / (64 * 64 - 1));
    const exported = makeExport(field(values, 64), project, 'png16', true),
      files = unzipSync(exported.bytes);
    expect(exported.mime).toBe('application/zip');
    expect(exported.filename).toBe('alpine-test-64-png16.zip');
    expect(Object.keys(files).sort()).toEqual([
      'alpine-test-64-height16.png',
      'alpine-test-metadata.json',
      'alpine-test.nhterrain.json',
    ]);
    const metadata = JSON.parse(strFromU8(files['alpine-test-metadata.json']));
    const savedProject = JSON.parse(strFromU8(files['alpine-test.nhterrain.json']));
    expect(metadata.resolution).toEqual([64, 64]);
    expect(metadata.worldSizeMeters).toEqual([4200, 4200]);
    expect(metadata.sampleSpacingMeters).toBeCloseTo(4200 / 63, 10);
    expect(metadata.elevationMinMeters).toBe(-400);
    expect(metadata.elevationMaxMeters).toBe(1200);
    expect(metadata.heightEncoding).toContain('65535');
    expect(metadata.seed).toBe(project.seed);
    expect(metadata.project).toEqual(project);
    expect(savedProject).toEqual({ ...project, resolution: 64 });
    expect(savedProject.graph).toEqual(project.graph);
    expect(JSON.stringify(project)).toBe(before);
    const png = readPNG(files['alpine-test-64-height16.png']);
    expect(png.bitDepth).toBe(16);
    expect(png.width).toBe(64);
    expect(png.height).toBe(64);
    // Reconstruct world elevations using only exported samples and metadata.
    const sampleView = new DataView(
      png.scanlines.buffer,
      png.scanlines.byteOffset,
      png.scanlines.byteLength,
    );
    const rowBytes = 64 * 2 + 1;
    for (const i of [0, 63, 64, 1703, 4095]) {
      const row = Math.floor(i / 64),
        col = i % 64;
      expect(png.scanlines[row * rowBytes]).toBe(0);
      const quantized = sampleView.getUint16(row * rowBytes + 1 + col * 2, false);
      const meters =
        metadata.elevationMinMeters +
        (quantized / 65535) * (metadata.elevationMaxMeters - metadata.elevationMinMeters);
      expect(
        Math.abs(meters - new Float32Array(values)[i] * project.heightScale),
      ).toBeLessThanOrEqual(1600 / 65535 / 2 + 1e-6);
    }
  });

  it('labels diagnostic exports as display maps and produces a neutral normal for flat terrain', () => {
    const terrain = field([0.2, 0.2, 0.2, 0.2]),
      project = fixtureProject();
    const normal = readPNG(makeExport(terrain, project, 'normal', false).bytes);
    expect({ bitDepth: normal.bitDepth, colorType: normal.colorType }).toEqual({
      bitDepth: 8,
      colorType: 6,
    });
    expect([...normal.scanlines]).toEqual([
      0, 128, 128, 255, 255, 128, 128, 255, 255, 0, 128, 128, 255, 255, 128, 128, 255, 255,
    ]);
    const files = unzipSync(makeExport(terrain, project, 'flow', true).bytes);
    const metadata = JSON.parse(strFromU8(files['alpine-test-metadata.json']));
    expect(metadata.diagnosticEncoding).toContain('8-bit');
    expect(metadata.diagnosticEncoding).toContain('not physical flow rate');
  });

  it('rejects invalid sample dimensions and non-finite heights before creating an export', () => {
    expect(() => encodeHeightPNG(field([0, 1, 2], 2))).toThrow('dimensions');
    expect(() => makeExport(field([0, NaN, 1, 2]), fixtureProject(), 'png16', true)).toThrow(
      'invalid elevation',
    );
    expect(() => makeExport(field([0, Infinity, 1, 2]), fixtureProject(), 'raw32', false)).toThrow(
      'invalid elevation',
    );
  });
});
