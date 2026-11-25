import { describe, expect, it, vi } from 'vitest';
import { importHeightRaster } from './heightmap';
import {
  defaultRawEncoding,
  suggestedRawSide,
  validateRawLayout,
  type RawLayout,
} from './rawLayout';
import { decodeSamples, MAX_PROJECT_RASTER_BYTES, parseHeightRaster } from '../model/heightRaster';
import { sampleImportedHeight } from '../engine/heightImport';
import { createNode } from '../model/registry';

describe('explicit RAW grid import', () => {
  it('suggests filename conventions without inventing rectangular dimensions', () => {
    expect(defaultRawEncoding('survey.R32')).toEqual({ sampleType: 'float32', byteOrder: 'little' });
    expect(defaultRawEncoding('survey-f32be.raw')).toEqual({ sampleType: 'float32', byteOrder: 'big' });
    expect(defaultRawEncoding('survey-u16be.raw')).toEqual({ sampleType: 'uint16', byteOrder: 'big' });
    expect(defaultRawEncoding('survey.raw')).toEqual({ sampleType: 'uint16', byteOrder: 'little' });
    expect(suggestedRawSide(32, 'uint16')).toBe(4);
    expect(suggestedRawSide(24, 'float32')).toBeNull();
    expect(suggestedRawSide(0, 'uint16')).toBeNull();
    expect(suggestedRawSide(2050 ** 2 * 2, 'uint16')).toBeNull();
  });

  it.each(['little', 'big'] as const)('preserves rectangular UInt16 precision (%s endian)', async (byteOrder) => {
    const values = [1, 258, 65535, 0, 32768, 65534];
    const buffer = new ArrayBuffer(values.length * 2);
    const view = new DataView(buffer);
    values.forEach((value, i) => view.setUint16(i * 2, value, byteOrder === 'little'));
    const raster = await importHeightRaster(new File([buffer], 'survey.raw'), {
      width: 3, height: 2, sampleType: 'uint16', byteOrder,
    });
    expect([raster.width, raster.height, raster.format]).toEqual([3, 2, 'u16le']);
    const stored = new DataView(decodeSamples(raster).buffer);
    expect(values.map((_, i) => stored.getUint16(i * 2, true))).toEqual(values);
    const source = createNode('heightImport');
    source.raster = parseHeightRaster(JSON.parse(JSON.stringify(raster)), MAX_PROJECT_RASTER_BYTES);
    const sampled = sampleImportedHeight(source, 3, 100);
    expect(sampled[0]).toBeCloseTo(1 / 65535, 8);
    expect(sampled[2]).toBe(1);
    expect(sampled[6]).toBe(0);
    expect(sampled[8]).toBeCloseTo(65534 / 65535, 7);
  });

  it.each(['little', 'big'] as const)('preserves signed Float32 meters regardless of file suffix (%s endian)', async (byteOrder) => {
    const values = [-125.5, 0.25, 250.75, -0, 0, 1000000];
    const buffer = new ArrayBuffer(values.length * 4);
    const view = new DataView(buffer);
    values.forEach((value, i) => view.setFloat32(i * 4, value, byteOrder === 'little'));
    const raster = await importHeightRaster(new File([buffer], 'survey.r16'), {
      width: 2, height: 3, sampleType: 'float32', byteOrder,
    });
    expect([raster.width, raster.height, raster.format]).toEqual([2, 3, 'f32le']);
    const stored = new DataView(decodeSamples(raster).buffer);
    expect(values.map((_, i) => stored.getFloat32(i * 4, true))).toEqual(values);
    const source = createNode('heightImport');
    source.raster = raster;
    const sampled = sampleImportedHeight(source, 3, 1000);
    expect(sampled[0] * 1000).toBeCloseTo(-125.5, 4);
    expect(sampled[8] * 1000).toBe(1000000);
  });

  it('allows an explicitly rectangular interpretation even when the byte count is a perfect square', async () => {
    const file = new File([new Uint8Array(32)], 'ambiguous.r16');
    const old = await importHeightRaster(file);
    expect([old.width, old.height]).toEqual([4, 4]);
    const rectangular = await importHeightRaster(file, {
      width: 8, height: 2, sampleType: 'uint16', byteOrder: 'little',
    });
    expect([rectangular.width, rectangular.height]).toEqual([8, 2]);
    expect(rectangular.data).toBe(old.data);
  });

  it('rejects bad dimensions, encoding and byte counts before reading the file', async () => {
    const file = new File([new Uint8Array(12)], 'survey.raw');
    const read = vi.spyOn(file, 'arrayBuffer');
    const layout: RawLayout = { width: 3, height: 2, sampleType: 'uint16', byteOrder: 'little' };
    await expect(importHeightRaster(file, { ...layout, width: 4 })).rejects.toThrow('bytes');
    await expect(importHeightRaster(file, { ...layout, height: 2.5 })).rejects.toThrow('dimensions');
    await expect(importHeightRaster(file, { ...layout, height: 2049 })).rejects.toThrow('dimensions');
    await expect(importHeightRaster(file, { ...layout, sampleType: 'invalid' as RawLayout['sampleType'] })).rejects.toThrow('sample type');
    await expect(importHeightRaster(file, { ...layout, byteOrder: 'invalid' as RawLayout['byteOrder'] })).rejects.toThrow('byte order');
    expect(read).not.toHaveBeenCalled();
    expect(() => validateRawLayout(MAX_PROJECT_RASTER_BYTES, { width: 2048, height: 2048, sampleType: 'float32', byteOrder: 'big' })).not.toThrow();
  });

  it.each([NaN, Infinity, -1000001])('rejects invalid big-endian Float32 values (%s)', async (invalid) => {
    const bytes = new ArrayBuffer(16);
    new DataView(bytes).setFloat32(4, invalid, false);
    await expect(importHeightRaster(new File([bytes], 'bad.raw'), {
      width: 2, height: 2, sampleType: 'float32', byteOrder: 'big',
    })).rejects.toThrow('finite');
  });
});
