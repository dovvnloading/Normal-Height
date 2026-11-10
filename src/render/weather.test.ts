import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { generateCloudTexture, wrapCloudShadows } from './weather';

describe('shared cloud-field quality and rendering performance', () => {
  it('builds a bounded, repeatable, tileable atmospheric texture', () => {
    const a = generateCloudTexture(128);
    const b = generateCloudTexture(128);
    const aa = a.image.data as Uint8Array;
    const bb = b.image.data as Uint8Array;
    expect(a.colorSpace).toBe(THREE.NoColorSpace);
    expect(a.wrapS).toBe(THREE.RepeatWrapping);
    expect(a.wrapT).toBe(THREE.RepeatWrapping);
    expect(aa).toEqual(bb);
    let low = 255, high = 0;
    for (let i = 0; i < aa.length; i += 4) {
      low = Math.min(low, aa[i]); high = Math.max(high, aa[i]);
      expect(aa[i + 3]).toBe(255);
      // The periodic low-frequency field should not reveal a seam when wrapped.
      if (i % (128 * 4) === 0) {
        const rowEnd = i + (128 - 1) * 4;
        expect(Math.abs(aa[i] - aa[rowEnd])).toBeLessThan(50);
      }
    }
    expect(high - low).toBeGreaterThan(45);
    a.dispose();
    b.dispose();
  });

  it('intercepts only direct physically based lighting and restores the source shader', () => {
    const material = new THREE.MeshStandardMaterial();
    const prior = material.onBeforeCompile;
    const texture = generateCloudTexture(16);
    const uniforms = {
      nhCloudTexture: { value: texture as THREE.Texture },
      nhCloudCoverage: { value: 0.8 },
      nhCloudWind: { value: 1 },
      nhCloudSun: { value: new THREE.Vector3(0.3, 0.8, -0.3) },
      nhCloudShadowStrength: { value: 0.6 },
    };
    const detach = wrapCloudShadows(material, uniforms);
    const shader = {
      uniforms: {},
      vertexShader: '#include <begin_vertex>\n#include <worldpos_vertex>',
      fragmentShader: '#include <lights_fragment_end>',
    };
    material.onBeforeCompile(shader as unknown as Parameters<typeof material.onBeforeCompile>[0],
      {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain('vNHCloudWorld');
    expect(shader.fragmentShader).toContain('reflectedLight.directDiffuse *= brightness');
    expect(shader.fragmentShader).toContain('reflectedLight.directSpecular *= brightness');
    expect(shader.fragmentShader).not.toContain('indirectDiffuse *= brightness');
    expect((shader.uniforms as Record<string, unknown>).nhCloudTexture).toBe(uniforms.nhCloudTexture);
    detach();
    expect(material.onBeforeCompile).toBe(prior);
    material.dispose();
    texture.dispose();
  });
});
