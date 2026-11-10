import * as THREE from 'three';

/**
 * Periodic seeded cloud field. Computing its multi-octave structure once on
 * the CPU is markedly cheaper than evaluating dozens of hash/noise functions
 * per pixel on every WebGL frame.
 */
export function generateCloudTexture(size = 256): THREE.DataTexture {
  const bytes = new Uint8Array(size * size * 4);
  const randomCell = (x: number, y: number, period: number, salt: number) => {
    const ix = ((x % period) + period) % period;
    const iy = ((y % period) + period) % period;
    let key = (Math.imul(ix + salt, 374761393) +
      Math.imul(iy + salt * 17, 668265263)) | 0;
    key = Math.imul(key ^ (key >>> 13), 1274126177);
    return ((key ^ (key >>> 16)) >>> 0) / 4294967295;
  };
  const valueNoise = (u: number, v: number, period: number, salt: number) => {
    const x = u * period, y = v * period;
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = THREE.MathUtils.smoothstep(x - ix, 0, 1);
    const fy = THREE.MathUtils.smoothstep(y - iy, 0, 1);
    const a = THREE.MathUtils.lerp(randomCell(ix, iy, period, salt),
      randomCell(ix + 1, iy, period, salt), fx);
    const b = THREE.MathUtils.lerp(randomCell(ix, iy + 1, period, salt),
      randomCell(ix + 1, iy + 1, period, salt), fx);
    return THREE.MathUtils.lerp(a, b, fy);
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    const broad = valueNoise(u, v, 4, 13) * 0.5 +
      valueNoise(u, v, 8, 31) * 0.32 + valueNoise(u, v, 16, 59) * 0.18;
    const mid = valueNoise(u, v, 16, 23) * 0.64 +
      valueNoise(u, v, 32, 71) * 0.36;
    const fine = valueNoise(u, v, 48, 37);
    const i = (y * size + x) * 4;
    bytes[i] = Math.round(broad * 255);
    bytes[i + 1] = Math.round(mid * 255);
    bytes[i + 2] = Math.round(fine * 255);
    bytes[i + 3] = 255;
  }
  const texture = new THREE.DataTexture(bytes, size, size, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Shared density function for the visible cloud deck and terrain shadows. */
export const CLOUD_DENSITY_GLSL = `
float nhCloudDensity(vec2 uv) {
  vec3 n = texture2D(nhCloudTexture, uv).rgb;
  float shape = dot(n, vec3(0.64, 0.25, 0.11));
  float cutoff = mix(0.72, 0.34, nhCloudCoverage);
  return smoothstep(cutoff - 0.09, cutoff + 0.09, shape);
}
`;

/** Compose with the existing terrain/grass shader extensions. */
export function wrapCloudShadows(
  material: THREE.MeshStandardMaterial,
  shared: {
    nhCloudTexture: { value: THREE.Texture };
    nhCloudCoverage: { value: number };
    nhCloudWind: { value: number };
    nhCloudSun: { value: THREE.Vector3 };
    nhCloudShadowStrength: { value: number };
  },
): () => void {
  const original = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    original.call(material, shader, renderer);
    Object.assign(shader.uniforms, shared);
    shader.vertexShader = 'varying vec3 vNHCloudWorld;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <worldpos_vertex>',
      `#include <worldpos_vertex>
      vec4 nhCloudPoint = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        nhCloudPoint = instanceMatrix * nhCloudPoint;
      #endif
      vNHCloudWorld = (modelMatrix * nhCloudPoint).xyz;`);
    shader.fragmentShader = `
      uniform sampler2D nhCloudTexture;
      uniform float nhCloudCoverage;
      uniform float nhCloudWind;
      uniform float nhCloudShadowStrength;
      uniform vec3 nhCloudSun;
      varying vec3 vNHCloudWorld;
      ${CLOUD_DENSITY_GLSL}
    ` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_end>',
      `#include <lights_fragment_end>
      if (nhCloudShadowStrength > 0.001) {
        // Project shadows toward the terrain along the real sun direction.
        vec2 sunOffset = nhCloudSun.xz / max(0.18, nhCloudSun.y) * 2.1;
        vec2 uv = (vNHCloudWorld.xz - sunOffset) * 0.31 +
                  vec2(nhCloudWind * 0.13, nhCloudWind * 0.06);
        float cloudShadow = nhCloudDensity(uv);
        float brightness = 1.0 - cloudShadow * nhCloudShadowStrength;
        reflectedLight.directDiffuse *= brightness;
        reflectedLight.directSpecular *= brightness;
      }`);
  };
  material.needsUpdate = true;
  return () => {
    material.onBeforeCompile = original;
    material.needsUpdate = true;
  };
}
