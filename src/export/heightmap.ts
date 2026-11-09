import { zlibSync, zipSync, strToU8 } from 'fflate';
import { normalMapPixels, colorizeMap } from '../render/maps';
import type { HeightField, TerrainProject } from '../model/types';
import { slug } from '../model/project';

const encoder = new TextEncoder();
function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array) {
  const result = new Uint8Array(data.length + 12);
  const view = new DataView(result.buffer);
  view.setUint32(0, data.length);
  result.set(encoder.encode(type), 4);
  result.set(data, 8);
  view.setUint32(data.length + 8, crc32(result.subarray(4, data.length + 8)));
  return result;
}
function concat(arrays: Uint8Array[]) {
  const total = arrays.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of arrays) {
    out.set(a, pos);
    pos += a.length;
  }
  return out;
}
function encodePNG(
  width: number,
  height: number,
  scanlines: Uint8Array,
  bitDepth: number,
  colorType: number,
) {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = bitDepth;
  header[9] = colorType;
  return concat([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlibSync(scanlines, { level: 6 })),
    chunk('IEND', new Uint8Array()),
  ]);
}
export function heightRange(height: Float32Array) {
  let min = Infinity,
    max = -Infinity;
  for (const h of height) {
    if (!Number.isFinite(h)) throw new Error('The heightfield contains invalid elevation data.');
    min = Math.min(min, h);
    max = Math.max(max, h);
  }
  return { min, max };
}
export function encodeHeightPNG(
  field: Pick<HeightField, 'height' | 'resolution'>,
  range = heightRange(field.height),
) {
  const n = field.resolution;
  if (field.height.length !== n * n) throw new Error('Heightfield dimensions do not match.');
  const rowBytes = n * 2 + 1;
  const pixels = new Uint8Array(n * rowBytes);
  const span = range.max - range.min || 1;
  for (let y = 0; y < n; y++) {
    let offset = y * rowBytes + 1;
    for (let x = 0; x < n; x++) {
      const value = Math.round(
        Math.min(1, Math.max(0, (field.height[y * n + x] - range.min) / span)) * 65535,
      );
      pixels[offset++] = value >>> 8;
      pixels[offset++] = value & 255;
    }
  }
  return encodePNG(n, n, pixels, 16, 0);
}
export function encodeRGBA(pixels: Uint8ClampedArray, n: number) {
  const rows = new Uint8Array(n * (n * 4 + 1));
  for (let y = 0; y < n; y++)
    rows.set(pixels.subarray(y * n * 4, (y + 1) * n * 4), y * (n * 4 + 1) + 1);
  return encodePNG(n, n, rows, 8, 6);
}
export function encodeRawHeight(field: HeightField, heightScale: number) {
  const bytes = new Uint8Array(field.height.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < field.height.length; i++)
    view.setFloat32(i * 4, field.height[i] * heightScale, true);
  return bytes;
}
export type ExportFormat = 'png16' | 'raw32' | 'normal' | 'flow' | 'wear' | 'deposition';
export function makeExport(
  field: HeightField,
  project: TerrainProject,
  format: ExportFormat,
  bundle: boolean,
) {
  const name = slug(project.name);
  const range = heightRange(field.height);
  let bytes: Uint8Array;
  let filename: string;
  if (format === 'png16') {
    bytes = encodeHeightPNG(field, range);
    filename = `${name}-${field.resolution}-height16.png`;
  } else if (format === 'raw32') {
    bytes = encodeRawHeight(field, project.heightScale);
    filename = `${name}-${field.resolution}-elevation-f32le.raw`;
  } else {
    const pixels =
      format === 'normal'
        ? normalMapPixels(field, project.worldSize, project.heightScale)
        : colorizeMap(field, format, project.worldSize, project.heightScale);
    bytes = encodeRGBA(pixels, field.resolution);
    filename = `${name}-${field.resolution}-${format}.png`;
  }
  const metadata = {
    application: 'Normal Height',
    version: 1,
    format,
    resolution: [field.resolution, field.resolution],
    worldSizeMeters: [project.worldSize, project.worldSize],
    sampleSpacingMeters: project.worldSize / (field.resolution - 1),
    elevationMinMeters: range.min * project.heightScale,
    elevationMaxMeters: range.max * project.heightScale,
    orientation: 'Row-major, first row is north (negative Z); X increases east/right.',
    heightEncoding:
      format === 'png16'
        ? 'Unsigned 16-bit grayscale; elevation_m = min_m + (sample / 65535) * (max_m - min_m)'
        : format === 'raw32'
          ? 'Little-endian IEEE 754 Float32 elevation in meters, no header'
          : undefined,
    normalConvention:
      format === 'normal'
        ? 'Tangent-space +Y (OpenGL): R=east/right, G=north/up in image, B=outward/up from terrain. RGB encoded from [-1,1] to [0,255].'
        : undefined,
    diagnosticEncoding: ['flow', 'wear', 'deposition'].includes(format)
      ? '8-bit display visualization, normalized independently; not physical flow rate.'
      : undefined,
    seed: project.seed,
    project,
  };
  if (bundle) {
    return {
      bytes: zipSync(
        {
          [filename]: bytes,
          [`${name}-metadata.json`]: strToU8(JSON.stringify(metadata, null, 2)),
          [`${name}.nhterrain.json`]: strToU8(
            JSON.stringify({ ...project, resolution: field.resolution }, null, 2),
          ),
        },
        { level: 6 },
      ),
      filename: `${name}-${field.resolution}-${format}.zip`,
      mime: 'application/zip',
    };
  }
  return { bytes, filename, mime: format === 'raw32' ? 'application/octet-stream' : 'image/png' };
}
