import * as THREE from 'three';
import type { DetailPreviewMaps } from '../materials/detailPreview';

/** Physical scale and packed byte semantics are established by the worker.
 * Both maps are linear data arrays, four independent mipmapped layers,
 * never an atlas where bilinear sampling can leak another substrate.
 */
export function createDetailTextures(maps: DetailPreviewMaps) {
  const n = maps.resolution;
  if (!Number.isInteger(n) || n < 8 || n > 1024 ||
    maps.color.byteLength !== n*n*16 || maps.shape.byteLength !== n*n*16)
    throw new Error('Invalid packed local material textures.');
  const create = (data: Uint8Array) => {
    const texture = new THREE.DataArrayTexture(data, n, n, 4);
    texture.format = THREE.RGBAFormat;
    texture.type = THREE.UnsignedByteType;
    texture.colorSpace = THREE.NoColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    // Row zero corresponds to increasing east/south local coordinates.
    texture.flipY = false;
    texture.needsUpdate = true;
    return texture;
  };
  const color = create(maps.color), shape = create(maps.shape);
  return {
    color, shape,
    dispose() { color.dispose(); shape.dispose(); },
  };
}

export type DetailTextures = ReturnType<typeof createDetailTextures>;
