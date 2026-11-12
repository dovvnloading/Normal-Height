import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  createSlopeTexture, createSourceNormalUniforms, installSourceNormals, patchedNormalFragmentBegin,
} from './sourceNormals';
import { createTerrainSampler } from './terrainMesh';

const field = (n: number) => {
  const height = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++)
    height[y * n + x] = 0.4 + 0.2 * Math.sin(x * 0.7) * Math.cos(y * 0.45) + 0.003 * x;
  return height;
};

describe('per-pixel source normals', () => {
  it('stores the sampler\'s own physical slopes, so pixels shade like vertex normals', () => {
    const n = 33;
    const sampler = createTerrainSampler(field(n), n, 1800, 6000);
    const slopes = sampler.slopes!();
    for (const [i, j] of [[0, 0], [5, 9], [16, 16], [32, 7], [31, 32]]) {
      const k = j * n + i;
      const normal = sampler.normal(i / (n - 1), j / (n - 1));
      const expected = new THREE.Vector3(-slopes.x[k], 1, -slopes.z[k]).normalize();
      expect(normal[0]).toBeCloseTo(expected.x, 6);
      expect(normal[1]).toBeCloseTo(expected.y, 6);
      expect(normal[2]).toBeCloseTo(expected.z, 6);
    }
    const texture = createSlopeTexture(slopes, n);
    expect(texture.format).toBe(THREE.RGFormat);
    expect(texture.type).toBe(THREE.HalfFloatType);
    expect(texture.generateMipmaps).toBe(false);
    const base = (texture.mipmaps[0] as unknown as { data: Uint16Array }).data;
    for (let k = 0; k < n * n; k += 7) {
      expect(THREE.DataUtils.fromHalfFloat(base[k * 2])).toBeCloseTo(slopes.x[k], 2);
      expect(THREE.DataUtils.fromHalfFloat(base[k * 2 + 1])).toBeCloseTo(slopes.z[k], 2);
    }
    texture.dispose();
  });

  it('builds a complete box-filtered mip chain for any size', () => {
    const n = 37;
    const slopes = { x: new Float32Array(n * n), z: new Float32Array(n * n) };
    for (let i = 0; i < n * n; i++) { slopes.x[i] = (i % 5) * 0.25; slopes.z[i] = -(i % 3) * 0.5; }
    const texture = createSlopeTexture(slopes, n);
    expect(texture.mipmaps.map((level) => level.width)).toEqual([37, 18, 9, 4, 2, 1]);
    const one = (texture.mipmaps[1] as unknown as { data: Uint16Array }).data;
    const mean = (slopes.x[0] + slopes.x[1] + slopes.x[n] + slopes.x[n + 1]) / 4;
    expect(THREE.DataUtils.fromHalfFloat(one[0])).toBeCloseTo(mean, 2);
    expect(() => createSlopeTexture({ x: new Float32Array(4), z: new Float32Array(3) }, 2)).toThrow();
    texture.dispose();
  });

  it('replaces only the vertex normal in Three.js normal_fragment_begin', () => {
    const patched = patchedNormalFragmentBegin();
    expect(patched.split('vec3 normal = normalize( vNormal );')).toHaveLength(2);
    expect(patched).toContain('nhSourceNormal( vNHPosition )');
    // Tangent frames for micro-detail maps are still built afterwards.
    expect(patched.indexOf('nhSourceNormal( vNHPosition )'))
      .toBeLessThan(patched.indexOf('nonPerturbedNormal'));
  });

  it('installs into the real standard-material shader and rejects shaders missing its inputs', () => {
    const uniforms = createSourceNormalUniforms();
    const shader = {
      fragmentShader: 'varying vec3 vNHPosition;\nuniform float nhMeadowBlend;\n' +
        THREE.ShaderLib.standard.fragmentShader,
      uniforms: {} as Record<string, { value: unknown }>,
    };
    installSourceNormals(shader, uniforms);
    expect(shader.fragmentShader).not.toContain('#include <normal_fragment_begin>');
    expect(shader.fragmentShader).toContain('#include <normal_fragment_maps>');
    expect(shader.fragmentShader).toContain('uniform sampler2D nhSlopeMap;');
    expect(shader.uniforms.nhSlopeMap).toBe(uniforms.nhSlopeMap);
    expect(shader.uniforms.nhVerticalScale).toBe(uniforms.nhVerticalScale);
    expect(() => installSourceNormals({
      fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: {},
    }, uniforms)).toThrow(/varying/);
    expect(() => installSourceNormals({
      fragmentShader: 'varying vec3 vNHPosition; uniform float nhMeadowBlend; void main() {}',
      uniforms: {},
    }, uniforms)).toThrow(/normal_fragment_begin/);
  });
});
