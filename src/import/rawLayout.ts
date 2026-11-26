import { checkRasterDimensions, MAX_PROJECT_RASTER_BYTES, MAX_RASTER_SIDE } from '../model/heightRaster';

export type RawSampleType = 'uint16' | 'float32';
export type RawByteOrder = 'little' | 'big';

export interface RawEncoding {
  sampleType: RawSampleType;
  byteOrder: RawByteOrder;
}

export interface RawLayout extends RawEncoding {
  width: number;
  height: number;
}

export function isRawHeightmap(name: string): boolean {
  return /\.(r16|r32|raw)$/i.test(name);
}

/** Filename conventions are suggestions, not metadata embedded in a RAW file. */
export function defaultRawEncoding(name: string): RawEncoding {
  return {
    sampleType: /(?:\.r32|f32(?:le|be)\.raw)$/i.test(name) ? 'float32' : 'uint16',
    byteOrder: /(?:f32be|u16be)\.raw$/i.test(name) ? 'big' : 'little',
  };
}

export function rawSampleBytes(sampleType: RawSampleType): number {
  return sampleType === 'float32' ? 4 : 2;
}

export function suggestedRawSide(byteLength: number, sampleType: RawSampleType): number | null {
  const side = Math.sqrt(byteLength / rawSampleBytes(sampleType));
  return Number.isInteger(side) && side >= 2 && side <= MAX_RASTER_SIDE ? side : null;
}

/** Validate before allocating or reading file bytes, including in the worker. */
export function validateRawLayout(byteLength: number, layout: RawLayout): void {
  if (layout.sampleType !== 'uint16' && layout.sampleType !== 'float32')
    throw new Error('Choose an unsigned 16-bit or Float32 sample type.');
  if (layout.byteOrder !== 'little' && layout.byteOrder !== 'big')
    throw new Error('Choose little-endian or big-endian byte order.');
  checkRasterDimensions(layout.width, layout.height);
  const expected = layout.width * layout.height * rawSampleBytes(layout.sampleType);
  if (expected > MAX_PROJECT_RASTER_BYTES)
    throw new Error('RAW samples exceed the 16 MiB project sample limit.');
  if (byteLength !== expected)
    throw new Error(
      `The selected layout needs ${expected.toLocaleString()} bytes; the file has ${byteLength.toLocaleString()} bytes.`,
    );
}

/** Normalize byte order in place without allocating a second full-size raster. */
export function normalizeRawByteOrder(bytes: Uint8Array, layout: RawLayout): void {
  if (layout.byteOrder === 'little') return;
  const stride = rawSampleBytes(layout.sampleType);
  for (let offset = 0; offset < bytes.length; offset += stride) {
    for (let i = 0; i < stride / 2; i++) {
      const opposite = offset + stride - i - 1;
      const value = bytes[offset + i];
      bytes[offset + i] = bytes[opposite];
      bytes[opposite] = value;
    }
  }
}
