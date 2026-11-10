import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import type { ViewSettings } from '../model/types';
import { CLOUD_DENSITY_GLSL, generateCloudTexture, wrapCloudShadows } from './weather';

/**
 * A camera-following physical sky, a separate animated cloud shell, and a
 * prefiltered sky light probe. The sky isn't just a background: its sun and
 * ambient radiance illuminate the terrain's Standard/PBR materials.
 */
const cloudVertex = `
  varying vec3 vDirection;
  void main() {
    vDirection = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const cloudFragment = `
  uniform sampler2D nhCloudTexture;
  uniform float nhCloudCoverage;
  uniform float nhCloudWind;
  uniform vec3 nhCloudSun;
  uniform float haze;
  varying vec3 vDirection;
  ${CLOUD_DENSITY_GLSL}

  void main() {
    vec3 dir = normalize(vDirection);
    float altitude = max(0.33, dir.y + 0.40);
    vec2 uv = dir.xz / altitude * 0.27 +
      vec2(nhCloudWind * 0.13, nhCloudWind * 0.06);
    float cloud = nhCloudDensity(uv);
    if (cloud < 0.005) discard;
    vec3 detail = texture2D(nhCloudTexture, uv * 2.1 + 0.19).rgb;
    float sunlight = pow(max(dot(dir, normalize(nhCloudSun)), 0.0), 14.0);
    float daylight = smoothstep(-0.08, 0.32, nhCloudSun.y);
    float scattering = clamp(0.28 + detail.g * 0.68 + sunlight * 0.38, 0.0, 1.0);
    vec3 warm = mix(vec3(1.0, 0.68, 0.48), vec3(1.0, 0.99, 0.94), daylight);
    vec3 slate = mix(vec3(0.31, 0.37, 0.46), vec3(0.46, 0.52, 0.58), daylight);
    vec3 color = mix(slate, warm, scattering);
    color = mix(color, vec3(0.75, 0.77, 0.75), haze * 0.05);
    float horizon = smoothstep(-0.07, 0.25, dir.y);
    float opacity = cloud * horizon * 0.89;
    if (opacity < 0.005) discard;
    gl_FragColor = vec4(color, opacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export interface SkyLighting {
  sunColor: THREE.Color;
  sunIntensity: number;
  ambientSky: THREE.Color;
  ambientGround: THREE.Color;
  ambientIntensity: number;
  fogColor: THREE.Color;
  fogFar: number;
}

/** Sun, atmosphere, fog and ground share one coherent daylight model. */
export function skyLighting(settings: ViewSettings): SkyLighting {
  const elevation = THREE.MathUtils.clamp(settings.sunElevation, 0, 90);
  const daylight = THREE.MathUtils.smoothstep(elevation, 1, 55);
  const sunset = 1 - THREE.MathUtils.smoothstep(elevation, 5, 30);
  const haze = THREE.MathUtils.clamp((settings.skyTurbidity - 2) / 14, 0, 1);
  const overcast = THREE.MathUtils.clamp(settings.cloudCoverage, 0, 1);
  return {
    sunColor: new THREE.Color('#fff8ea').lerp(new THREE.Color('#ff965c'), sunset * 0.83),
    // Thick cloud cover dims direct sunlight while maintaining diffuse fill.
    sunIntensity: (0.70 + 1.60 * daylight) * (1 - haze * 0.20) * (1 - overcast * 0.46),
    ambientSky: new THREE.Color('#c5daef').lerp(new THREE.Color('#e7a98a'), sunset * 0.67)
      .lerp(new THREE.Color('#b8c0c5'), overcast * 0.48),
    ambientGround: new THREE.Color('#636b56').lerp(new THREE.Color('#665046'), sunset * 0.55),
    ambientIntensity: (0.42 + 0.64 * daylight) * (1 - haze * 0.12) * (1 + overcast * 0.12),
    // Match the bright physical sky near the horizon. A dark, unrelated fog
    // color makes an otherwise infinite meadow end in a hard green stripe.
    fogColor: new THREE.Color('#dce6eb').lerp(new THREE.Color('#e8c2ad'), sunset * 0.73)
      .lerp(new THREE.Color('#ced8dc'), overcast * 0.58)
      .lerp(new THREE.Color('#cbd2d2'), haze * 0.15),
    fogFar: settings.expandGround ? 21 : 17,
  };
}

export class Atmosphere {
  private readonly sky = new Sky();
  private readonly iblSky = new Sky();
  private readonly iblScene = new THREE.Scene();
  private readonly cloudNoise = generateCloudTexture();
  private readonly iblCloud: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private readonly shadowUniforms = {
    nhCloudTexture: { value: this.cloudNoise as THREE.Texture },
    nhCloudCoverage: { value: 0.42 },
    nhCloudWind: { value: 0 },
    nhCloudSun: { value: new THREE.Vector3() },
    nhCloudShadowStrength: { value: 0 },
  };
  private readonly attachedMaterials = new Map<THREE.MeshStandardMaterial, () => void>();
  private readonly pmrem: THREE.PMREMGenerator;
  private readonly cloudMaterial: THREE.ShaderMaterial;
  private readonly cloudMesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private readonly sunDirection = new THREE.Vector3();
  private environment: THREE.WebGLRenderTarget | null = null;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private probeKey = '';
  private enabled = false;

  constructor(
    private readonly scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    private readonly invalidate: () => void,
  ) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.sky.name = 'Physical atmosphere';
    this.sky.scale.setScalar(30);
    this.sky.renderOrder = -1000;
    this.sky.material.depthWrite = false;
    this.sky.visible = false;
    scene.add(this.sky);

    this.iblSky.scale.setScalar(55);
    this.iblSky.material.depthWrite = false;
    this.iblScene.add(this.iblSky);

    this.cloudMaterial = new THREE.ShaderMaterial({
      name: 'Volumetric-looking procedural cloud deck',
      vertexShader: cloudVertex,
      fragmentShader: cloudFragment,
      uniforms: {
        ...this.shadowUniforms,
        haze: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.BackSide,
      fog: false,
    });
    this.cloudMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), this.cloudMaterial);
    this.cloudMesh.name = 'Wind-driven cloud layer';
    this.cloudMesh.scale.setScalar(29);
    this.cloudMesh.renderOrder = -999;
    this.cloudMesh.visible = false;
    scene.add(this.cloudMesh);
    this.iblCloud = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), this.cloudMaterial);
    this.iblCloud.scale.setScalar(54);
    this.iblCloud.name = 'Cloud radiance preview';
    this.iblCloud.visible = false;
    this.iblScene.add(this.iblCloud);
  }

  apply(settings: ViewSettings) {
    this.enabled = settings.skyEnabled;
    this.sky.visible = this.enabled;
    this.cloudMesh.visible = this.enabled && settings.cloudCoverage > 0;
    // Exposure belongs to the camera; multiplying IBL by it as well would
    // square the slider's influence and wash out the PBR surface.
    // Three.js Sky emits an HDR radiance distribution. A full-strength
    // PMREM probe plus direct sunlight clips bright alpine rock under clear
    // skies; compensate with a daylight-dependent probe calibration. Keep
    // the exposure slider mapped only to camera tone mapping.
    const daylightFill = THREE.MathUtils.smoothstep(settings.sunElevation, 8, 65);
    this.scene.environmentIntensity = 0.26 + (1 - daylightFill) * 0.36 +
      settings.cloudCoverage * 0.08;
    this.iblCloud.visible = this.enabled && settings.cloudCoverage > 0;
    this.shadowUniforms.nhCloudCoverage.value = settings.cloudCoverage;
    const sunDaylight = THREE.MathUtils.smoothstep(settings.sunElevation, 4, 30);
    const brokenClouds = 1 - THREE.MathUtils.smoothstep(settings.cloudCoverage, 0.8, 1) * 0.6;
    this.shadowUniforms.nhCloudShadowStrength.value =
      settings.cloudShadowStrength * sunDaylight * brokenClouds *
      THREE.MathUtils.smoothstep(settings.cloudCoverage, 0.05, 0.65);
    this.cloudMaterial.uniforms.haze.value = (settings.skyTurbidity - 2) / 14;

    const azimuth = THREE.MathUtils.degToRad(settings.sunAzimuth);
    const elevation = THREE.MathUtils.degToRad(settings.sunElevation);
    this.sunDirection.set(
      Math.sin(azimuth) * Math.cos(elevation),
      Math.sin(elevation),
      Math.cos(azimuth) * Math.cos(elevation),
    );
    this.shadowUniforms.nhCloudSun.value.copy(this.sunDirection);
    for (const sky of [this.sky, this.iblSky]) {
      const u = sky.material.uniforms;
      u.sunPosition.value.copy(this.sunDirection);
      u.turbidity.value = settings.skyTurbidity;
      u.rayleigh.value = settings.skyRayleigh;
      u.mieCoefficient.value = 0.005 + settings.skyTurbidity * 0.00055;
      u.mieDirectionalG.value = 0.8;
    }

    const key = [
      settings.sunAzimuth, settings.sunElevation, settings.skyTurbidity, settings.skyRayleigh,
      Math.round(settings.cloudCoverage * 20) / 20,
    ].join('/');
    if (!this.enabled) {
      this.cancelProbe();
      this.scene.environment = null;
      this.environment?.dispose();
      this.environment = null;
      this.probeKey = '';
    } else if (key !== this.probeKey) {
      this.probeKey = key;
      this.cancelProbe();
      // A debounced probe avoids an expensive PMREM render for every slider
      // movement. Direct light, haze and the visible sky still respond instantly.
      this.probeTimer = setTimeout(() => {
        this.probeTimer = null;
        if (!this.enabled) return;
        try {
          const next = this.pmrem.fromScene(this.iblScene, 0, 0.1, 100);
          this.scene.environment = next.texture;
          this.environment?.dispose();
          this.environment = next;
          this.invalidate();
        } catch {
          // WebGL devices without a suitable IBL path keep direct and ambient
          // lighting rather than losing the entire terrain preview.
          this.scene.environment = null;
        }
      }, 180);
    }
    this.invalidate();
  }

  /** Cloud shadows alter only the direct sun term of physically-based materials. */
  attach(material: THREE.MeshStandardMaterial) {
    if (this.attachedMaterials.has(material)) return;
    this.attachedMaterials.set(material, wrapCloudShadows(material, this.shadowUniforms));
  }

  detach(material: THREE.MeshStandardMaterial) {
    this.attachedMaterials.get(material)?.();
    this.attachedMaterials.delete(material);
  }

  follow(camera: THREE.Camera) {
    if (!this.enabled) return;
    this.sky.position.copy(camera.position);
    this.cloudMesh.position.copy(camera.position);
  }

  tick(timeSeconds: number, settings: ViewSettings) {
    if (this.enabled && settings.cloudCoverage > 0 && settings.cloudSpeed > 0) {
      this.shadowUniforms.nhCloudWind.value = timeSeconds * settings.cloudSpeed * 0.017;
    }
  }

  private cancelProbe() {
    if (this.probeTimer !== null) clearTimeout(this.probeTimer);
    this.probeTimer = null;
  }

  dispose() {
    this.enabled = false;
    this.cancelProbe();
    this.scene.environment = null;
    this.environment?.dispose();
    this.environment = null;
    for (const remove of this.attachedMaterials.values()) remove();
    this.attachedMaterials.clear();
    this.scene.remove(this.sky, this.cloudMesh);
    this.iblScene.remove(this.iblSky, this.iblCloud);
    this.sky.geometry.dispose();
    this.sky.material.dispose();
    this.iblSky.geometry.dispose();
    this.iblSky.material.dispose();
    this.iblCloud.geometry.dispose();
    this.cloudNoise.dispose();
    this.cloudMesh.geometry.dispose();
    this.cloudMaterial.dispose();
    this.pmrem.dispose();
  }
}
