import * as THREE from 'three';

/**
 * Keep an existing RGBA WebGL allocation when a terrain material edit only
 * changes its pixels. This avoids deleting and recreating four GPU textures
 * on every biome/roughness/erosion-parameter edit.
 *
 * Returned Uint8Array is a view over the worker-synthesized byte buffer, not
 * a duplicate allocation. Size or color-space changes must reallocate.
 */
export function updatePreviewTexture(
  existing: THREE.DataTexture | undefined,
  rgba: Uint8ClampedArray,
  size: number,
  srgb: boolean,
  anisotropy: number,
): THREE.DataTexture {
  if (!Number.isInteger(size) || size < 1 || rgba.byteLength !== size * size * 4) {
    throw new Error('Preview PBR texture dimensions do not match its RGBA pixels.');
  }
  const colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  const data = new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  if (
    existing &&
    existing.image.width === size && existing.image.height === size &&
    existing.format === THREE.RGBAFormat &&
    existing.colorSpace === colorSpace
  ) {
    existing.image.data = data;
    existing.anisotropy = anisotropy;
    existing.needsUpdate = true;
    return existing;
  }

  existing?.dispose();
  const result = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  result.flipY = true; // row zero is north; PlaneGeometry's top row has v=1
  result.colorSpace = colorSpace;
  result.generateMipmaps = true;
  result.minFilter = THREE.LinearMipmapLinearFilter;
  result.magFilter = THREE.LinearFilter;
  result.anisotropy = anisotropy;
  result.needsUpdate = true;
  return result;
}
