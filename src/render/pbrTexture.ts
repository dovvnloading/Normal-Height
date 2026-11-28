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
  height = size,
): THREE.DataTexture {
  if (
    !Number.isInteger(size) ||
    size < 1 ||
    !Number.isInteger(height) ||
    height < 1 ||
    rgba.byteLength !== size * height * 4
  ) {
    throw new Error('Preview PBR texture dimensions do not match its RGBA pixels.');
  }
  const colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  const data = new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  if (
    existing &&
    existing.image.width === size &&
    existing.image.height === height &&
    existing.format === THREE.RGBAFormat &&
    existing.colorSpace === colorSpace
  ) {
    existing.image.data = data;
    existing.anisotropy = anisotropy;
    existing.needsUpdate = true;
    return existing;
  }

  existing?.dispose();
  const result = new THREE.DataTexture(data, size, height, THREE.RGBAFormat);
  // UV=0 and UV=1 are DEM sample positions, while texture coordinates
  // put texel centres at (index + 0.5)/size. Without this transform every
  // channel drifts by up to half a texel against the mesh and paint cursor.
  result.offset.set(0.5 / size, 0.5 / height);
  result.repeat.set((size - 1) / size, (height - 1) / height);
  result.flipY = true; // row zero is north; PlaneGeometry's top row has v=1
  result.colorSpace = colorSpace;
  result.generateMipmaps = true;
  result.minFilter = THREE.LinearMipmapLinearFilter;
  result.magFilter = THREE.LinearFilter;
  result.anisotropy = anisotropy;
  result.needsUpdate = true;
  return result;
}
