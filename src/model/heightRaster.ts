import type { TerrainNode } from './types';

export interface HeightRaster {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly format: 'u16le' | 'f32le';
  /** Canonical row-major samples, first row north, stored inline in portable projects. */
  readonly data: string;
}

export const MAX_RASTER_SIDE = 2048;
export const MAX_PROJECT_RASTER_BYTES = 16 * 1024 * 1024;
export const MAX_PROJECT_FILE_BYTES = 32 * 1024 * 1024;

export function checkRasterDimensions(width: number, height: number) {
  if (![width, height].every((n) => Number.isInteger(n) && n >= 2 && n <= MAX_RASTER_SIDE))
    throw new Error('Heightmap dimensions must be between 2 and 2048 samples on each side.');
}

export function rasterBytes(raster: HeightRaster) {
  return raster.width * raster.height * (raster.format === 'f32le' ? 4 : 2);
}

function checkBudget(bytes: number, available: number) {
  if (bytes > available)
    throw new Error('Imported heightmaps exceed the 16 MiB project sample limit.');
}

export function assertRasterBudget(nodes: TerrainNode[]) {
  const bytes = nodes.reduce((sum, node) => sum + (node.raster ? rasterBytes(node.raster) : 0), 0);
  checkBudget(bytes, MAX_PROJECT_RASTER_BYTES);
}

// A source edit replaces its immutable raster. UI change detection needs only its
// identity and can skip serializing megabytes of base64 on every slider movement.
const identities = new WeakMap<HeightRaster, number>();
let nextIdentity = 1;
export function rasterIdentity(raster: HeightRaster): number {
  let id = identities.get(raster);
  if (id === undefined) {
    id = nextIdentity++;
    identities.set(raster, id);
  }
  return id;
}

// Chunks end on a complete group of three input bytes (four base64 characters).
const ENCODE_CHUNK = 24 * 1024;
export function encodeSamples(bytes: Uint8Array) {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += ENCODE_CHUNK)
    chunks.push(btoa(String.fromCharCode(...bytes.subarray(i, i + ENCODE_CHUNK))));
  return chunks.join('');
}

export function decodeSamples(raster: HeightRaster): Uint8Array<ArrayBuffer> {
  checkRasterDimensions(raster.width, raster.height);
  if ((raster.format !== 'u16le' && raster.format !== 'f32le') || typeof raster.data !== 'string')
    throw new Error('Invalid embedded heightmap.');
  const size = rasterBytes(raster);
  if (raster.data.length !== 4 * Math.ceil(size / 3))
    throw new Error('Embedded heightmap length does not match its dimensions.');
  const bytes = new Uint8Array(size);
  let offset = 0;
  const chunkSize = (ENCODE_CHUNK / 3) * 4;
  for (let i = 0; i < raster.data.length; i += chunkSize) {
    const encoded = raster.data.slice(i, i + chunkSize);
    const last = i + chunkSize >= raster.data.length;
    if (!(last ? /^[A-Za-z0-9+/]+={0,2}$/ : /^[A-Za-z0-9+/]+$/).test(encoded))
      throw new Error('Invalid base64 in embedded heightmap.');
    const decoded = atob(encoded);
    if (offset + decoded.length > size) throw new Error('Invalid embedded heightmap length.');
    for (let j = 0; j < decoded.length; j++) bytes[offset++] = decoded.charCodeAt(j);
  }
  if (offset !== size) throw new Error('Invalid embedded heightmap length.');
  if (raster.format === 'f32le') checkFloatSamples(bytes);
  return bytes;
}

export function checkFloatSamples(bytes: Uint8Array) {
  const samples = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < samples.byteLength; i += 4) {
    const meters = samples.getFloat32(i, true);
    if (!Number.isFinite(meters) || Math.abs(meters) > 1_000_000)
      throw new Error('Float32 elevations must be finite and within ±1,000,000 meters.');
  }
}

/** Validate the embedded samples before accepting the project or replacing a source. */
export function parseHeightRaster(raw: unknown, available: number): HeightRaster {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid embedded heightmap.');
  const r = raw as Partial<HeightRaster>;
  if (
    (r.format !== 'u16le' && r.format !== 'f32le') ||
    typeof r.data !== 'string' ||
    typeof r.name !== 'string' ||
    typeof r.width !== 'number' ||
    typeof r.height !== 'number'
  )
    throw new Error('Invalid embedded heightmap.');
  const raster = {
    format: r.format,
    data: r.data,
    width: r.width,
    height: r.height,
    name: r.name.slice(0, 160),
  };
  checkBudget(rasterBytes(raster), available);
  decodeSamples(raster);
  return raster;
}
