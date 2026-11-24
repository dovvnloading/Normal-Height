import { strFromU8, unzipSync, unzlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { generateStudioNoise } from '../src/engine/noiseStudio';
import { streamNoiseExport } from '../src/export/noiseExport';
import type { NoiseExportOptions } from '../src/export/noiseExport';
import { decodeNoiseRecipe, resolveNoiseSeed, STUDIO_DEFAULTS } from '../src/model/noiseStudio';

function collect(options: NoiseExportOptions) {
  const parts: Uint8Array[] = [];
  const progress: number[] = [];
  let complete = 0;
  const metadata = streamNoiseExport(
    options,
    (data, final) => {
      parts.push(data.slice());
      if (final) complete++;
    },
    (p) => progress.push(p),
  );
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  expect(complete).toBe(1);
  expect(progress.at(-1)).toBe(1);
  expect(progress.every((p, i) => p >= 0 && p <= 1 && (i === 0 || p >= progress[i - 1]))).toBe(
    true,
  );
  return { files: unzipSync(bytes), metadata, parts };
}
/** Small independent PNG reader: verifies CRC, zlib and Sub reconstruction. */
function decodePNG16(bytes: Uint8Array) {
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0,
    height = 0;
  const compressed: Uint8Array[] = [];
  for (let i = 8; i < bytes.length;) {
    const length = view.getUint32(i);
    const kind = strFromU8(bytes.subarray(i + 4, i + 8));
    const payload = bytes.subarray(i + 8, i + 8 + length);
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(i + 4, i + 8 + length)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    expect((crc ^ 0xffffffff) >>> 0, `${kind} checksum`).toBe(view.getUint32(i + 8 + length));
    if (kind === 'IHDR') {
      width = view.getUint32(i + 8);
      height = view.getUint32(i + 12);
      expect([...payload.subarray(8)]).toEqual([16, 0, 0, 0, 0]);
    } else if (kind === 'IDAT') compressed.push(payload);
    i += length + 12;
  }
  const packed = new Uint8Array(compressed.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of compressed) {
    packed.set(p, offset);
    offset += p.length;
  }
  const scanlines = unzlibSync(packed);
  expect(scanlines.length).toBe(height * (width * 2 + 1));
  const values = new Uint16Array(width * height);
  for (let y = 0; y < height; y++) {
    const start = y * (width * 2 + 1);
    expect(scanlines[start]).toBe(1);
    const row = scanlines.slice(start + 1, start + 1 + width * 2);
    for (let b = 2; b < row.length; b++) row[b] = (row[b] + row[b - 2]) & 255;
    for (let x = 0; x < width; x++) values[y * width + x] = row[2 * x] * 256 + row[2 * x + 1];
  }
  return { width, height, values };
}

const options: NoiseExportOptions = {
  params: {
    ...STUDIO_DEFAULTS,
    noiseModel: 'v3',
    seed: 975,
    fractal: 'fbm',
    octaves: 3.5,
    rotation: 21,
    warpType: 'independent',
    warpAmplitude: 0.2,
    tiling: 'blend',
    sampling: 'supersample2',
    amplitude: 1.5,
    offset: -0.4,
  },
  projectSeed: 42,
  worldSize: 8000,
  heightScale: 2400,
  resolution: 37,
  format: 'raw32',
  rowsPerChunk: 7,
};
describe('streaming high resolution noise export', () => {
  it('exports exact Float32 samples and the context needed to recreate them across strip sizes', () => {
    const expected = generateStudioNoise(
      options.params,
      options.projectSeed,
      options.resolution,
      options.worldSize,
    );
    const first = collect(options);
    const second = collect({ ...options, rowsPerChunk: 1 });
    const name = Object.keys(first.files).find((n) => n.endsWith('.raw'))!;
    expect(first.files[name]).toEqual(second.files[name]);
    const raw = new DataView(
      first.files[name].buffer,
      first.files[name].byteOffset,
      first.files[name].byteLength,
    );
    expect(raw.byteLength).toBe(expected.length * 4);
    for (let i = 0; i < expected.length; i++)
      expect(raw.getFloat32(i * 4, true), `sample ${i}`).toBe(expected[i]);
    expect(first.parts.every((p) => p.length < expected.byteLength)).toBe(true);
    const metadata = JSON.parse(strFromU8(first.files['metadata.json']));
    const recipe = decodeNoiseRecipe(strFromU8(first.files['source.nhnoise.json']));
    expect(metadata.resolvedSeed).toBe(resolveNoiseSeed(recipe, metadata.projectSeed));
    expect(recipe.seedLocked).toBe(true);
    expect(metadata.resolvedSeed).toBe(resolveNoiseSeed(recipe, metadata.projectSeed + 1));
    expect(metadata.sourceSeedPolicy).toEqual({ mode: 'linked', locked: false });
    expect(metadata.valueMin).toBe(Math.min(...expected));
    expect(metadata.valueMax).toBe(Math.max(...expected));
    expect(metadata.worldSizeMeters).toEqual([8000, 8000]);
    expect(metadata.heightScaleMeters).toBe(2400);
    expect(metadata.elevationMinMeters).toBe(metadata.valueMin * 2400);
    expect(metadata.elevationMaxMeters).toBe(metadata.valueMax * 2400);
    expect(metadata.resolution).toEqual([37, 37]);
  });
  it('produces a valid 16-bit PNG, preserving range with only quantization error', () => {
    const expected = generateStudioNoise(
      options.params,
      options.projectSeed,
      options.resolution,
      options.worldSize,
    );
    const { files, metadata } = collect({ ...options, format: 'png16' });
    const name = Object.keys(files).find((n) => n.endsWith('.png'))!;
    const decoded = decodePNG16(files[name]);
    expect([decoded.width, decoded.height]).toEqual([37, 37]);
    const span = metadata.valueMax - metadata.valueMin;
    for (let i = 0; i < expected.length; i++) {
      const restored = metadata.valueMin + (decoded.values[i] / 65535) * span;
      expect(Math.abs(restored - expected[i]), `sample ${i}`).toBeLessThanOrEqual(
        span / 65535 / 2 + 1e-12,
      );
    }
    for (let i = 0; i < 37; i++) {
      expect(decoded.values[i]).toBe(decoded.values[36 * 37 + i]);
      expect(decoded.values[i * 37]).toBe(decoded.values[i * 37 + 36]);
    }
  });
  it('preserves constant and negative sources without inventing a normalized range', () => {
    const { files, metadata } = collect({
      ...options,
      format: 'png16',
      resolution: 16,
      params: { ...STUDIO_DEFAULTS, amplitude: 0, offset: -0.25 },
    });
    expect(metadata.valueMin).toBe(-0.25);
    expect(metadata.valueMax).toBe(-0.25);
    const decoded = decodePNG16(Object.entries(files).find(([name]) => name.endsWith('.png'))![1]);
    expect(decoded.values.every((v) => v === 0)).toBe(true);
  });
  it('canonicalizes periodic endpoints even when reciprocal multiplication falls below one', () => {
    const n = 50;
    expect((n - 1) * (1 / (n - 1))).toBeLessThan(1);
    const { files } = collect({
      ...options,
      resolution: n,
      params: {
        ...STUDIO_DEFAULTS,
        kernel: 'white',
        fractal: 'none',
        tiling: 'blend',
        sampling: 'point',
      },
    });
    const raw = Object.entries(files).find(([name]) => name.endsWith('.raw'))![1];
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let i = 0; i < n; i++) {
      expect(view.getFloat32(i * 4, true)).toBe(view.getFloat32(((n - 1) * n + i) * 4, true));
      expect(view.getFloat32(i * n * 4, true)).toBe(view.getFloat32((i * n + n - 1) * 4, true));
    }
  });
  it('rejects invalid dimensions, seeds and recipes before producing an archive', () => {
    for (const patch of [
      { resolution: 8193 },
      { resolution: 15 },
      { resolution: 16.5 },
      { projectSeed: -1 },
      { worldSize: Infinity },
      { heightScale: NaN },
      { rowsPerChunk: NaN },
      { params: { seed: 1.5 } },
    ])
      expect(() =>
        streamNoiseExport({ ...options, ...patch }, () => {
          throw new Error('No bytes should be produced');
        }),
      ).toThrow();
  });
});
