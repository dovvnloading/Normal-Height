import { decodeSamples } from '../model/heightRaster';
import type { TerrainNode } from '../model/types';

/**
 * Decode once and sample the immutable original raster in normalized domain
 * coordinates. Terrain and World use the same interpolation, orientation and
 * meter-to-normalized-height conversion; neither resamples a preview raster.
 */
export function createImportedHeightSampler(node: TerrainNode, heightScale: number) {
  const raster = node.raster;
  if (!raster) throw new Error(`Choose a heightmap file in the inspector for “${node.label}”.`);
  if (!(Number.isFinite(heightScale) && heightScale > 0))
    throw new Error('Imported heightmaps need a positive finite elevation scale.');
  const bytes = decodeSamples(raster);
  const view = new DataView(bytes.buffer);
  const read =
    raster.format === 'f32le'
      ? (i: number) => view.getFloat32(i * 4, true)
      : (i: number) => view.getUint16(i * 2, true);
  const gain = Number(node.params.gain ?? 1) / (raster.format === 'f32le' ? heightScale : 65535);
  const offset = Number(node.params.offsetMeters ?? 0) / heightScale;
  if (!Number.isFinite(gain) || !Number.isFinite(offset))
    throw new Error('Imported heightmap gain and elevation offset must be finite.');
  const interpolate = (sx: number, sy: number): number => {
    const left = Math.floor(sx),
      right = Math.min(raster.width - 1, left + 1);
    const top = Math.floor(sy),
      a = raster.width * top;
    const b = raster.width * Math.min(raster.height - 1, top + 1);
    const fx = sx - left,
      fy = sy - top;
    const upper = read(a + left) * (1 - fx) + read(a + right) * fx;
    const lower = read(b + left) * (1 - fx) + read(b + right) * fx;
    return (upper * (1 - fy) + lower * fy) * gain + offset;
  };
  return {
    byteLength: bytes.byteLength,
    sample(u: number, v: number): number {
      const sx = Math.max(0, Math.min(1, u)) * (raster.width - 1);
      const sy = Math.max(0, Math.min(1, node.params.flipY ? 1 - v : v)) * (raster.height - 1);
      return interpolate(sx, sy);
    },
    /** Preserve the original Terrain arithmetic order for saved projects. */
    sampleGrid(x: number, y: number, cells: number): number {
      return interpolate(
        (x * (raster.width - 1)) / cells,
        ((node.params.flipY ? cells - y : y) * (raster.height - 1)) / cells,
      );
    },
  };
}

/** Sample the original raster at tile coordinates, including both border samples. */
export function sampleImportedHeight(node: TerrainNode, resolution: number, heightScale: number) {
  const source = createImportedHeightSampler(node, heightScale);
  const height = new Float32Array(resolution * resolution);
  const last = resolution - 1;
  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      height[y * resolution + x] = source.sampleGrid(x, y, last);
    }
  }
  return height;
}
