/**
 * Close-range physically spaced surface variation.
 *
 * Macro classification, lithology and standard PBR exports are generated in
 * the terrain/material Worker. This pass only contributes *sub-texel* shading
 * near the camera, in XYZ world meters, so rocks/soil/snow do not look like a
 * blurry 512² photograph when the viewer approaches the actual mesh.
 *
 * No new texture, new Worker or additional terrain vertices are required.
 * Existing packed preview ORM B/A and normalMap A carry the first three
 * normalized material weights; snow is the residual. Standard exported ORM
 * and normal pixels are NEVER repacked.
 */

export interface NearFieldUniforms {
  nhMetersPerUnit: { value: number };
  nhDetailMeters: { value: number };
  nhDetailStrength: { value: number };
  nhDetailSeed: { value: number };
  nhNearFieldActive: { value: number };
}

export function createNearFieldUniforms(): NearFieldUniforms {
  return {
    nhMetersPerUnit: { value: 1 },
    nhDetailMeters: { value: 24 },
    nhDetailStrength: { value: 0.65 },
    nhDetailSeed: { value: 0 },
    nhNearFieldActive: { value: 0 },
  };
}

/** Cheap screen-size preflight: GLSL derivatives handle exact grazing angles. */
export function nearFieldShouldRender(
  enabled: boolean,
  cameraDistance: number,
  viewportHeight: number,
  cameraFovDegrees: number,
  metersPerUnit: number,
  authoredDetailMeters: number,
): boolean {
  if (!enabled || cameraDistance <= 0 || viewportHeight <= 0 || metersPerUnit <= 0)
    return false;
  if (!Number.isFinite(cameraDistance) || !Number.isFinite(metersPerUnit)) return false;
  const footprint = cameraDistance * metersPerUnit *
    2 * Math.tan(cameraFovDegrees * Math.PI / 360) / viewportHeight;
  // The shader evaluates 0.22 * authoredDetailMeters as its main wavelength.
  // Enable a little early to avoid popping as the camera approaches.
  return footprint < authoredDetailMeters * 0.22 * 0.65;
}

interface ShaderTarget {
  fragmentShader: string;
  uniforms: Record<string, { value: number }>;
}

const GLSL_PARS = `
uniform float nhMetersPerUnit;
uniform float nhDetailMeters;
uniform float nhDetailStrength;
uniform float nhDetailSeed;
uniform float nhNearFieldActive;
float nhProceduralHeight = 0.0;
float nhProceduralRoughness = 0.0;

// 3D coherent value noise: independent of the surface's UV parameterization.
// C2 fade gives zero slope at lattice boundaries, avoiding visible seams.
float nhHash3(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}
float nhNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = mix(nhHash3(i), nhHash3(i + vec3(1.0, 0.0, 0.0)), f.x);
  float b = mix(nhHash3(i + vec3(0.0, 1.0, 0.0)),
                nhHash3(i + vec3(1.0, 1.0, 0.0)), f.x);
  float c = mix(nhHash3(i + vec3(0.0, 0.0, 1.0)),
                nhHash3(i + vec3(1.0, 0.0, 1.0)), f.x);
  float d = mix(nhHash3(i + vec3(0.0, 1.0, 1.0)),
                nhHash3(i + vec3(1.0, 1.0, 1.0)), f.x);
  return 2.0 * mix(mix(a, b, f.y), mix(c, d, f.y), f.z) - 1.0;
}
`;

const GLSL_ALBEDO = `
#if defined(USE_MAP) && defined(USE_ROUGHNESSMAP) && defined(USE_NORMALMAP)
  if (nhNearFieldActive > 0.5 && nhDetailStrength > 0.0001) {
    vec3 nhMetersPosition = vNHPosition * nhMetersPerUnit;
    vec3 nhSeedOffset = vec3(nhDetailSeed * 1.71, -nhDetailSeed * 2.33,
                             nhDetailSeed * 3.17);
    // Physical world-space pixel footprint, NOT a texture-space mip level.
    float nhFootprint = max(length(dFdx(nhMetersPosition)),
                            length(dFdy(nhMetersPosition)));
    float nhWavelength = max(0.4, nhDetailMeters * 0.22);
    // At >= Nyquist, fade rather than alias/turn noise into fake broad stripes.
    float nhVisible = 1.0 - smoothstep(nhWavelength * 0.18,
                                       nhWavelength * 0.52, nhFootprint);
    float nhFineVisible = 1.0 - smoothstep(nhWavelength * 0.06,
                                           nhWavelength * 0.20, nhFootprint);
    if (nhVisible > 0.001) {
      // Material masks are exactly those produced by the physical layer solver.
      // ORM R=AO, G=roughness, B=rock, A=soil for preview ONLY.
      // Micro normal RGB=GL normal, A=vegetation for preview ONLY.
      vec4 nhPacked = texture2D(roughnessMap, vRoughnessMapUv);
      float nhVegetation = texture2D(normalMap, vNormalMapUv).a;
      vec3 nhRsv = vec3(nhPacked.b, nhPacked.a, nhVegetation);
      vec4 nhLayers = vec4(nhRsv, max(0.0, 1.0 - nhRsv.r - nhRsv.g - nhRsv.b));
      nhLayers /= max(dot(nhLayers, vec4(1.0)), 0.0001);
      vec3 nhSampling = (nhMetersPosition + nhSeedOffset) / nhWavelength;
      float nhPrimary = nhNoise3(nhSampling);
      float nhFine = nhNoise3(nhSampling * 3.15 + vec3(17.0, 4.0, -12.0))
        * nhFineVisible;
      // Narrow coherent joint fissures, simultaneously recessed, darker and rough.
      float nhJoint = 1.0 - smoothstep(0.025, 0.115, abs(nhPrimary));
      float nhRock = nhPrimary * 0.075 + nhFine * 0.023 - nhJoint * 0.20;
      float nhSoil = nhPrimary * 0.10 + nhFine * 0.05;
      float nhVeg = nhPrimary * 0.12 + nhFine * 0.055;
      float nhSnow = nhPrimary * 0.026 + nhFine * 0.013;
      float nhTint = dot(nhLayers, vec4(nhRock, nhSoil, nhVeg, nhSnow));
      // map_fragment has already decoded sRGB albedo into linear working light.
      diffuseColor.rgb *= 1.0 + nhVisible * nhTint;
      nhProceduralRoughness = nhVisible *
        dot(nhLayers, vec4(nhJoint * 0.055 + nhFine * 0.016,
          nhFine * 0.032, nhFine * 0.026, nhFine * 0.008));
      // Physical micro-height in meters (no double-counted terrain geometry).
      float nhReliefMeters = dot(nhLayers,
        vec4(nhPrimary * 0.085 - nhJoint * 0.18 + nhFine * 0.024,
          nhPrimary * 0.045 + nhFine * 0.012,
          nhPrimary * 0.075 + nhFine * 0.025,
          nhPrimary * 0.026 + nhFine * 0.008));
      nhProceduralHeight = nhVisible * nhDetailStrength *
        nhReliefMeters / nhMetersPerUnit;
    }
  }
#endif
`;

const GLSL_ROUGHNESS = `
#if defined(USE_ROUGHNESSMAP) && defined(USE_NORMALMAP)
  roughnessFactor = clamp(roughnessFactor + nhProceduralRoughness, 0.28, 1.0);
#endif
`;

const GLSL_NORMAL = `
#if defined(USE_MAP) && defined(USE_ROUGHNESSMAP) && defined(USE_NORMALMAP)
  if (nhNearFieldActive > 0.5 && nhDetailStrength > 0.0001) {
    // Reconstruct the fine bump from derivatives of the *same world-space*
    // micro-height used for albedo and roughness. Cross-products transform it
    // into Three.js view space without requiring tangent geometry.
    vec3 nhDx = dFdx(-vViewPosition);
    vec3 nhDy = dFdy(-vViewPosition);
    vec3 nhRx = cross(nhDy, normal);
    vec3 nhRy = cross(normal, nhDx);
    float nhDet = dot(nhDx, nhRx);
    normal = normalize(abs(nhDet) * normal - sign(nhDet) *
      (dFdx(nhProceduralHeight) * nhRx +
       dFdy(nhProceduralHeight) * nhRy));
  }
#endif
`;

/**
 * Called once from TerrainScene's existing onBeforeCompile. No replacement
 * MeshStandardMaterial shader or lighting change: Three.js continues to own
 * BRDF, environment, shadows, normal map decoding and tone mapping.
 */
export function installNearFieldShader(shader: ShaderTarget, uniforms: NearFieldUniforms) {
  for (const [name, uniform] of Object.entries(uniforms)) shader.uniforms[name] = uniform;
  const replace = (marker: string, code: string) => {
    if (!shader.fragmentShader.includes(marker)) {
      throw new Error(`Terrain PBR shader does not contain ${marker}.`);
    }
    shader.fragmentShader = shader.fragmentShader.replace(marker, marker + '\n' + code);
  };
  shader.fragmentShader = GLSL_PARS + '\n' + shader.fragmentShader;
  replace('#include <map_fragment>', GLSL_ALBEDO);
  replace('#include <roughnessmap_fragment>', GLSL_ROUGHNESS);
  replace('#include <normal_fragment_maps>', GLSL_NORMAL);
}
