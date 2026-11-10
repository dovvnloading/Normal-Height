import * as THREE from 'three';

/**
 * Three.js PBR uses the red channel for aoMap and the green channel for
 * roughnessMap. Binding the same RGBA ORM texture to both is color-space
 * correct and reduces terrain preview GPU uploads from four textures to three.
 * Export maps, resolution and worker-generated data remain unchanged.
 */
export function applyPackedPBRMaterial(
  material: THREE.MeshStandardMaterial,
  albedo: THREE.DataTexture,
  packedORM: THREE.DataTexture,
  microNormal: THREE.DataTexture,
): boolean {
  if (albedo.colorSpace !== THREE.SRGBColorSpace ||
      packedORM.colorSpace !== THREE.NoColorSpace ||
      microNormal.colorSpace !== THREE.NoColorSpace) {
    throw new Error('PBR preview albedo must be sRGB; ORM/normals are linear data.');
  }
  const changed = material.map !== albedo ||
    material.aoMap !== packedORM || material.roughnessMap !== packedORM ||
    material.normalMap !== microNormal || material.vertexColors;
  material.map = albedo;
  material.roughnessMap = packedORM;
  material.aoMap = packedORM;
  material.normalMap = microNormal;
  material.aoMapIntensity = 0.85;
  material.color.set('#ffffff');
  material.normalScale.set(1, 1);
  material.vertexColors = false;
  material.roughness = 1;
  material.metalness = 0;
  if (changed) material.needsUpdate = true;
  return changed;
}
