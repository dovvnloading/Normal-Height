import { decodeSamples } from '../model/heightRaster';
import type { TerrainNode } from '../model/types';

/** Sample the original raster at tile coordinates, including both border samples. */
export function sampleImportedHeight(node: TerrainNode, resolution: number, heightScale: number) {
  const raster = node.raster;
  if (!raster) throw new Error(`Choose a heightmap file in the inspector for “${node.label}”.`);
  const bytes = decodeSamples(raster);
  const view = new DataView(bytes.buffer);
  const read =
    raster.format === 'f32le'
      ? (i: number) => view.getFloat32(i * 4, true)
      : (i: number) => view.getUint16(i * 2, true);
  const gain = Number(node.params.gain ?? 1) / (raster.format === 'f32le' ? heightScale : 65535);
  const offset = Number(node.params.offsetMeters ?? 0) / heightScale;
  const height = new Float32Array(resolution * resolution);
  const last = resolution - 1;
  for (let y = 0; y < resolution; y++) {
    const sy = ((node.params.flipY ? last - y : y) * (raster.height - 1)) / last;
    const top = Math.floor(sy);
    const a = raster.width * top;
    const b = raster.width * Math.min(raster.height - 1, top + 1);
    const fy = sy - top;
    for (let x = 0; x < resolution; x++) {
      const sx = (x * (raster.width - 1)) / last;
      const left = Math.floor(sx);
      const right = Math.min(raster.width - 1, left + 1);
      const fx = sx - left;
      const upper = read(a + left) * (1 - fx) + read(a + right) * fx;
      const lower = read(b + left) * (1 - fx) + read(b + right) * fx;
      height[y * resolution + x] = (upper * (1 - fy) + lower * fy) * gain + offset;
    }
  }
  return height;
}
