import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { applyPackedPBRMaterial } from './pbrMaterial';
import { pbrPixels } from '../materials/pbr';
import type { PBRMaps } from '../materials/pbr';
import type { HeightField, TerrainProject } from '../model/types';

const texture = (srgb: boolean) => {
  const t = new THREE.DataTexture(new Uint8Array(4 * 4 * 4), 4, 4);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return t;
};

describe('packed PBR terrain preview (#10)', () => {
  it('shares the same GPU texture for AO/red and roughness/green', () => {
    const maps: PBRMaps = {
      resolution: 2,
      basecolor: new Uint8ClampedArray(16),
      splat: new Uint8ClampedArray(16),
      roughness: new Uint8Array([34, 66, 98, 121]),
      ao: new Uint8Array([205, 195, 185, 175]),
      curvature: new Uint8Array(4),
      detail: new Float32Array(4),
    };
    const pixels = pbrPixels(maps, {} as HeightField, {} as TerrainProject, 'orm');
    for (let i = 0; i < 4; i++) {
      expect(pixels[i * 4]).toBe(maps.ao[i]);
      expect(pixels[i * 4 + 1]).toBe(maps.roughness[i]);
      expect(pixels[i * 4 + 2]).toBe(0);
      expect(pixels[i * 4 + 3]).toBe(255);
    }
    const material = new THREE.MeshStandardMaterial({ vertexColors: true });
    const albedo = texture(true), orm = texture(false), normal = texture(false);
    const before = material.version;
    expect(applyPackedPBRMaterial(material, albedo, orm, normal)).toBe(true);
    expect(material.version).toBeGreaterThan(before);
    expect(material.aoMap).toBe(orm);
    expect(material.roughnessMap).toBe(orm);
    expect(material.map).toBe(albedo);
    expect(material.normalMap).toBe(normal);
    expect(material.vertexColors).toBe(false);
    const after = material.version;
    expect(applyPackedPBRMaterial(material, albedo, orm, normal)).toBe(false);
    expect(material.version).toBe(after);
    for (const t of [albedo, orm, normal]) t.dispose();
    material.dispose();
  });

  it('rejects a color-space mismatch instead of silently re-encoding data maps', () => {
    const material = new THREE.MeshStandardMaterial();
    const albedo = texture(true), orm = texture(true), normal = texture(false);
    expect(() => applyPackedPBRMaterial(material, albedo, orm, normal)).toThrow('linear');
    for (const t of [albedo, orm, normal]) t.dispose();
    material.dispose();
  });
});
