import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import type { ViewSettings } from '../model/types';

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
  uniform vec3 sunDirection;
  uniform float coverage;
  uniform float windTime;
  uniform float haze;
  varying vec3 vDirection;

  float hash(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
  }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0)), f.x), f.y);
  }
  float fbm(vec2 p) {
    float n = 0.0;
    n += noise(p) * 0.55;
    n += noise(p * 2.07 + 13.1) * 0.28;
    n += noise(p * 4.13 - 5.7) * 0.17;
    return n;
  }
  void main() {
    vec3 dir = normalize(vDirection);
    // Project a high, curved cloud deck into view space. The lower bound
    // tapers the cloud layer into the atmosphere near the horizon.
    float altitude = max(0.28, dir.y + 0.42);
    vec2 uv = dir.xz / altitude * 2.15 + vec2(windTime, windTime * 0.37);
    float large = fbm(uv * 0.78);
    float detail = fbm(uv * 2.3 + 8.0);
    float shape = large * 0.77 + detail * 0.23;
    float threshold = mix(0.82, 0.40, coverage);
    float density = smoothstep(threshold - 0.095, threshold + 0.10, shape);
    float horizon = smoothstep(-0.07, 0.22, dir.y);
    float opacity = density * horizon * 0.86;
    if (opacity < 0.003) discard;

    float facingSun = max(dot(dir, normalize(sunDirection)), 0.0);
    float silverLining = pow(facingSun, 12.0);
    float daylight = smoothstep(-0.06, 0.30, sunDirection.y);
    vec3 cool = vec3(0.39, 0.45, 0.51);
    vec3 bright = mix(vec3(1.0, 0.65, 0.40), vec3(0.99, 0.98, 0.94), daylight);
    float lighting = clamp(0.45 + 0.48 * detail + silverLining * 0.37, 0.0, 1.0);
    vec3 cloudColor = mix(cool, bright, lighting);
    cloudColor = mix(cloudColor, vec3(0.81, 0.77, 0.70), haze * 0.08);
    gl_FragColor = vec4(cloudColor, opacity);
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
  return {
    sunColor: new THREE.Color('#fff8ea').lerp(new THREE.Color('#ff965c'), sunset * 0.83),
    sunIntensity: (1.0 + 2.3 * daylight) * (1 - haze * 0.25),
    ambientSky: new THREE.Color('#c5daef').lerp(new THREE.Color('#e7a98a'), sunset * 0.67),
    ambientGround: new THREE.Color('#636b56').lerp(new THREE.Color('#665046'), sunset * 0.55),
    ambientIntensity: (0.75 + 1.5 * daylight) * (1 - haze * 0.17),
    fogColor: new THREE.Color('#b4cad9').lerp(new THREE.Color('#d6a787'), sunset * 0.64)
      .lerp(new THREE.Color('#c3c5bf'), haze * 0.34),
    fogFar: settings.expandGround ? 23 : 17,
  };
}

export class Atmosphere {
  private readonly sky = new Sky();
  private readonly iblSky = new Sky();
  private readonly iblScene = new THREE.Scene();
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
        sunDirection: { value: this.sunDirection },
        coverage: { value: 0.4 },
        windTime: { value: 0 },
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
  }

  apply(settings: ViewSettings) {
    this.enabled = settings.skyEnabled;
    this.sky.visible = this.enabled;
    this.cloudMesh.visible = this.enabled && settings.cloudCoverage > 0;
    this.scene.environmentIntensity = this.enabled ? settings.skyExposure : 1;
    this.cloudMaterial.uniforms.coverage.value = settings.cloudCoverage;
    this.cloudMaterial.uniforms.haze.value = (settings.skyTurbidity - 2) / 14;

    const azimuth = THREE.MathUtils.degToRad(settings.sunAzimuth);
    const elevation = THREE.MathUtils.degToRad(settings.sunElevation);
    this.sunDirection.set(
      Math.sin(azimuth) * Math.cos(elevation),
      Math.sin(elevation),
      Math.cos(azimuth) * Math.cos(elevation),
    );
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

  follow(camera: THREE.Camera) {
    if (!this.enabled) return;
    this.sky.position.copy(camera.position);
    this.cloudMesh.position.copy(camera.position);
  }

  tick(timeSeconds: number, settings: ViewSettings) {
    if (this.enabled && settings.cloudCoverage > 0 && settings.cloudSpeed > 0) {
      this.cloudMaterial.uniforms.windTime.value = timeSeconds * settings.cloudSpeed * 0.017;
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
    this.scene.remove(this.sky, this.cloudMesh);
    this.iblScene.remove(this.iblSky);
    this.sky.geometry.dispose();
    this.sky.material.dispose();
    this.iblSky.geometry.dispose();
    this.iblSky.material.dispose();
    this.cloudMesh.geometry.dispose();
    this.cloudMaterial.dispose();
    this.pmrem.dispose();
  }
}
