import * as THREE from 'three';
import type { HeightField, TerrainProject, ViewSettings } from '../model/types';
import { TERRAIN_SIZE } from './GroundExtension';
import { resolveWaterLevelMeters, WATER_PALETTES, waterSceneHeight } from './water';

/**
 * Physically scaled, depth-aware, translucent water in its own render pass.
 * Shoreline foam is sampled from the original DEM, not the camera-dependent
 * terrain tessellation. All effects are GPU-only and do not modify heightfields.
 *
 * Float32 RED + nearest sampling preserves sub-meter coastal bathymetry even
 * when the source elevations span thousands of meters. The shader performs
 * its own four-tap bilinear sampling to avoid seams across differently sized
 * adaptive terrain triangles.
 */
const waterVertex = String.raw`
  uniform float uTileSize;
  uniform float uExtent;
  uniform float uMetersPerUnit;
  uniform float uWaveScene;
  uniform float uSwellMeters;
  uniform float uTime;
  varying vec3 vWaterWorld;
  varying vec2 vWaterUV;
  varying vec2 vMetric;

  void main() {
    vec3 positionWater = position;
    vec2 metric = position.xz * uExtent * uMetersPerUnit;
    float swell = dot(metric, normalize(vec2(0.91, 0.41))) * 6.2831853 / uSwellMeters - uTime * 0.58;
    float crossSwell = dot(metric, normalize(vec2(-0.39, 0.92))) * 6.2831853 / (uSwellMeters * 0.59) - uTime * 0.93;
    positionWater.y += uWaveScene * (0.67 * sin(swell) + 0.33 * sin(crossSwell));
    vec4 world = modelMatrix * vec4(positionWater, 1.0);
    vWaterWorld = world.xyz;
    vMetric = metric;
    vWaterUV = metric / (uTileSize * uMetersPerUnit) + 0.5;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const waterFragment = String.raw`
  precision highp float;
  uniform sampler2D uHeightMap;
  uniform float uResolution;
  uniform float uSeaRaw;
  uniform float uHeightScale;
  uniform float uWaveHeightMeters;
  uniform float uTime;
  uniform float uSwellMeters;
  uniform float uClarity;
  uniform float uFoam;
  uniform float uSkyEnabled;
  uniform float uCloudCover;
  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;
  uniform vec3 uShallow;
  uniform vec3 uDeep;
  uniform vec3 uFoamColor;
  varying vec3 vWaterWorld;
  varying vec2 vWaterUV;
  varying vec2 vMetric;
  #include <fog_pars_fragment>

  float rawHeight(vec2 uv) {
    // Read four nearest Float32 texels explicitly; linear filtering of a
    // float texture is not portable to WebGL2 without an optional extension.
    vec2 pixel = clamp(uv, 0.0, 1.0) * (uResolution - 1.0);
    vec2 lo = floor(pixel);
    vec2 hi = min(lo + 1.0, uResolution - 1.0);
    vec2 f = pixel - lo;
    float a = texture2D(uHeightMap, (lo + 0.5) / uResolution).r;
    float b = texture2D(uHeightMap, (vec2(hi.x, lo.y) + 0.5) / uResolution).r;
    float c = texture2D(uHeightMap, (vec2(lo.x, hi.y) + 0.5) / uResolution).r;
    float d = texture2D(uHeightMap, (hi + 0.5) / uResolution).r;
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  // Three directions at different scales keep the sun glitter fragmented
  // rather than making a uniform, synthetic-looking specular stripe.
  vec2 waveSlopes(vec2 metres) {
    float swell = dot(metres, normalize(vec2(0.91, 0.41))) * 6.2831853 / uSwellMeters - uTime * 0.58;
    float crossSwell = dot(metres, normalize(vec2(-0.39, 0.92))) * 6.2831853 / (uSwellMeters * 0.59) - uTime * 0.93;
    float detail = dot(metres, normalize(vec2(0.74, -0.67))) * 0.43 + uTime * 1.53;
    float ripple = dot(metres, normalize(vec2(-0.68, -0.73))) * 1.21 - uTime * 2.16;
    return uWaveHeightMeters * (
      normalize(vec2(0.91, 0.41)) * (0.67 * cos(swell) * 6.2831853 / uSwellMeters) +
      normalize(vec2(-0.39, 0.92)) * (0.33 * cos(crossSwell) * 6.2831853 / (uSwellMeters * 0.59)) +
      normalize(vec2(0.74, -0.67)) * (0.057 * cos(detail)) +
      normalize(vec2(-0.68, -0.73)) * (0.024 * cos(ripple))
    );
  }

  void main() {
    bool insideTile = all(greaterThanEqual(vWaterUV, vec2(0.0))) &&
      all(lessThanEqual(vWaterUV, vec2(1.0)));
    // Beyond a tile we continue the open sea when the scenery is expanded.
    float elevation = insideTile ? rawHeight(vWaterUV) : uSeaRaw - 150.0 / uHeightScale;
    float depth = (uSeaRaw - elevation) * uHeightScale;
    float washDistance = max(0.35, uWaveHeightMeters * 0.65);
    if (insideTile && depth < -washDistance) discard;

    vec3 V = normalize(cameraPosition - vWaterWorld);
    vec2 grade = waveSlopes(vMetric);
    vec3 N = normalize(vec3(-grade.x, 1.0, -grade.y));
    float ndv = clamp(dot(N, V), 0.0, 1.0);
    float fresnel = 0.020 + 0.980 * pow(1.0 - ndv, 5.0);

    // The blue-green body is lit through Beer-Lambert absorption. Shallow
    // areas remain translucent, revealing the actual terrain beneath.
    float absorption = mix(2.7, 34.0, uClarity);
    float depthColor = 1.0 - exp(-max(0.0, depth) / (absorption * 0.8));
    vec3 body = mix(uShallow, uDeep, depthColor * 0.94);
    float sunHeight = clamp(uSunDirection.y, 0.0, 1.0);
    vec3 skyZenith = mix(vec3(0.14, 0.29, 0.50), vec3(0.25, 0.52, 0.79), uSkyEnabled);
    vec3 skyHorizon = mix(vec3(0.67, 0.79, 0.85), vec3(0.58, 0.74, 0.81), uSkyEnabled);
    skyHorizon = mix(skyHorizon, vec3(0.95, 0.56, 0.39), (1.0 - smoothstep(0.04, 0.48, sunHeight)) * 0.50);
    vec3 reflected = reflect(-V, N);
    vec3 sky = mix(skyHorizon, skyZenith, smoothstep(-0.03, 0.8, reflected.y));
    sky = mix(sky, vec3(0.55, 0.63, 0.68), uCloudCover * uSkyEnabled * 0.31);
    vec3 color = mix(body, sky, 0.10 + 0.79 * fresnel);

    // Soft concentrated highlight plus sharp broken glints for moving light.
    vec3 halfVector = normalize(V + uSunDirection);
    float specular = pow(max(dot(N, halfVector), 0.0), 290.0) * 1.65 +
      pow(max(dot(N, halfVector), 0.0), 28.0) * 0.065;
    float sunVisibility = (0.72 + 0.28 * sunHeight) * (1.0 - uCloudCover * uSkyEnabled * 0.50);
    color += uSunColor * specular * sunVisibility;

    // Refracted caustic glimmer stays near the beach instead of turning
    // deep water into a busy noise texture.
    float caustic = sin(vMetric.x * 0.34 + uTime * 0.9) *
      sin(vMetric.y * 0.29 - uTime * 0.76) +
      0.32 * sin((vMetric.x + vMetric.y) * 0.49 - uTime * 1.3);
    caustic = pow(max(0.0, caustic), 3.0);
    color += uShallow * caustic * 0.065 * (1.0 - smoothstep(1.0, 12.0, depth));

    // Irregular shore wash modulates two foam bands on the actual height
    // contour. Distant foam can only appear on wave crests near the shore.
    float shoreWidth = max(1.2, uWaveHeightMeters * 4.4);
    float shore = 1.0 - smoothstep(0.0, shoreWidth, max(0.0, depth));
    float wash = sin(vMetric.x * 0.15 + sin(vMetric.y * 0.13) * 0.7 - uTime * 1.8);
    float grain = sin(vMetric.y * 0.63 - vMetric.x * 0.22 + uTime * 2.2);
    float breaking = smoothstep(0.35, 0.91, wash * 0.68 + grain * 0.32);
    float foam = uFoam * shore * (0.34 + 0.58 * breaking);
    float rip = sin(dot(vMetric, normalize(vec2(0.91, 0.41))) * 6.2831853 / uSwellMeters - uTime * 0.58);
    foam += uFoam * 0.17 * (1.0 - smoothstep(0.0, shoreWidth * 2.7, max(depth, 0.0))) *
      smoothstep(0.80, 0.98, rip);
    foam = clamp(foam, 0.0, 0.94);
    color = mix(color, uFoamColor, foam);

    float waterAlpha = 0.25 + (1.0 - exp(-max(depth, 0.0) / absorption)) * 0.70 +
      fresnel * 0.19;
    waterAlpha = clamp(waterAlpha + foam * 0.40, 0.0, 0.985);
    waterAlpha *= insideTile ? smoothstep(-washDistance, max(0.15, washDistance * 0.33), depth) : 1.0;
    if (waterAlpha <= 0.005) discard;
    gl_FragColor = vec4(color, waterAlpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export class WaterSurface {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private heightTexture: THREE.DataTexture | null = null;
  private heightSource: Float32Array | null = null;
  private clock = 0;

  constructor(private readonly scene: THREE.Scene) {
    // One modest static grid. Fine normal detail comes from the fragment
    // shader, not millions of vertices or frame-by-frame CPU deformation.
    const geometry = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, 160, 160);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.ShaderMaterial({
      name: 'Cinematic water · Fresnel reflections, foam, caustics and swells',
      vertexShader: waterVertex,
      fragmentShader: waterFragment,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: true,
      fog: true,
      uniforms: {
        uHeightMap: { value: null },
        uResolution: { value: 1 },
        uTileSize: { value: TERRAIN_SIZE },
        uExtent: { value: 1 },
        uMetersPerUnit: { value: 1 },
        uSeaRaw: { value: 0 },
        uHeightScale: { value: 1 },
        uWaveScene: { value: 0 },
        uWaveHeightMeters: { value: 0 },
        uSwellMeters: { value: 120 },
        uTime: { value: 0 },
        uClarity: { value: 0.75 },
        uFoam: { value: 0.78 },
        uSkyEnabled: { value: 0 },
        uCloudCover: { value: 0 },
        uSunDirection: { value: new THREE.Vector3(0.3, 0.7, 0.5) },
        uSunColor: { value: new THREE.Color('#fff2dc') },
        uShallow: { value: new THREE.Color('#49c9b8') },
        uDeep: { value: new THREE.Color('#093a62') },
        uFoamColor: { value: new THREE.Color('#e6fff9') },
      },
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'Cinematic water surface (preview only)';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.scene.add(this.mesh);
  }

  update(field: HeightField, project: TerrainProject, settings: ViewSettings) {
    if (this.heightSource !== field.height) {
      this.heightTexture?.dispose();
      const texture = new THREE.DataTexture(
        field.height, field.resolution, field.resolution, THREE.RedFormat, THREE.FloatType,
      );
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestFilter;
      texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.generateMipmaps = false;
      texture.unpackAlignment = 1;
      texture.needsUpdate = true;
      this.heightTexture = texture;
      this.heightSource = field.height;
      this.mesh.material.uniforms.uHeightMap.value = texture;
    }
    const u = this.mesh.material.uniforms;
    const level = resolveWaterLevelMeters(project, settings, field);
    const extent = settings.expandGround ? 2.5 : 1;
    this.mesh.scale.set(extent, 1, extent);
    this.mesh.position.y = waterSceneHeight(level, project, settings.exaggeration) + 0.00012;
    u.uExtent.value = extent;
    u.uResolution.value = field.resolution;
    u.uMetersPerUnit.value = project.worldSize / TERRAIN_SIZE;
    u.uSeaRaw.value = level / project.heightScale;
    u.uHeightScale.value = project.heightScale;
    u.uWaveHeightMeters.value = settings.waterWaveHeight;
    u.uWaveScene.value = settings.waterWaveHeight * TERRAIN_SIZE /
      project.worldSize * settings.exaggeration;
    u.uSwellMeters.value = Math.max(75, project.worldSize * 0.035);
    u.uClarity.value = settings.waterClarity;
    u.uFoam.value = settings.waterFoam;
    u.uSkyEnabled.value = settings.skyEnabled ? 1 : 0;
    u.uCloudCover.value = settings.cloudCoverage;
    const azimuth = THREE.MathUtils.degToRad(settings.sunAzimuth);
    const elevation = THREE.MathUtils.degToRad(settings.sunElevation);
    (u.uSunDirection.value as THREE.Vector3).set(
      Math.sin(azimuth) * Math.cos(elevation),
      Math.sin(elevation),
      Math.cos(azimuth) * Math.cos(elevation),
    ).normalize();
    const sunset = 1 - THREE.MathUtils.smoothstep(settings.sunElevation, 5, 30);
    (u.uSunColor.value as THREE.Color).set('#fff8e8')
      .lerp(new THREE.Color('#ffad76'), sunset * 0.70);
    const palette = WATER_PALETTES[settings.waterPalette];
    (u.uShallow.value as THREE.Color).set(palette.shallow);
    (u.uDeep.value as THREE.Color).set(palette.deep);
    (u.uFoamColor.value as THREE.Color).set(palette.foam);
    this.setTime(this.clock, settings.waterSpeed);
  }

  /** Update a single uniform; no reallocations or heightmap recomputations. */
  setTime(seconds: number, speed: number) {
    this.clock = seconds;
    this.mesh.material.uniforms.uTime.value = seconds * speed;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.heightTexture?.dispose();
    this.heightTexture = null;
    this.heightSource = null;
  }
}
