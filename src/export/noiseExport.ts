import { strToU8, Zip, ZipPassThrough, Zlib } from 'fflate';
import { createStudioSampler } from '../engine/noiseStudio';
import {
  encodeNoiseRecipe,
  resolveNoiseSeed,
  resolveStudioSettings,
  validateStudioParams,
} from '../model/noiseStudio';
import type { ParamValue } from '../model/types';

export type NoiseExportFormat = 'png16' | 'raw32';
export interface NoiseExportOptions {
  params: Record<string, ParamValue>;
  projectSeed: number;
  worldSize: number;
  heightScale: number;
  resolution: number;
  format: NoiseExportFormat;
  /** Bounded work buffers; changing this never changes the sampled coordinates. */
  rowsPerChunk?: number;
}
export interface NoiseExportMetadata {
  application: string;
  engine: number;
  source: string;
  resolution: [number, number];
  worldSizeMeters: [number, number];
  sampleSpacingMeters: number;
  heightScaleMeters: number;
  elevationMinMeters: number;
  elevationMaxMeters: number;
  projectSeed: number;
  resolvedSeed: number;
  sourceSeedPolicy: { mode: string; locked: boolean };
  recipeLocksResolvedSeed: boolean;
  valueMin: number;
  valueMax: number;
  encoding: string;
  units: string;
  orientation: string;
  tiling: string;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  return c >>> 0;
});
function pngChunk(type: string, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(payload.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length);
  out.set(strToU8(type), 4);
  out.set(payload, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < out.length - 4; i++) crc = CRC_TABLE[(crc ^ out[i]) & 255] ^ (crc >>> 8);
  view.setUint32(out.length - 4, (crc ^ 0xffffffff) >>> 0);
  return out;
}
export function noiseExportFilename(
  options: Pick<NoiseExportOptions, 'params' | 'resolution' | 'format'>,
): string {
  const s = resolveStudioSettings(options.params);
  return `normal-height-${s.kernel}-${options.resolution}-${options.format}.zip`;
}

/**
 * Streams directly into a ZIP sink. No resolution² heightfield or scanline
 * buffer is allocated. PNG's range pass avoids clipping negative/high output;
 * the second pass samples the identical global coordinates and footprint.
 * The caller owns final archive storage (e.g. transferable chunks + a Blob).
 */
export function streamNoiseExport(
  options: NoiseExportOptions,
  onChunk: (bytes: Uint8Array, final: boolean) => void,
  onProgress: (fraction: number, stage: string) => void = () => {},
): NoiseExportMetadata {
  const { resolution: n, params, projectSeed, worldSize, heightScale, format } = options;
  if (!Number.isInteger(n) || n < 16 || n > 8192)
    throw new Error('Noise export resolution must be an integer from 16 to 8192.');
  if (format !== 'png16' && format !== 'raw32') throw new Error('Unknown noise export format.');
  if (
    !Number.isInteger(projectSeed) ||
    projectSeed < 0 ||
    projectSeed > 2147483647 ||
    !Number.isFinite(worldSize) ||
    worldSize < 100 ||
    worldSize > 100000 ||
    !Number.isFinite(heightScale) ||
    heightScale < 10 ||
    heightScale > 20000
  )
    throw new Error('Invalid noise export scale or project seed.');
  validateStudioParams(params);
  const settings = resolveStudioSettings(params);
  const sampler = createStudioSampler(params, projectSeed, worldSize);
  const footprint = 1 / (n - 1);
  const rows = Math.max(1, Math.min(256, Math.floor(options.rowsPerChunk ?? 16)));
  if (!Number.isFinite(rows)) throw new Error('Invalid noise export strip size.');
  const sample = (x: number, y: number) => {
    const value = Math.fround(
      sampler.sample(x === n - 1 ? 1 : x * footprint, y === n - 1 ? 1 : y * footprint, footprint),
    );
    if (!Number.isFinite(value)) throw new Error('Noise generation produced a non-finite value.');
    return value;
  };
  let min = Infinity;
  let max = -Infinity;
  if (format === 'png16') {
    onProgress(0, 'Measuring source range');
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const v = sample(x, y);
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
      if (y % rows === 0 || y === n - 1) onProgress((0.45 * (y + 1)) / n, 'Measuring source range');
    }
  }
  const zip = new Zip((error, data, final) => {
    if (error) throw error;
    onChunk(data, final);
  });
  const add = (name: string) => {
    const file = new ZipPassThrough(name);
    // Repeated exports have stable archive metadata as well as stable pixels.
    file.mtime = new Date(2000, 0, 1);
    zip.add(file);
    return file;
  };
  const base = `noise-${settings.kernel}-${n}`;
  if (format === 'png16') {
    const file = add(`${base}-height16.png`);
    file.push(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, n);
    view.setUint32(4, n);
    header[8] = 16; // Grayscale, unsigned 16-bit, linear data (no gamma chunk).
    file.push(pngChunk('IHDR', header));
    const deflater = new Zlib({ level: 6 }, (data, final) => {
      if (data.length) file.push(pngChunk('IDAT', data));
      if (final) file.push(pngChunk('IEND', new Uint8Array()), true);
    });
    const span = max - min || 1;
    for (let y0 = 0; y0 < n; y0 += rows) {
      const count = Math.min(rows, n - y0);
      const bytes = new Uint8Array(count * (n * 2 + 1));
      for (let row = 0; row < count; row++) {
        let i = row * (n * 2 + 1);
        bytes[i++] = 1; // PNG Sub filter, bpp = 2; only a row-local predecessor.
        let previousHi = 0,
          previousLo = 0;
        for (let x = 0; x < n; x++) {
          const v = Math.round(
            Math.max(0, Math.min(1, (sample(x, y0 + row) - min) / span)) * 65535,
          );
          const hi = v >>> 8,
            lo = v & 255;
          bytes[i++] = (hi - previousHi) & 255;
          bytes[i++] = (lo - previousLo) & 255;
          previousHi = hi;
          previousLo = lo;
        }
      }
      deflater.push(bytes, y0 + count === n);
      onProgress(0.45 + (0.54 * (y0 + count)) / n, 'Encoding 16-bit source');
    }
  } else {
    const file = add(`${base}-f32le.raw`);
    onProgress(0, 'Generating Float32 source');
    for (let y0 = 0; y0 < n; y0 += rows) {
      const count = Math.min(rows, n - y0);
      const bytes = new Uint8Array(count * n * 4);
      const view = new DataView(bytes.buffer);
      for (let row = 0; row < count; row++)
        for (let x = 0; x < n; x++) {
          const v = sample(x, y0 + row);
          min = Math.min(min, v);
          max = Math.max(max, v);
          view.setFloat32((row * n + x) * 4, v, true);
        }
      file.push(bytes, y0 + count === n);
      onProgress((0.99 * (y0 + count)) / n, 'Generating Float32 source');
    }
  }
  const metadata: NoiseExportMetadata = {
    application: 'Normal Height Noise Studio',
    engine: 3,
    source: 'Selected procedural source only; downstream graph operations are not included.',
    resolution: [n, n],
    worldSizeMeters: [worldSize, worldSize],
    sampleSpacingMeters: worldSize * footprint,
    heightScaleMeters: heightScale,
    elevationMinMeters: min * heightScale,
    elevationMaxMeters: max * heightScale,
    projectSeed,
    resolvedSeed: resolveNoiseSeed(settings, projectSeed),
    sourceSeedPolicy: { mode: settings.seedMode, locked: settings.seedLocked },
    recipeLocksResolvedSeed: true,
    valueMin: min,
    valueMax: max,
    encoding:
      format === 'png16'
        ? 'Linear unsigned 16-bit grayscale. value = valueMin + sample / 65535 * (valueMax - valueMin). Constant maps decode to valueMin.'
        : 'Little-endian IEEE 754 Float32, no header; values are preserved without normalization.',
    units:
      'Scalar output including amplitude and elevation offset; multiply by heightScaleMeters for meters.',
    orientation:
      'Row-major; first row north (negative Z), X increases east. Samples include both tile endpoints.',
    tiling:
      settings.tiling === 'blend'
        ? 'Smooth four-way blend with matching opposite borders. Distribution changes; this is not a native periodic noise kernel.'
        : 'Nonperiodic source.',
  };
  add('metadata.json').push(strToU8(JSON.stringify(metadata, null, 2)), true);
  add('source.nhnoise.json').push(
    strToU8(
      encodeNoiseRecipe({
        ...params,
        seedLocked: true,
        lockedSeed: metadata.resolvedSeed,
      }),
    ),
    true,
  );
  zip.end();
  onProgress(1, 'Source export ready');
  return metadata;
}
