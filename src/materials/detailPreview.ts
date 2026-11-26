import { generateDetailTile } from './detailTiles';
import { SPLAT_LAYERS, srgbByteToLinear } from './pbr';
import type { SurfaceBiome } from './pbr';

export const DETAIL_PREVIEW_RESOLUTION = 512;
export const DETAIL_PREVIEW_LAYERS = 4;

/**
 * Preview-only material arrays. RGB color is a signed linear reflectance
 * residual relative to each substrate's own mean (0.5 is neutral), not sRGB.
 * Color A is local cavity visibility. Shape RGB is the exported GL normal;
 * shape A encodes a signed difference from mean GGX alpha (roughness squared).
 * The macro terrain bake still owns pigment, wetness, AO and layer coverage.
 */
export interface DetailPreviewMaps {
  resolution: number;
  color: Uint8Array;
  shape: Uint8Array;
}

export interface DetailPreviewRequest {
  biome: SurfaceBiome;
  seed: number;
}

export type DetailPreviewResponse =
  | { type: 'result'; maps: DetailPreviewMaps }
  | { type: 'error'; message: string };

const byte = (v: number) => Math.round(Math.max(0, Math.min(1, v))*255);
const linearLUT = Float32Array.from({ length: 256 }, (_, v) => srgbByteToLinear(v));

/** All periods are sampled at a unit strength in a reference 6 m domain.
 * Runtime period changes scale the height and horizontal spacing together,
 * so the unit-slope normal maps do not need regeneration for slider edits.
 */
export function generateDetailPreview(
  request: DetailPreviewRequest, resolution = DETAIL_PREVIEW_RESOLUTION,
): DetailPreviewMaps {
  if (!Number.isInteger(resolution) || resolution < 8 || resolution > 1024)
    throw new Error('Invalid local preview texture resolution.');
  const pixels = resolution*resolution;
  const layerBytes = pixels*4;
  const color = new Uint8Array(layerBytes*DETAIL_PREVIEW_LAYERS);
  const shape = new Uint8Array(color.length);
  for (let layer = 0; layer < SPLAT_LAYERS.length; layer++) {
    const tile = generateDetailTile(SPLAT_LAYERS[layer], {
      biome: request.biome, detailMeters: 24, detailStrength: 1, aoStrength: 1,
    }, request.seed, resolution);
    const mean = [0, 0, 0];
    let meanAlpha = 0;
    for (let p = 0; p < layerBytes; p += 4) {
      for (let c = 0; c < 3; c++) mean[c] += linearLUT[tile.basecolor[p+c]];
      meanAlpha += (tile.orm[p+1]/255)**2;
    }
    for (let c = 0; c < 3; c++) mean[c] = Math.max(1e-5, mean[c]/pixels);
    meanAlpha /= pixels;
    const offset = layer*layerBytes;
    for (let p = 0; p < layerBytes; p += 4) {
      const i = offset+p;
      for (let c = 0; c < 3; c++) {
        // Store ratio/2 in a linear texture, then decode as signed residual.
        // Clamp exceptional highlights without ever dividing by zero.
        color[i+c] = byte(0.5*linearLUT[tile.basecolor[p+c]]/mean[c]);
        shape[i+c] = tile.normal[p+c];
      }
      color[i+3] = tile.orm[p];
      shape[i+3] = byte(0.5+0.5*((tile.orm[p+1]/255)**2-meanAlpha));
    }
  }
  return { resolution, color, shape };
}
