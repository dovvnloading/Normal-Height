import { describe, expect, it } from 'vitest';
import { importHeightRaster } from './heightmap';
import { sampleImportedHeight } from '../engine/heightImport';
import { encodeHeightPNG, encodeRawHeight } from '../export/heightmap';
import {
  decodeSamples,
  MAX_PROJECT_RASTER_BYTES,
  parseHeightRaster,
  assertRasterBudget,
} from '../model/heightRaster';
import { createNode } from '../model/registry';
import { createProject } from '../model/presets';
import { parseProject } from '../model/project';
import { evaluateGraph } from '../engine';
import { evaluationSignature } from '../hooks/useTerrainEngine';

// Independently encoded 3x5 fixtures: two IDAT chunks and filters 0, 1, 2, 3, 4 in row order.
const png16 =
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAAFEAAAAAD1itU9AAAAB0lEQVR4nGNgYGRkGlipDAAAACVJREFU+v+PkeEXE/uN/UxhqW3bNRyYQ3duehhayNJwj/P2pEIA04INsjNYAk0AAAAASUVORK5CYII=';
const png8 =
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAAFCAAAAAClGgl+AAAAB0lEQVR4nGNgZPrHvUxUFgAAABZJREFU+It9P1PqdgfmnQ8LWe7dLgQASTwIXRuBoeYAAAAASUVORK5CYII=';
const extraData =
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAAFCAAAAAClGgl+AAAAB0lEQVR4nGNgZPrHvUxUFgAAABdJREFU+It9P1PqdgfmnQ8LWe7dLmQEAFGaCF6icIsIAAAAAElFTkSuQmCC';
const values = [
  1, 258, 65534, 250, 513, 56000, 22111, 35000, 512, 33000, 14001, 29129, 198, 2444, 51234,
];
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const readPNG = (s: string) => importHeightRaster(new File([fromBase64(s)], 'dem.png'));

describe('Heightmap import', () => {
  it.each([
    [png16, 16],
    [png8, 8],
  ] as const)('reconstructs all five PNG filters at native precision (%#)', async (png, bits) => {
    const raster = await readPNG(png);
    const bytes = new DataView(decodeSamples(raster).buffer);
    expect([raster.width, raster.height]).toEqual([3, 5]);
    expect(values.map((_, i) => bytes.getUint16(2 * i, true))).toEqual(
      values.map((v) => (bits === 16 ? v : (v % 256) * 257)),
    );
  });

  it('preserves low bits on export/import and maps full tile edges when resampled', async () => {
    const original = new Float32Array([0, 1 / 65535, 0.5, 1]);
    const png = encodeHeightPNG({ height: original, resolution: 2 }, { min: 0, max: 1 });
    const source = createNode('heightImport');
    source.raster = await importHeightRaster(
      new File([png.buffer as ArrayBuffer], 'precision.png'),
    );
    const height = sampleImportedHeight(source, 3, 1000);
    expect(height[2]).toBe(original[1]);
    expect(height[8]).toBe(1);
    expect(height[4]).toBeCloseTo((1 + 1 / 65535 + 32768 / 65535) / 4, 7);
    source.params.flipY = true;
    source.params.gain = 2;
    source.params.offsetMeters = -100;
    expect(sampleImportedHeight(source, 3, 1000)[2]).toBeCloseTo(1.9, 6);
  });

  it('reopens a graph with an embedded Float32 source and reconstructs elevations at export scale', async () => {
    const project = createProject();
    project.heightScale = 1024;
    const source = createNode('heightImport');
    const values = new Float32Array([-1.25, 0.125, 0.375, 2.5]);
    const field = { height: values, resolution: 2, flow: values, wear: values, deposition: values };
    const bytes = encodeRawHeight(field, project.heightScale);
    source.raster = await importHeightRaster(
      new File([bytes.buffer as ArrayBuffer], 'terrain-elevation-f32le.raw'),
    );
    const output = createNode('output');
    project.graph = {
      nodes: [source, output],
      edges: [
        {
          id: 'import-out',
          source: source.id,
          target: output.id,
          sourceHandle: 'height',
          targetHandle: 'in',
        },
      ],
    };
    const restored = parseProject(JSON.parse(JSON.stringify(project)));
    expect(restored.graph.nodes[0].raster).toEqual(source.raster);
    for (const resolution of [64, 128]) {
      const result = evaluateGraph(restored, { resolution });
      expect(
        [0, resolution - 1, resolution * (resolution - 1), resolution ** 2 - 1].map(
          (i) => result.field.height[i],
        ),
      ).toEqual(Array.from(values));
    }
    restored.heightScale = 512;
    const changed = evaluateGraph(restored, { resolution: 64 });
    expect(changed.field.height[0] * 512).toBe(-1.25 * 1024);
  });

  it('validates inline payloads, rejects bad replacements, and invalidates the preview on valid replacements', async () => {
    const project = createProject();
    const source = createNode('heightImport');
    project.graph.nodes.push(source);
    const empty = evaluationSignature(project);
    expect(() => sampleImportedHeight(source, 64, 1000)).toThrow('Choose a heightmap');
    source.raster = await importHeightRaster(
      new File([new Uint8Array([0, 0, 0, 1, 255, 255, 1, 0])], 'grid.r16'),
    );
    const first = evaluationSignature(project);
    expect(first).not.toBe(empty);
    expect(first).not.toContain(source.raster.data);
    expect(sampleImportedHeight(source, 2, 1000)[1]).toBeCloseTo(256 / 65535, 8);
    expect(() =>
      parseHeightRaster({ ...source.raster, data: 'AAAA' }, MAX_PROJECT_RASTER_BYTES),
    ).toThrow('length');
    expect(() =>
      parseHeightRaster({ ...source.raster, data: '*'.repeat(12) }, MAX_PROJECT_RASTER_BYTES),
    ).toThrow('base64');
    expect(() =>
      parseHeightRaster({ ...source.raster, width: 65536 }, MAX_PROJECT_RASTER_BYTES),
    ).toThrow('dimensions');
    expect(() => parseHeightRaster(source.raster, 4)).toThrow('sample limit');
    source.raster = { ...source.raster, data: '//////////8=' };
    expect(evaluationSignature(project)).not.toBe(first);
    const full = {
      ...source,
      raster: { ...source.raster, width: 2048, height: 2048, format: 'f32le' as const },
    };
    expect(() => assertRasterBudget([full, source])).toThrow('sample limit');
  });

  it('rejects malformed image dimensions, checksums, inflated lengths and Float32 values', async () => {
    const damaged = fromBase64(png16);
    damaged[damaged.length - 1] ^= 255;
    await expect(importHeightRaster(new File([damaged], 'bad.png'))).rejects.toThrow('checksum');
    await expect(readPNG(extraData)).rejects.toThrow('declared dimensions');
    await expect(importHeightRaster(new File([new Uint8Array(10)], 'odd.raw'))).rejects.toThrow(
      'square',
    );
    const invalid = new Uint8Array(16);
    new DataView(invalid.buffer).setFloat32(12, NaN, true);
    await expect(importHeightRaster(new File([invalid], 'nonfinite.r32'))).rejects.toThrow(
      'finite',
    );
  });
});
