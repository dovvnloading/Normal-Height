import * as THREE from 'three';
import { TERRAIN_SIZE } from './GroundExtension';

/**
 * Per-pixel source normals: the real-time counterpart of sub-polygon
 * displacement shading.
 *
 * The preview mesh is adaptive, so its vertices are often several source
 * samples apart. Shading from interpolated *vertex* normals then loses every
 * ridge and gully smaller than a triangle, and with fine fluvial dissection
 * neighbouring vertex normals point in very different directions, so each
 * triangle is lit as its own hard facet.
 *
 * Instead, the exact Sobel slopes of the source heightfield are stored in a
 * half-float texture at full source resolution and read per pixel: smooth
 * Catmull-Rom interpolation where a texel covers more than a pixel, and a
 * mip chain filtered on the CPU where it covers less (no shimmering at
 * distance). Lighting therefore shows the full source detail at any mesh
 * density, and micro-detail normal maps perturb this true surface normal.
 * Geometry, shadows, exports and the heightfield itself are unchanged.
 */

export interface SourceNormalUniforms {
  nhSlopeMap: { value: THREE.DataTexture | null };
  nhSlopeSize: { value: THREE.Vector2 };
  nhVerticalScale: { value: number };
  nhTerrainSize: { value: number };
  nhSourceNormals: { value: number };
}

export function createSourceNormalUniforms(): SourceNormalUniforms {
  return {
    nhSlopeMap: { value: null },
    nhSlopeSize: { value: new THREE.Vector2(1, 1) },
    nhVerticalScale: { value: 1 },
    nhTerrainSize: { value: TERRAIN_SIZE },
    nhSourceNormals: { value: 0 },
  };
}

/**
 * RG half-float slope texture (x = d height/dx, y = d height/dz, physical and
 * unexaggerated) with a full CPU-built mip chain: half-float textures are
 * filterable in WebGL2, but generating their mipmaps on the GPU needs a
 * renderable float format that WebGL2 does not guarantee.
 */
export function createSlopeTexture(
  slopes: { x: Float32Array; z: Float32Array },
  n: number,
): THREE.DataTexture {
  if (!Number.isInteger(n) || n < 2 || slopes.x.length !== n * n || slopes.z.length !== n * n)
    throw new Error('Slope texture requires aligned square slope fields.');
  const levels: Array<{ data: Uint16Array; width: number; height: number }> = [];
  let size = n;
  let x: Float32Array = slopes.x, z: Float32Array = slopes.z;
  for (;;) {
    const data = new Uint16Array(size * size * 2);
    for (let i = 0; i < size * size; i++) {
      data[i * 2] = THREE.DataUtils.toHalfFloat(x[i]);
      data[i * 2 + 1] = THREE.DataUtils.toHalfFloat(z[i]);
    }
    levels.push({ data, width: size, height: size });
    if (size === 1) break;
    // 2×2 box reduction; odd sizes clamp the last row/column.
    const next = Math.max(1, size >> 1);
    const nx = new Float32Array(next * next), nz = new Float32Array(next * next);
    for (let y = 0; y < next; y++) for (let col = 0; col < next; col++) {
      const x0 = Math.min(size - 1, col * 2), x1 = Math.min(size - 1, col * 2 + 1);
      const y0 = Math.min(size - 1, y * 2), y1 = Math.min(size - 1, y * 2 + 1);
      const a = y0 * size + x0, b = y0 * size + x1, c = y1 * size + x0, d = y1 * size + x1;
      nx[y * next + col] = (x[a] + x[b] + x[c] + x[d]) * 0.25;
      nz[y * next + col] = (z[a] + z[b] + z[c] + z[d]) * 0.25;
    }
    x = nx;
    z = nz;
    size = next;
  }
  const texture = new THREE.DataTexture(levels[0].data, n, n, THREE.RGFormat, THREE.HalfFloatType);
  texture.mipmaps = levels;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.NoColorSpace;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

const GLSL_PARS = `
uniform sampler2D nhSlopeMap;
uniform vec2 nhSlopeSize;
uniform float nhVerticalScale;
uniform float nhTerrainSize;
uniform float nhSourceNormals;

// 9-tap Catmull-Rom from bilinear taps: C1-smooth and interpolating, so
// magnified slopes show no texel diamonds or creases.
vec2 nhSlopeCatmullRom(vec2 uv) {
  vec2 samplePos = uv * nhSlopeSize;
  vec2 texPos1 = floor(samplePos - 0.5) + 0.5;
  vec2 f = samplePos - texPos1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 offset12 = w2 / w12;
  vec2 p0 = (texPos1 - 1.0) / nhSlopeSize;
  vec2 p3 = (texPos1 + 2.0) / nhSlopeSize;
  vec2 p12 = (texPos1 + offset12) / nhSlopeSize;
  vec2 s = textureLod(nhSlopeMap, vec2(p0.x, p0.y), 0.0).rg * w0.x * w0.y;
  s += textureLod(nhSlopeMap, vec2(p12.x, p0.y), 0.0).rg * w12.x * w0.y;
  s += textureLod(nhSlopeMap, vec2(p3.x, p0.y), 0.0).rg * w3.x * w0.y;
  s += textureLod(nhSlopeMap, vec2(p0.x, p12.y), 0.0).rg * w0.x * w12.y;
  s += textureLod(nhSlopeMap, vec2(p12.x, p12.y), 0.0).rg * w12.x * w12.y;
  s += textureLod(nhSlopeMap, vec2(p3.x, p12.y), 0.0).rg * w3.x * w12.y;
  s += textureLod(nhSlopeMap, vec2(p0.x, p3.y), 0.0).rg * w0.x * w3.y;
  s += textureLod(nhSlopeMap, vec2(p12.x, p3.y), 0.0).rg * w12.x * w3.y;
  s += textureLod(nhSlopeMap, vec2(p3.x, p3.y), 0.0).rg * w3.x * w3.y;
  return s;
}

// True surface normal of the source heightfield in view space. Terrain
// object x/z span ±nhTerrainSize/2; texel centres sit at the source samples.
vec3 nhSourceNormal(vec3 objectPosition) {
  vec2 st = clamp(objectPosition.xz / nhTerrainSize + 0.5, 0.0, 1.0);
  vec2 uv = (st * (nhSlopeSize - 1.0) + 0.5) / nhSlopeSize;
  // Derivatives are taken before branching (undefined in divergent flow).
  vec2 duvx = dFdx(uv), duvy = dFdy(uv);
  vec2 texelX = duvx * nhSlopeSize, texelY = duvy * nhSlopeSize;
  float footprint = max(dot(texelX, texelX), dot(texelY, texelY));
  vec2 slope = footprint < 1.0
    ? nhSlopeCatmullRom(uv)
    : textureGrad(nhSlopeMap, uv, duvx, duvy).rg;
  slope *= nhVerticalScale;
  vec3 world = normalize(vec3(-slope.x, 1.0, -slope.y));
  return normalize((viewMatrix * vec4(world, 0.0)).xyz);
}
`;

const VERTEX_NORMAL = 'vec3 normal = normalize( vNormal );';

const GLSL_APPLY = `
	if ( nhSourceNormals > 0.5 ) {
		vec3 nhSurface = nhSourceNormal( vNHPosition );
		// The meadow apron continues the mesh's vertex normals at the tile
		// edge; hand over to them across the outermost band so no seam shows.
		float nhEdge = 0.5 * nhTerrainSize - max( abs( vNHPosition.x ), abs( vNHPosition.z ) );
		float nhKeep = nhMeadowBlend > 0.5 ? smoothstep( 0.0, 0.02 * nhTerrainSize, nhEdge ) : 1.0;
		normal = normalize( mix( normal, nhSurface, nhKeep ) );
	}
`;

interface ShaderTarget {
  fragmentShader: string;
  uniforms: Record<string, { value: unknown }>;
}

/** The normal_fragment_begin chunk with the vertex normal replaced per pixel. */
export function patchedNormalFragmentBegin(): string {
  const chunk = THREE.ShaderChunk.normal_fragment_begin;
  if (!chunk.includes(VERTEX_NORMAL))
    throw new Error('Three.js normal_fragment_begin no longer contains the vertex normal.');
  return chunk.replace(VERTEX_NORMAL, VERTEX_NORMAL + '\n' + GLSL_APPLY);
}

/**
 * Install into the terrain material's onBeforeCompile. Requires the varying
 * `vNHPosition` (object-space position) and `nhMeadowBlend` uniform that
 * TerrainScene's shader already declares.
 */
export function installSourceNormals(shader: ShaderTarget, uniforms: SourceNormalUniforms) {
  const marker = '#include <normal_fragment_begin>';
  if (!shader.fragmentShader.includes(marker))
    throw new Error('Terrain shader does not contain normal_fragment_begin.');
  if (!shader.fragmentShader.includes('vNHPosition') || !shader.fragmentShader.includes('nhMeadowBlend'))
    throw new Error('Source normals need the terrain position varying and meadow uniform.');
  for (const [name, uniform] of Object.entries(uniforms)) shader.uniforms[name] = uniform;
  shader.fragmentShader = GLSL_PARS + '\n' +
    shader.fragmentShader.replace(marker, patchedNormalFragmentBegin());
}
