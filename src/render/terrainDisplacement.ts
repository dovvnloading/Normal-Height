import { resolveSurface, type PBRMaps } from '../materials/pbr';
import { SurfaceFabric } from '../materials/surfaceFabric';
import type { TerrainProject } from '../model/types';
import { createTerrainSampler, monotoneSurface, type TerrainSampler } from './terrainMesh';

type Relief = Pick<PBRMaps, 'resolution' | 'detail' | 'splat'>;
type PhysicalSurface = Pick<TerrainProject, 'heightScale' | 'worldSize' | 'seed' | 'surface'>;

/**
 * Displayed heights stay in DEM units. The bake and the procedural fabric
 * both produce signed vertical metres, so neither depends on exaggeration.
 * Coarse tiles use the prefiltered combined field. Finer tiles evaluate the
 * same rock/soil/vegetation/snow model at their own physical sample spacing.
 */
export function createDisplacedTerrainSampler(
  height: Float32Array, maps: Relief, project: PhysicalSurface,
): TerrainSampler {
  const { heightScale, worldSize } = project;
  const { resolution: n, detail, splat } = maps;
  if (detail.length !== n * n || splat.length !== detail.length * 4 || height.length !== detail.length)
    throw new Error('Terrain and material displacement fields must align.');
  const settings = resolveSurface(project.surface);
  if (!settings.detailStrength) return createTerrainSampler(height, n, heightScale, worldSize);
  const combined = new Float32Array(height.length);
  for (let i = 0; i < combined.length; i++) combined[i] = height[i] + detail[i] / heightScale;
  const baked = createTerrainSampler(combined, n, heightScale, worldSize);
  const terrain = monotoneSurface(height, n);
  const last = n - 1;
  const cell = worldSize / last;
  const gradientScale = heightScale / cell;

  // Cache only the lattice samples that have actually been drawn. A fixed
  // FIFO of 1024 small blocks across all levels bounds resident detail to
  // 4 MiB. Most camera moves reuse the same tiles instead of resynthesizing
  // millions of material samples. A new bake has its own cache.
  const blockSize = 32, capacity = 1024;
  const fifo: Array<{ blocks: Array<Float32Array | undefined>; key: number }> = [];
  let cursor = 0;
  const levels = new Map<number, (u: number, v: number) => number>();
  const heightForSpacing = (spacing: number) => {
    if (spacing >= 1) return baked.heightForSpacing!(spacing);
    const existing = levels.get(spacing);
    if (existing) return existing;
    const across = Math.round(last / spacing);
    const blocksAcross = Math.floor(across / blockSize) + 1;
    const blocks: Array<Float32Array | undefined> = [];
    const fabric = new SurfaceFabric(settings, project.seed, spacing * cell);
    const blend = Math.min(1, 2 * (1 - spacing));
    const sample = (u: number, v: number) => {
      const x = u * last, y = v * last;
      const ix = Math.min(last - 1, Math.floor(x)), iy = Math.min(last - 1, Math.floor(y));
      const fx = x - ix, fy = y - iy;
      const a = iy * n + ix, b = a + 1, c = a + n, d = c + 1;
      const wa = (1 - fx) * (1 - fy), wb = fx * (1 - fy), wc = (1 - fx) * fy, wd = fx * fy;
      // Interpolate the worker's physical central differences, including
      // the one-sided derivative at each boundary. A bilinear-cell gradient
      // would jump as a fine material sample crossed a source cell edge.
      const left = ix === 0 ? 0 : 1, right = ix + 1 === last ? 0 : 1;
      const top = iy === 0 ? 0 : n, bottom = iy + 1 === last ? 0 : n;
      const gx = gradientScale * (
        ((height[b] - height[a-left]) * wa + (height[d] - height[c-left]) * wc) / (1 + left) +
        ((height[b+right] - height[a]) * wb + (height[d+right] - height[c]) * wd) / (1 + right));
      const gz = gradientScale * (
        ((height[c] - height[a-top]) * wa + (height[d] - height[b-top]) * wb) / (1 + top / n) +
        ((height[c+bottom] - height[a]) * wc + (height[d+bottom] - height[b]) * wd) / (1 + bottom / n));
      const h = terrain(u, v);
      fabric.sample(u * worldSize, v * worldSize, h * heightScale, gx, gz);
      const weight = (layer: number) => wa * splat[a*4 + layer] + wb * splat[b*4 + layer] +
        wc * splat[c*4 + layer] + wd * splat[d*4 + layer];
      const meters = (weight(0) * fabric.rockHeight + weight(1) * fabric.soilHeight +
        weight(2) * fabric.plantHeight + weight(3) * fabric.snowHeight) * settings.detailStrength / 255;
      const fine = h + meters / heightScale;
      // Crossfade at the source Nyquist limit. Fine synthesis REPLACES the
      // baked relief, so already-resolved beds never get displaced twice.
      return blend === 1 ? fine : fine * blend + baked.height(u, v) * (1 - blend);
    };
    const surface = (u: number, v: number) => {
      u = Math.min(1, Math.max(0, u)); v = Math.min(1, Math.max(0, v));
      const x = u * across, y = v * across;
      if (!Number.isInteger(x) || !Number.isInteger(y)) return sample(u, v);
      const key = Math.floor(y / blockSize) * blocksAcross + Math.floor(x / blockSize);
      let block = blocks[key];
      if (!block) {
        if (fifo.length === capacity) {
          const oldest = fifo[cursor];
          oldest.blocks[oldest.key] = undefined;
          fifo[cursor] = { blocks, key };
          cursor = (cursor + 1) % capacity;
        } else fifo.push({ blocks, key });
        block = blocks[key] = new Float32Array(blockSize * blockSize).fill(NaN);
      }
      const index = (y % blockSize) * blockSize + x % blockSize;
      if (Number.isNaN(block[index])) block[index] = sample(u, v);
      return block[index];
    };
    levels.set(spacing, surface);
    return surface;
  };
  return {
    ...baked,
    detailPeriodMeters: Math.min(settings.detailMeters, settings.strataMeters, settings.fractureMeters),
    heightForSpacing,
  };
}
