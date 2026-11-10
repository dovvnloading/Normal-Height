import { describe, expect, it } from 'vitest';
import { createProject } from '../model/presets';
import { generatePBR, pbrPixels } from '../materials/pbr';
import type { HeightField } from '../model/types';
import { packPreviewPBR, unpackPreviewWeights } from './previewMaterial';
import { createNearFieldUniforms, installNearFieldShader, nearFieldShouldRender } from './nearField';

function heightField(n = 32): HeightField {
  const height = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = x / (n - 1), v = y / (n - 1);
    height[y * n + x] = 0.22 + 0.5 * v + 0.12 * Math.sin(u * 6);
  }
  return { resolution: n, height,
    flow: new Float32Array(n * n),
    wear: new Float32Array(n * n),
    deposition: new Float32Array(n * n),
  };
}

describe('live PBR near-field packed layer masks', () => {
  it('recovers every layer byte with an exact total of 255 at every pixel', () => {
    const field = heightField();
    const project = createProject();
    const maps = generatePBR(field, project);
    const ormExport = pbrPixels(maps, field, project, 'orm');
    const microExport = pbrPixels(maps, field, project, 'detailNormal');
    const { orm, microNormal } = packPreviewPBR(maps, field, project);
    for (let i = 0; i < field.height.length; i++) {
      const p = i * 4;
      expect(unpackPreviewWeights(orm, microNormal, i)).toEqual(
        Array.from(maps.splat.subarray(p, p + 4)));
      expect(orm[p]).toBe(maps.ao[i]);
      expect(orm[p + 1]).toBe(maps.roughness[i]);
      // RGB normals are identical to export normals, alpha is preview metadata.
      expect([...microNormal.subarray(p, p + 3)]).toEqual(
        [...microExport.subarray(p, p + 3)]);
      expect([...ormExport.subarray(p + 2, p + 4)]).toEqual([0, 255]);
      expect(microExport[p + 3]).toBe(255);
    }
  });
  it('does not modify reusable worker material arrays while making preview masks', () => {
    const field = heightField(16), project = createProject();
    const maps = generatePBR(field, project);
    const snapshot = new Uint8ClampedArray(maps.splat);
    packPreviewPBR(maps, field, project);
    expect(maps.splat).toEqual(snapshot);
  });
});

describe('close-range shader integration', () => {
  it('selects only sufficiently resolved near surfaces, respecting user toggle', () => {
    const metersPerUnit = 8000 / 2.6;
    expect(nearFieldShouldRender(true, 1, 900, 36, metersPerUnit, 24)).toBe(true);
    expect(nearFieldShouldRender(true, 10, 900, 36, metersPerUnit, 24)).toBe(false);
    expect(nearFieldShouldRender(false, 0.5, 900, 36, metersPerUnit, 24)).toBe(false);
    expect(nearFieldShouldRender(true, NaN, 900, 36, metersPerUnit, 24)).toBe(false);
    expect(nearFieldShouldRender(true, 1, 0, 36, metersPerUnit, 24)).toBe(false);
  });

  it('injects bounded world-space albedo, roughness and view-space micro-normal stages', () => {
    const uniforms = createNearFieldUniforms();
    const shader = {
      fragmentShader: '#include <map_fragment>\n#include <roughnessmap_fragment>\n#include <normal_fragment_maps>\n',
      uniforms: {} as Record<string, {value:number}>,
    };
    installNearFieldShader(shader, uniforms);
    expect(shader.uniforms.nhMetersPerUnit).toBe(uniforms.nhMetersPerUnit);
    expect(shader.fragmentShader).toContain('vNHPosition * nhMetersPerUnit');
    expect(shader.fragmentShader).toContain('nhReliefMeters / nhMetersPerUnit');
    expect(shader.fragmentShader).toContain('texture2D(roughnessMap, vRoughnessMapUv)');
    expect(shader.fragmentShader).toContain('texture2D(normalMap, vNormalMapUv).a');
    expect(shader.fragmentShader).toContain('dFdx(nhProceduralHeight)');
    expect(shader.fragmentShader).toContain('dFdy(nhProceduralHeight)');
    expect(shader.fragmentShader).toContain('nhDetailStrength > 0.0001');
    expect(shader.fragmentShader).toContain('nhFineVisible');
    expect(() => installNearFieldShader({ fragmentShader: 'unknown', uniforms: {} }, uniforms))
      .toThrow('shader does not contain');
  });
});
