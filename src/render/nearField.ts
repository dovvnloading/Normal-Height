/**
 * Analytic detail below the terrain bake's sampling scale. The worker supplies
 * the actual coverage (also after brush edits), reflectance and large relief.
 * This pass describes finer surface morphology in object-space meters. Lighting
 * and shadowing still come from the MeshStandardMaterial BRDF.
 */
export interface NearFieldUniforms {
  nhMetersPerUnit: { value: number };
  nhDetailMeters: { value: number };
  nhDetailStrength: { value: number };
  nhDetailSeed: { value: number };
  nhBiome: { value: number };
  nhFabricAzimuth: { value: number };
  nhNearFieldActive: { value: number };
}

export function createNearFieldUniforms(): NearFieldUniforms {
  return {
    nhMetersPerUnit: { value: 1 },
    nhDetailMeters: { value: 24 },
    nhDetailStrength: { value: 0.65 },
    nhDetailSeed: { value: 0 },
    nhBiome: { value: 0 },
    nhFabricAzimuth: { value: 0 },
    nhNearFieldActive: { value: 0 },
  };
}

export function nearFieldShouldRender(
  enabled: boolean,
  cameraDistance: number,
  viewportHeight: number,
  cameraFovDegrees: number,
  metersPerUnit: number,
  authoredDetailMeters: number,
): boolean {
  if (!enabled || !Number.isFinite(cameraDistance) || cameraDistance <= 0 ||
      viewportHeight <= 0 || metersPerUnit <= 0 || authoredDetailMeters <= 0) return false;
  const footprint = cameraDistance * metersPerUnit *
    2 * Math.tan(cameraFovDegrees * Math.PI / 360) / viewportHeight;
  // Longer material wavelengths are visible from further away. Start before
  // the per-pixel cutoff to keep a zoom gesture continuous.
  return footprint < 0.65 * Math.max(0.4, authoredDetailMeters * 0.22);
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
// Alpine gneiss = 0, aeolian sandstone = 1, vesicular basalt = 2.
uniform float nhBiome;
uniform float nhFabricAzimuth;
uniform float nhNearFieldActive;

vec3 nhHash(vec3 i) {
  // PCG permutation on integer lattice sites. Floating-point products lose
  // their low bits at distant world coordinates and line grains up in rows.
  uvec3 v = uvec3(ivec3(floor(i))) * 1664525u + 1013904223u;
  v.x += v.y*v.z; v.y += v.z*v.x; v.z += v.x*v.y;
  v ^= v >> 16u;
  v.x += v.y*v.z; v.y += v.z*v.x; v.z += v.x*v.y;
  return vec3(v >> 8u) / 16777216.0;
}

float nhNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 t = fract(p);
  t = t*t*t*(t*(t*6.0 - 15.0) + 10.0);
  vec4 a = vec4(nhHash(i).x, nhHash(i + vec3(0,1,0)).x,
                nhHash(i + vec3(0,0,1)).x, nhHash(i + vec3(0,1,1)).x);
  vec4 b = vec4(nhHash(i + vec3(1,0,0)).x, nhHash(i + vec3(1,1,0)).x,
                nhHash(i + vec3(1,0,1)).x, nhHash(i + vec3(1,1,1)).x);
  vec4 u = mix(a, b, t.x);
  return mix(mix(u.x, u.y, t.y), mix(u.z, u.w, t.y), t.z) - 0.5;
}

// Integral of a unit-period pulse train. The difference quotient gives its
// exact average across a phase interval, including multiple crests per pixel.
float nhPulseIntegral(float t, float duty) {
  return floor(t) * duty + min(fract(t), duty);
}
float nhBands(float phase, float width, float duty) {
  // Take the fractional part first to preserve precision far from the origin.
  phase = fract(phase);
  width = max(width, 0.035);
  return (nhPulseIntegral(phase + 0.5*width, duty)
        - nhPulseIntegral(phase - 0.5*width, duty)) / width;
}

// C2 compact relief profile. Pigment boundaries can be thin, but a stone
// ledge or ice lip has a rounded shoulder. Convolving the support with the
// pixel footprint attenuates it when the shoulder cannot be resolved.
float nhRib(float phase, float halfWidth, float footprint) {
  float distance = abs(fract(phase + 0.5) - 0.5);
  float radius = min(0.49, halfWidth + 1.20*footprint);
  float cap = max(0.0, 1.0 - distance*distance/(radius*radius));
  return cap*cap*cap*(halfWidth/radius)*(1.0-smoothstep(0.20,0.45,footprint));
}

// Four candidate particles cover a point even when the centre moves across
// a cell edge. Radius + jitter < 1 cell. Sparse overlap, random size and
// orientation avoid stamping an identical stone in each lattice square.
float nhParticle(vec2 uv, float aspect) {
  vec2 cell = floor(uv);
  vec2 f = fract(uv);
  float height = 0.0;
  for (int k = 0; k < 4; k++) {
    vec2 j = vec2(k & 1, k >> 1);
    vec3 r = nhHash(vec3(cell + j, 7));
    vec2 d = f - j - (r.xy - 0.5)*0.98;
    vec2 axis = normalize(r.yz - vec2(0.43, 0.57) + vec2(0.0001));
    d = vec2(dot(d,axis), d.x*axis.y - d.y*axis.x);
    d.y *= aspect;
    d /= 0.072 + 0.40*r.z*r.z;
    float h = max(0.0, 1.0 - dot(d, d));
    height = max(height, h*h);
  }
  return height;
}

const mat3 nhCrystalAxes = mat3(0.0,0.8,0.6, -0.8,0.36,-0.48, -0.6,-0.48,0.64);

// A slice through a solid 3D ellipsoid. Crystals and vesicles remain attached
// to the stone and continue up a cliff without UV projection changes.
float nhInclusion(vec3 p) {
  p = nhCrystalAxes*p;
  vec3 r = nhHash(floor(p) + 43.1);
  vec3 d = (fract(p) - 0.5 - (r - 0.5)*0.28) / (0.09 + 0.27*r.x);
  float cap = max(0.0, 1.0 - dot(d, d));
  return cap*cap;
}

float nhResolved(float pixelsPerPeriod) {
  return smoothstep(2.0, 4.5, pixelsPerPeriod);
}

struct NHSurface {
  vec3 tint;    // multiplicative change to linear reflectance
  float alpha;  // change to GGX alpha (perceptual roughness squared)
  float height; // signed relief, fractions of the working wavelength
};

// Intersect a jittered family of fracture planes with the rock. A joint
// never reaches a cell boundary (before warp), so its randomly spaced
// neighbour can meet it without an index discontinuity. Dilute the aperture
// across the pixel footprint to preserve the mean when a seam gets thin.
float nhJoint(float plane, float aperture, float footprint, float salt) {
  float center = 0.22 + 0.56*nhHash(vec3(floor(plane),salt,3)).x;
  float width = aperture + min(0.16,footprint*1.35);
  return (1.0 - smoothstep(0.0,width,abs(fract(plane)-center))) * aperture/width;
}

NHSurface nhStone(vec3 p, float footprint, float fold, float meso, float fine) {
  NHSurface s;
  // Unequal oblique axes avoid horizontal/vertical grid locking. Sampling
  // the full 3D solid gives distinct outcrop sections on different slopes.
  float section = p.y + (nhBiome < 0.5 ? 0.46 : 0.14)*p.x;
  float bed = section + 0.82*fold + 0.12*meso;
  if (nhBiome < 0.5) {
    // Gneiss: pale, lenticular leucosomes wrapped around dark biotite folia.
    float lensField = smoothstep(-0.34, 0.28, fold + 0.6*meso);
    float lens = nhBands(bed*2.8, footprint*3.6, 0.21) * lensField;
    float mica = nhBands(bed*6.6 + 1.8*fold, footprint*9.0, 0.16)
               * smoothstep(-0.32,0.25,meso + 0.4*fold);
    float crystal = nhInclusion(vec3(p.x + 0.6*p.y, p.y*2.6, p.z)*8.0)
                  * nhResolved(1.0/(footprint*16.0));
    s.tint = (lens - 0.10)*vec3(0.51,0.47,0.42)
           - (mica - 0.08)*vec3(0.24,0.27,0.30) + crystal*vec3(0.56)
           + fine*vec3(0.28,0.25,0.21) + meso*vec3(0.12);
    s.alpha = -0.12*lens + 0.07*mica - 0.17*crystal;
    s.height = 0.010*nhRib(bed*2.8-0.105,0.14,footprint*3.6)*lensField
             - 0.003*nhRib(bed*6.6+1.8*fold-0.08,0.12,footprint*9.0)
             + 0.005*crystal + 0.005*fine;
  } else if (nhBiome < 1.5) {
    // Sets of cross-laminae truncate at an erosional bounding surface.
    float crossbed = sin(6.2831853*(bed*0.7 + 0.2*meso));
    float lamina = nhBands(bed*5.6 + crossbed*0.9, footprint*9.0, 0.23);
    float iron = smoothstep(-0.08, 0.32, fold + 0.5*meso);
    s.tint = (lamina - 0.23)*mix(vec3(0.24,0.20,0.13),
                                     vec3(0.17,-0.10,-0.25), iron)
           + fine*vec3(0.15,0.12,0.08);
    s.alpha = 0.08*lamina + fine*0.04;
    s.height = 0.007*nhRib(bed*5.6+crossbed*0.9-0.115,0.16,footprint*9.0) + fine*0.003;
  } else {
    // Gas pockets in basalt are recessed cavities. Fresh fracture faces
    // expose the dark matrix; oxidised scoria rims pick up a red-brown hue.
    float pore = nhInclusion((p + vec3(fold, meso, -fold)*0.32)*4.1)
               * nhResolved(1.0/(footprint*5.7));
    float rim = smoothstep(0.008, 0.10, pore)*(1.0 - smoothstep(0.12,0.42,pore));
    float oxidised = smoothstep(-0.12, 0.28, fold);
    s.tint = -pore*vec3(0.39,0.42,0.45) + rim*oxidised*vec3(0.55,0.10,-0.10)
           + meso*vec3(0.23) + fine*vec3(0.30,0.25,0.20);
    s.alpha = pore*0.19 + rim*0.08 + 0.055*meso;
    s.height = -pore*0.034 + rim*0.003 + meso*0.011 + fine*0.006;
  }
  float setA = nhJoint(dot(p, vec3(0.86,0.37,0.12)) + 0.75*fold + 0.18*meso + 0.025*fine,
                       0.025, footprint, 17.0);
  float setB = nhJoint(dot(p, vec3(-0.34,0.15,0.96)) - 0.70*fold + 0.12*meso,
                       0.017, footprint, 41.0);
  float joint = max(setA*smoothstep(-0.13,0.28,fold+meso),
                    setB*smoothstep(-0.04,0.33,meso-fold));
  s.height -= 0.013*joint;
  s.tint -= joint*vec3(0.31,0.32,0.34);
  s.alpha += 0.11*joint;
  return s;
}

NHSurface nhSediment(vec2 ground, float footprint, float warp, float meso, float fine) {
  vec2 w = ground + vec2(warp, -0.63*warp)*0.32;
  float stones = nhParticle(w*2.5, 1.25)*nhResolved(1.0/(footprint*3.2));
  vec2 rotated = mat2(0.80,0.60,-0.60,0.80)*w;
  float gravel = nhParticle(rotated*8.3 + 5.1, 1.15)*nhResolved(1.0/(footprint*9.5));
  NHSurface s;
  if (nhBiome > 0.5 && nhBiome < 1.5) {
    // Saltating sand sorts coarse grains onto narrow ripple crests.
    float phase = dot(ground, vec2(3.48, 0.31)) + warp*1.75 + 0.41*meso;
    float crest = (0.38*cos(6.2831853*phase)
                 + 0.12*sin(12.566371*phase)*nhResolved(1.0/(footprint*8.4)))
                * nhResolved(1.0/(footprint*4.2)) * (0.68 + 0.58*warp);
    s.tint = crest*vec3(0.17,0.14,0.09) + stones*vec3(0.21,0.10,-0.03);
    s.height = 0.012*crest + 0.022*stones;
    s.alpha = 0.055*crest - 0.10*stones;
  } else {
    vec3 clast = nhBiome < 0.5 ? vec3(0.40,0.47,0.53) : vec3(0.51,0.19,0.055);
    s.tint = (stones - 0.035)*clast + (gravel - 0.035)*vec3(0.27);
    s.height = stones*0.055 + gravel*0.013;
    s.alpha = -0.16*stones - 0.09*gravel;
  }
  s.tint += fine*vec3(0.26,0.22,0.17) + meso*vec3(0.19,0.14,0.10);
  s.height += fine*0.006 + meso*0.009;
  return s;
}

NHSurface nhVegetation(vec2 ground, float footprint, float warp, float meso, float fine) {
  // Closed cushions of growth with directional tapered leaf clusters.
  vec2 cluster = ground*1.65 + vec2(0.65,-0.31)*warp;
  float crown = nhParticle(cluster, 1.18)*nhResolved(1.0/(footprint*2.0));
  vec2 tangent = mat2(0.92,-0.392,0.392,0.92)*cluster;
  vec2 rib = vec2(tangent.x*11.0 + 2.8*meso, tangent.y*2.4 + 0.29*sin(tangent.x*3.3));
  float blades = nhParticle(rib, 1.0)*nhResolved(1.0/(footprint*18.2));
  NHSurface s;
  float litter = smoothstep(-0.12, 0.27, warp + 0.75*meso);
  s.tint = (crown - 0.035)*vec3(-0.19,0.24,-0.14)
         + (litter - 0.42)*vec3(0.40,0.10,-0.14)
         + blades*vec3(0.63,0.43,0.19) + fine*vec3(0.31,0.34,0.16);
  s.height = crown*0.033 + blades*0.008 + meso*0.011 + 0.006*fine;
  s.alpha = -0.10*crown - 0.07*blades;
  if (nhBiome > 1.5) {
    // Pioneer lichen forms continuous low crust with pale lobed growing edges.
    float colony = warp + 0.72*meso + 0.33*fine;
    float skin = smoothstep(-0.07,0.16,colony);
    float margin = 4.0*skin*(1.0-skin);
    s.tint = (skin - 0.48)*vec3(0.38,0.40,0.23) + margin*vec3(0.26,0.25,0.18)
           + 0.20*fine;
    s.height = 0.011*skin + 0.005*margin + 0.004*fine;
    s.alpha = 0.09*margin + 0.065*skin;
  } else if (nhBiome > 0.5) {
    // Sparse woody steppe crowns sit in the dry litter between shrubs.
    float shrub = smoothstep(0.02,0.29,warp + 0.69*meso + 0.18*fine);
    s.tint += (shrub - 0.41)*vec3(-0.33,0.18,-0.23) + blades*vec3(0.36,0.24,0.05);
    s.height += shrub*0.034;
    s.alpha += (shrub - 0.41)*0.10;
  }
  return s;
}

NHSurface nhSnow(vec2 ground, float footprint, float wind, float meso, float fine) {
  // Windward sheet and a narrow eroded lee lip for each sastruga.
  vec2 windAxes = mat2(0.996,0.089,-0.089,0.996)*ground;
  vec2 drift = vec2(windAxes.x*0.54 + wind*0.45, windAxes.y*2.1 + 0.61*meso);
  float flute = nhParticle(drift,1.0)*nhResolved(1.0/(footprint*2.5));
  float phase = windAxes.y*2.45 + wind*1.1 + meso*0.32;
  float lip = (nhBands(phase, footprint*3.1, 0.20) - 0.20)
            * smoothstep(-0.05, 0.44, wind + 0.35*meso);
  float sheet = cos(6.2831853*(phase - 0.20))*nhResolved(1.0/(footprint*3.1));
  NHSurface s;
  s.tint = sheet*vec3(0.009,0.011,0.013) + flute*vec3(0.012,0.016,0.020);
  s.alpha = -0.045*sheet + 0.09*flute + 0.06*fine;
  float crest = nhRib(phase-0.10,0.19,footprint*3.1)
              * smoothstep(-0.05,0.44,wind + 0.35*meso);
  s.height = 0.004*sheet + 0.004*crest + 0.026*flute + fine*0.002;
  return s;
}
void nhAccumulate(inout NHSurface sum, NHSurface surface, float weight) {
  sum.tint += weight*surface.tint;
  sum.alpha += weight*surface.alpha;
  sum.height += weight*surface.height;
}

NHSurface nhEvaluate(vec3 p, float footprint, vec4 layers) {
  float fold = nhNoise(p*0.69);
  float meso = nhNoise(p*2.51 + vec3(13.8, 7.3, 2.1)) *
       nhResolved(1.0/(footprint*2.51));
  float fine = 0.0;
  float grainVisibility = nhResolved(1.0/(footprint*12.5));
  if (grainVisibility > 0.0)
    fine = nhNoise(p*12.5 + vec3(-3.2, 7.4, 8.1))*grainVisibility;
  NHSurface sum = NHSurface(vec3(0),0.0,0.0);
  if (layers.x > 0.0)
    nhAccumulate(sum, nhStone(p, footprint, fold, meso, fine), layers.x);
  if (layers.y > 0.0)
    nhAccumulate(sum, nhSediment(p.xz, footprint, fold, meso, fine), layers.y);
  if (layers.z > 0.0)
    nhAccumulate(sum, nhVegetation(p.xz, footprint, fold, meso, fine), layers.z);
  if (layers.w > 0.0)
    nhAccumulate(sum, nhSnow(p.xz, footprint, fold, meso, fine), layers.w);
  return sum;
}

`;

const GLSL_ALBEDO = `
#if defined(USE_MAP) && defined(USE_ROUGHNESSMAP) && defined(USE_NORMALMAP)
  vec2 nhReliefDelta = vec2(0.0);
  float nhAlphaShift = 0.0;
  if (nhNearFieldActive > 0.5 && nhDetailStrength > 0.0001) {
    vec3 nhMetersPosition = vNHPosition * nhMetersPerUnit;
    float wavelength = max(0.4, nhDetailMeters * 0.22);
    vec3 p = nhMetersPosition / wavelength
           + vec3(1.71, -2.33, 3.17)*nhDetailSeed;
    // Rotate into the same seed-fixed horizontal frame as the worker bake.
    vec2 axis = vec2(cos(nhFabricAzimuth), sin(nhFabricAzimuth));
    p.xz = mat2(axis.x,-axis.y,axis.y,axis.x)*p.xz;
    // Object coordinates exclude presentation-only vertical exaggeration.
    vec3 pDx = dFdx(p), pDy = dFdy(p);
    float footprint = max(0.000001, max(length(pDx), length(pDy)));
    // Explicit gradients keep mip selection legal at fragments along the
    // close/far boundary, where neighbouring lanes may skip the detail path.
    vec2 ormDx = dFdx(vRoughnessMapUv), ormDy = dFdy(vRoughnessMapUv);
    vec2 normDx = dFdx(vNormalMapUv), normDy = dFdy(vNormalMapUv);
    float visibility = 1.0 - smoothstep(0.28, 0.52, footprint);
    if (visibility > 0.0) {
      vec4 packedORM = textureGrad(roughnessMap, vRoughnessMapUv, ormDx, ormDy);
      float vegetation = textureGrad(normalMap, vNormalMapUv, normDx, normDy).a;
      vec3 rsv = vec3(packedORM.ba, vegetation);
      vec4 layers = vec4(rsv, max(0.0, 1.0 - dot(rsv, vec3(1.0))));
      layers /= max(dot(layers, vec4(1.0)), 0.0001);
      // Three samples of the same surface form a centred, subpixel triangle.
      // Its height differences give each fragment its own screened gradient.
      // Hardware dFdx(height) duplicates a slope across a 2x2 fragment quad;
      // on a thin bright snow lip that produces alternating black/white steps.
      const float span = 0.90;
      vec3 a = p - (pDx+pDy)*(span/3.0);
      NHSurface sa = nhEvaluate(a, footprint, layers);
      NHSurface sb = nhEvaluate(a+span*pDx, footprint, layers);
      NHSurface sc = nhEvaluate(a+span*pDy, footprint, layers);
      float gain = visibility * nhDetailStrength;
      vec3 tint = (sa.tint + sb.tint + sc.tint)/3.0;
      diffuseColor.rgb = clamp(diffuseColor.rgb*(1.0 + gain*tint), 0.0, 1.0);
      nhAlphaShift = gain*(sa.alpha+sb.alpha+sc.alpha)/3.0;
      nhReliefDelta = (gain*wavelength/span) * vec2(sb.height-sa.height, sc.height-sa.height);
    }
  }
#endif
`;

const GLSL_ROUGHNESS = `
#if defined(USE_MAP) && defined(USE_ROUGHNESSMAP) && defined(USE_NORMALMAP)
  roughnessFactor = sqrt(clamp(roughnessFactor*roughnessFactor + nhAlphaShift, 0.04, 1.0));
#endif
`;

const GLSL_NORMAL = `
#if defined(USE_MAP) && defined(USE_ROUGHNESSMAP) && defined(USE_NORMALMAP)
  if (nhNearFieldActive > 0.5 && nhDetailStrength > 0.0001) {
    // Surface gradient of the filtered height: reciprocal tangent vectors
    // transform meter/meter derivatives to view space even on steep slopes.
    vec3 dx = dFdx(-vViewPosition)*nhMetersPerUnit;
    vec3 dy = dFdy(-vViewPosition)*nhMetersPerUnit;
    vec3 rx = cross(dy, normal), ry = cross(normal, dx);
    float determinant = dot(dx, rx);
    if (abs(determinant) > 0.0000001*length(dx)*length(dy)) {
      vec3 gradient = (nhReliefDelta.x*rx + nhReliefDelta.y*ry)/determinant;
      // Smoothly limit the added near-field relief to a 33-degree
      // tilt. A grazing view cannot turn a subpixel grain into a black spike.
      const float limit = 0.65;
      gradient *= limit*inversesqrt(limit*limit + dot(gradient,gradient));
      normal = normalize(normal - gradient);
    }
  }
#endif
`;

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
