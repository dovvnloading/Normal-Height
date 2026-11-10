import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { HeightField, TerrainProject, ViewSettings } from '../model/types';
import { alpineMaterialVariation, sampleSlope, terrainColor } from './maps';
import { pbrPixels } from '../materials/pbr';
import { requestPBR } from '../materials/pbrClient';
import { sampleSpline } from '../model/splines';
import type { SplinePoint } from '../model/splines';
import { Atmosphere, skyLighting } from './Atmosphere';
import { GroundExtension, TERRAIN_SIZE } from './GroundExtension';

const clamp = (v: number) => Math.max(0, Math.min(1, v));

function bilinear(values: Float32Array, n: number, u: number, v: number) {
  const x = clamp(u) * (n - 1),
    y = clamp(v) * (n - 1);
  const ix = Math.floor(x),
    iy = Math.floor(y),
    nx = Math.min(n - 1, ix + 1),
    ny = Math.min(n - 1, iy + 1);
  const fx = x - ix,
    fy = y - iy;
  return (
    values[iy * n + ix] * (1 - fx) * (1 - fy) +
    values[iy * n + nx] * fx * (1 - fy) +
    values[ny * n + ix] * (1 - fx) * fy +
    values[ny * n + nx] * fx * fy
  );
}

export class TerrainScene {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(36, 1, 0.025, 40);
  private readonly controls: OrbitControls;
  private readonly resizeObserver: ResizeObserver;
  private readonly sun: THREE.DirectionalLight;
  private readonly hemisphere: THREE.HemisphereLight;
  private readonly atmosphere: Atmosphere;
  private readonly groundExtension: GroundExtension;
  private theme: 'light' | 'dark' = 'light';
  private readonly floor: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  private readonly grid: THREE.GridHelper;
  private readonly plinth: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  private readonly material: THREE.MeshStandardMaterial;
  private pbrTextures: THREE.DataTexture[] = [];
  private lastPBRField: HeightField | null = null;
  private lastPBRSurface = '';
  private pbrRelease: (() => void) | null = null;
  private pbrGeneration = 0;
  private readonly skirtMaterial = new THREE.MeshStandardMaterial({
    color: '#5b6054',
    roughness: 1,
    side: THREE.DoubleSide,
  });
  private terrain: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null = null;
  private skirt: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null = null;
  private field: HeightField | null = null;
  private project: TerrainProject | null = null;
  private settings: ViewSettings;
  private minimumElevation = 0;
  private animation = 0;
  private disposed = false;
  private firstField = true;
  private cameraAdjusted = false;
  private cameraView: 'perspective' | 'top' = 'perspective';
  private contextLost = false;
  private needsRender = true;
  private lastWeatherFrame = 0;
  private contourUniform = { value: false };
  private spacingUniform = { value: 0.015 };
  private splinePath: readonly SplinePoint[] | null = null;
  private splineMode: 'river' | 'ridge' = 'river';
  private splineGuide: THREE.Group | null = null;
  private readonly onContextLost: (event: Event) => void;

  constructor(
    private readonly host: HTMLDivElement,
    settings: ViewSettings,
    private readonly onError: (message: string) => void,
    theme: 'light' | 'dark' = 'light',
  ) {
    this.settings = settings;
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor('#cbd2cf');
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.domElement.setAttribute(
      'aria-label',
      'Interactive 3D terrain. Drag to orbit, right-drag to pan, and scroll to zoom.',
    );
    this.renderer.domElement.setAttribute('role', 'img');
    this.renderer.domElement.tabIndex = 0;
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.dataset.materialStatus = 'inactive';
    this.scene.background = new THREE.Color('#cbd2cf');
    this.scene.fog = new THREE.Fog('#cbd2cf', 7, 15);

    this.hemisphere = new THREE.HemisphereLight('#dbe7ee', '#777b6f', 2.35);
    this.scene.add(this.hemisphere);
    this.sun = new THREE.DirectionalLight('#fff7e9', 2.55);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, {
      left: -2.5,
      right: 2.5,
      top: 2.5,
      bottom: -2.5,
      near: 0.2,
      far: 12,
    });
    this.sun.shadow.bias = -0.00015;
    this.sun.shadow.normalBias = 0.009;
    this.sun.shadow.radius = 2.4;
    this.sun.shadow.intensity = 0.68;
    this.sun.target.position.set(0, 0.15, 0);
    this.scene.add(this.sun, this.sun.target);
    this.atmosphere = new Atmosphere(this.scene, this.renderer, () => { this.needsRender = true; });
    this.groundExtension = new GroundExtension(this.scene, this.renderer);

    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 30),
      new THREE.MeshStandardMaterial({ color: '#b3bdb7', roughness: 1 }),
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = -0.048;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);
    this.grid = new THREE.GridHelper(10.4, 40, '#909f96', '#a7b2aa');
    this.grid.position.y = -0.045;
    const gridMaterial = this.grid.material as THREE.LineBasicMaterial;
    gridMaterial.transparent = true;
    gridMaterial.opacity = 0.42;
    this.scene.add(this.grid);

    this.plinth = new THREE.Mesh(
      new THREE.BoxGeometry(TERRAIN_SIZE + 0.012, 0.035, TERRAIN_SIZE + 0.012),
      new THREE.MeshStandardMaterial({ color: '#8f9b92', roughness: 0.98 }),
    );
    this.plinth.position.y = -0.019;
    this.plinth.receiveShadow = true;
    this.plinth.castShadow = true;
    this.scene.add(this.plinth);

    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.94,
      metalness: 0,
      side: THREE.FrontSide,
    });
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.nhContours = this.contourUniform;
      shader.uniforms.nhSpacing = this.spacingUniform;
      shader.vertexShader = 'varying vec3 vNHPosition;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvNHPosition = position;',
      );
      shader.fragmentShader =
        'varying vec3 vNHPosition;\nuniform bool nhContours;\nuniform float nhSpacing;\n' +
        shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        if (nhContours) {
          float h = vNHPosition.y / nhSpacing;
          float dist = abs(fract(h - 0.5) - 0.5);
          float line = 1.0 - smoothstep(0.0, max(fwidth(h) * 1.05, 0.012), dist);
          diffuseColor.rgb *= 1.0 - line * 0.46;
        }`,
      );
    };

    this.camera.position.set(3.25, 2.4, 3.55);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.2, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.55;
    this.controls.maxDistance = 12;
    this.controls.maxPolarAngle = Math.PI * 0.485;
    this.controls.autoRotateSpeed = 0.65;
    this.controls.enablePan = true;
    this.controls.screenSpacePanning = true;
    this.controls.update();
    this.controls.addEventListener('change', () => {
      this.needsRender = true;
    });
    this.controls.addEventListener('start', () => {
      this.cameraAdjusted = true;
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.onContextLost = (event) => {
      event.preventDefault();
      this.contextLost = true;
      onError('The 3D graphics context was lost. Your heightmap is safe; switch to the 2D view.');
    };
    this.renderer.domElement.addEventListener('webglcontextlost', this.onContextLost);
    this.applySettings(settings);
    this.applyTheme(theme);
    this.resize();
    this.animate();
  }

  private resize() {
    if (this.disposed) return;
    const width = this.host.clientWidth,
      height = this.host.clientHeight;
    if (width < 1 || height < 1) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    // Keep the default and reset views fitted when the dock changes size, while
    // retaining an artist's orbit, pan, or zoom once they have adjusted it.
    if (this.terrain && !this.cameraAdjusted) this.fitCamera();
    this.needsRender = true;
  }

  private animate = () => {
    if (this.disposed || this.contextLost) return;
    this.animation = requestAnimationFrame(this.animate);
    if (!this.host.clientWidth || !this.host.clientHeight || document.hidden) return;
    this.controls.update();
    const seconds = performance.now() / 1000;
    this.atmosphere.follow(this.camera);
    this.atmosphere.tick(seconds, this.settings);
    this.groundExtension.tick(seconds, this.settings.cloudSpeed);
    const weatherMoves = this.settings.cloudSpeed > 0 && (
      (this.settings.skyEnabled && this.settings.cloudCoverage > 0) ||
      (this.settings.expandGround && this.settings.grassDensity > 0)
    );
    // Weather runs at 24 FPS; the camera, UI edits and snapshots still render
    // immediately. Avoid saturating the GPU for a slowly drifting cloud deck.
    const weatherFrame = weatherMoves && seconds - this.lastWeatherFrame >= 1 / 24;
    if (this.needsRender || this.controls.autoRotate || weatherFrame) {
      if (weatherFrame) this.lastWeatherFrame = seconds;
      this.renderer.render(this.scene, this.camera);
      this.needsRender = false;
    }
  };

  update(field: HeightField, project: TerrainProject, settings: ViewSettings) {
    const previousBase = this.minimumElevation * this.settings.exaggeration;
    const geometryChanged =
      this.field !== field ||
      this.project?.worldSize !== project.worldSize ||
      this.project?.heightScale !== project.heightScale;
    const paletteChanged = this.settings.material !== settings.material;
    const surfaceChanged = JSON.stringify(this.project?.surface ?? null) !==
      JSON.stringify(project.surface ?? null) || this.project?.seed !== project.seed;
    this.field = field;
    this.project = project;
    if (settings !== this.settings) this.applySettings(settings);
    if (geometryChanged) {
      this.buildGeometry();
      this.rebuildSplineGuide();
      this.renderer.shadowMap.needsUpdate = true;
      this.needsRender = true;
      if (!this.cameraAdjusted && previousBase !== this.minimumElevation * settings.exaggeration)
        this.fitCamera();
    } else if (paletteChanged || surfaceChanged) {
      if (paletteChanged) this.updateColors();
      this.updatePBRTextures();
    }
    if (this.firstField) {
      this.firstField = false;
      this.resetCamera();
    }
  }

  /** Guide the authored path along the current rendered terrain in 3D. */
  setSplineGuide(path: readonly SplinePoint[] | null, mode: 'river' | 'ridge' = 'river') {
    this.splinePath = path;
    this.splineMode = mode;
    this.rebuildSplineGuide();
  }

  private rebuildSplineGuide() {
    if (this.splineGuide) {
      this.scene.remove(this.splineGuide);
      this.splineGuide.traverse((object) => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose();
        if (Array.isArray(mesh.material)) mesh.material.forEach((material) => material.dispose());
        else mesh.material?.dispose();
      });
      this.splineGuide = null;
    }
    if (!this.field || !this.project || !this.splinePath || this.splinePath.length < 2) return;
    const group = new THREE.Group();
    group.name = 'Editable spline guide';
    const n = this.field.resolution;
    const scale = (TERRAIN_SIZE * this.project.heightScale) / this.project.worldSize;
    const pointAt = (p: SplinePoint) => new THREE.Vector3(
      (p.x - 0.5) * TERRAIN_SIZE,
      bilinear(this.field!.height, n, p.x, p.y) * scale * this.settings.exaggeration + 0.024,
      (p.y - 0.5) * TERRAIN_SIZE,
    );
    const color = this.splineMode === 'ridge' ? '#e9bc7f' : '#76c8d7';
    const curve = sampleSpline(this.splinePath, 30).map(pointAt);
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(curve),
      new THREE.LineBasicMaterial({ color, linewidth: 2, depthTest: true, transparent: true, opacity: 0.96 }),
    );
    line.name = 'Spline centerline';
    group.add(line);
    for (const [index, point] of this.splinePath.entries()) {
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(index === 0 ? 0.022 : 0.015, 9, 7),
        new THREE.MeshBasicMaterial({ color: index === 0 ? '#faf9ed' : color, depthTest: true }),
      );
      marker.name = `Spline control point ${index + 1}`;
      marker.position.copy(pointAt(point));
      group.add(marker);
    }
    this.splineGuide = group;
    this.scene.add(group);
    this.needsRender = true;
  }

  /** The scene's chrome adapts instantly; terrain geometry and data are untouched. */
  applyTheme(theme: 'light' | 'dark') {
    const background = theme === 'dark' ? '#292e30' : '#cbd2cf';
    this.renderer.setClearColor(background);
    this.theme = theme;
    this.updateEnvironmentLighting();
    this.floor.material.color.set(theme === 'dark' ? '#303839' : '#b3bdb7');
    this.plinth.material.color.set(theme === 'dark' ? '#414944' : '#8f9b92');
    this.skirtMaterial.color.set(theme === 'dark' ? '#515b52' : '#5b6054');
    // GridHelper uses vertex colors in this Three.js version. Dim the grid's
    // shared material instead of trying to call a non-existent setColors API.
    (this.grid.material as THREE.LineBasicMaterial).opacity = theme === 'dark' ? 0.24 : 0.42;
    this.needsRender = true;
  }

  private updateEnvironmentLighting() {
    const background = this.theme === 'dark' ? '#292e30' : '#cbd2cf';
    if (this.settings.skyEnabled) {
      const lighting = skyLighting(this.settings);
      this.sun.color.copy(lighting.sunColor);
      this.sun.intensity = lighting.sunIntensity;
      this.hemisphere.color.copy(lighting.ambientSky);
      this.hemisphere.groundColor.copy(lighting.ambientGround);
      this.hemisphere.intensity = lighting.ambientIntensity;
      this.scene.background = null; // let the physical dome fill the sky
      this.scene.fog = new THREE.Fog(lighting.fogColor, 6, lighting.fogFar);
      this.renderer.toneMappingExposure = 1.08 * this.settings.skyExposure;
    } else {
      this.sun.color.set('#fff7e9');
      this.sun.intensity = 2.55;
      this.hemisphere.color.set('#dbe7ee');
      this.hemisphere.groundColor.set('#777b6f');
      this.hemisphere.intensity = 2.35;
      this.scene.background = new THREE.Color(background);
      this.scene.fog = new THREE.Fog(background, 7, 15);
      this.renderer.toneMappingExposure = 1.08;
    }
    this.needsRender = true;
  }

  applySettings(settings: ViewSettings) {
    const paletteChanged = this.settings.material !== settings.material;
    const scaleChanged = this.settings.exaggeration !== settings.exaggeration;
    this.settings = settings;
    const azimuth = (settings.sunAzimuth * Math.PI) / 180;
    const elevation = (settings.sunElevation * Math.PI) / 180;
    this.sun.position.set(
      Math.sin(azimuth) * Math.cos(elevation) * 5,
      Math.sin(elevation) * 5,
      Math.cos(azimuth) * Math.cos(elevation) * 5,
    );
    this.contourUniform.value = settings.contours;
    this.material.wireframe = settings.wireframe;
    this.controls.autoRotate = settings.autoRotate;
    this.atmosphere.apply(settings);
    this.updateEnvironmentLighting();
    if (this.terrain) this.terrain.scale.y = settings.exaggeration;
    if (this.skirt) this.skirt.scale.y = settings.exaggeration;
    this.updateSupport();
    this.groundExtension.update(this.field, this.project, settings, this.minimumElevation);
    if (paletteChanged && this.terrain) {
      this.updateColors();
      this.updatePBRTextures();
    }
    if (scaleChanged && this.terrain) this.rebuildSplineGuide();
    if (scaleChanged && this.terrain && !this.cameraAdjusted) this.fitCamera();
    this.renderer.shadowMap.needsUpdate = true;
    this.needsRender = true;
  }

  private updateSupport() {
    // The scene support must sit below the data, including valid elevations
    // below zero. Preserve absolute terrain coordinates and physical normals.
    const exaggeration = this.settings.exaggeration;
    const base = this.minimumElevation * exaggeration;
    this.floor.position.y = base - 0.048;
    this.grid.position.y = base - 0.045;
    this.plinth.position.y = base - 0.019;
    this.floor.visible = !this.settings.expandGround;
    this.grid.visible = !this.settings.expandGround;
    this.plinth.visible = !this.settings.expandGround;
    if (this.skirt) this.skirt.visible = !this.settings.expandGround;
    this.sun.target.position.y = base + 0.15;
    this.sun.position.y = Math.sin(THREE.MathUtils.degToRad(this.settings.sunElevation)) * 5 + base;
    if (this.skirt) {
      const positions = this.skirt.geometry.getAttribute('position');
      const bottom = (base - 0.002) / exaggeration;
      // Each side consists of two triangles; these three vertices form its base.
      for (let i = 0; i < positions.count; i += 6) {
        positions.setY(i + 1, bottom);
        positions.setY(i + 4, bottom);
        positions.setY(i + 5, bottom);
      }
      positions.needsUpdate = true;
      this.skirt.geometry.computeBoundingSphere();
    }
  }

  private buildGeometry() {
    if (!this.field || !this.project) return;
    const { resolution: n, height } = this.field;
    const segments = Math.min(n - 1, 511);
    const geometry = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, segments, segments);
    geometry.rotateX(-Math.PI / 2);
    const positions = geometry.getAttribute('position');
    const scale = (TERRAIN_SIZE * this.project.heightScale) / this.project.worldSize;
    this.minimumElevation = 0;
    for (const value of height)
      this.minimumElevation = Math.min(this.minimumElevation, value * scale);
    for (let y = 0; y <= segments; y++)
      for (let x = 0; x <= segments; x++) {
        positions.setY(
          y * (segments + 1) + x,
          bilinear(height, n, x / segments, y / segments) * scale,
        );
      }
    geometry.setAttribute(
      'color',
      new THREE.BufferAttribute(new Float32Array(positions.count * 3), 3),
    );
    geometry.computeVertexNormals();
    // Required by material AO shaders in viewers that sample a second UV set.
    geometry.setAttribute('uv2', geometry.getAttribute('uv').clone());
    geometry.computeBoundingSphere();
    if (this.terrain) {
      this.scene.remove(this.terrain);
      this.terrain.geometry.dispose();
    }
    this.terrain = new THREE.Mesh(geometry, this.material);
    this.terrain.receiveShadow = true;
    this.terrain.castShadow = true;
    this.terrain.scale.y = this.settings.exaggeration;
    this.scene.add(this.terrain);
    this.spacingUniform.value = Math.max(0.001, (TERRAIN_SIZE * 100) / this.project.worldSize);
    this.updateColors();
    this.updatePBRTextures();

    const boundary: number[] = [];
    for (let x = 0; x <= segments; x++) boundary.push(x);
    for (let y = 1; y <= segments; y++) boundary.push(y * (segments + 1) + segments);
    for (let x = segments - 1; x >= 0; x--) boundary.push(segments * (segments + 1) + x);
    for (let y = segments - 1; y > 0; y--) boundary.push(y * (segments + 1));
    const skirtVertices: number[] = [];
    const skirtBottom = this.minimumElevation - 0.002 / this.settings.exaggeration;
    for (let i = 0; i < boundary.length; i++) {
      const a = boundary[i],
        b = boundary[(i + 1) % boundary.length];
      const ax = positions.getX(a),
        ay = positions.getY(a),
        az = positions.getZ(a);
      const bx = positions.getX(b),
        by = positions.getY(b),
        bz = positions.getZ(b);
      skirtVertices.push(
        ax,
        ay,
        az,
        ax,
        skirtBottom,
        az,
        bx,
        by,
        bz,
        bx,
        by,
        bz,
        ax,
        skirtBottom,
        az,
        bx,
        skirtBottom,
        bz,
      );
    }
    const skirtGeometry = new THREE.BufferGeometry();
    skirtGeometry.setAttribute('position', new THREE.Float32BufferAttribute(skirtVertices, 3));
    skirtGeometry.computeVertexNormals();
    if (this.skirt) {
      this.scene.remove(this.skirt);
      this.skirt.geometry.dispose();
    }
    this.skirt = new THREE.Mesh(skirtGeometry, this.skirtMaterial);
    this.skirt.scale.y = this.settings.exaggeration;
    this.skirt.castShadow = true;
    this.skirt.receiveShadow = true;
    this.scene.add(this.skirt);
    this.updateSupport();
    this.groundExtension.update(this.field, this.project, this.settings, this.minimumElevation);
  }

  private updateColors() {
    if (!this.terrain || !this.field || !this.project || this.settings.material === 'pbr') return;
    const geometry = this.terrain.geometry;
    const colors = geometry.getAttribute('color');
    const positions = geometry.getAttribute('position');
    const normals = geometry.getAttribute('normal');
    const n = this.field.resolution;
    let min = Infinity,
      max = -Infinity;
    for (const value of this.field.height) {
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    const heightUnits = (TERRAIN_SIZE * this.project.heightScale) / this.project.worldSize;
    const color = new THREE.Color();
    for (let i = 0; i < positions.count; i++) {
      const h = positions.getY(i) / heightUnits;
      const elevation = (h - min) / Math.max(0.0001, max - min);
      const px = Math.round((positions.getX(i) / TERRAIN_SIZE + 0.5) * (n - 1));
      const py = Math.round((positions.getZ(i) / TERRAIN_SIZE + 0.5) * (n - 1));
      if (this.settings.material === 'clay') {
        color.setRGB(0.61, 0.64, 0.56, THREE.SRGBColorSpace);
      } else if (this.settings.material === 'height') {
        const t = clamp(h);
        color.setRGB(t, t, t, THREE.SRGBColorSpace);
      } else {
        const physicalSlope = sampleSlope(
          this.field,
          Math.max(0, Math.min(n - 1, px)),
          Math.max(0, Math.min(n - 1, py)),
          this.project.worldSize,
          this.project.heightScale,
        );
        const rgb = terrainColor(
          elevation,
          (physicalSlope.up + normals.getY(i)) * 0.5,
          alpineMaterialVariation(
            positions.getX(i) / TERRAIN_SIZE + 0.5,
            positions.getZ(i) / TERRAIN_SIZE + 0.5,
          ),
        );
        color.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
      }
      colors.setXYZ(i, color.r, color.g, color.b);
    }
    colors.needsUpdate = true;
  }

  /** Off-thread material synthesis is shared with 2D and never reruns erosion. */
  private updatePBRTextures() {
    if (!this.field || !this.project) return;
    if (this.settings.material !== 'pbr') {
      this.renderer.domElement.dataset.materialStatus = 'inactive';
      ++this.pbrGeneration;
      this.pbrRelease?.();
      this.pbrRelease = null;
      const hadTextures = this.pbrTextures.length > 0;
      this.pbrTextures.forEach((texture) => texture.dispose());
      this.pbrTextures = [];
      this.lastPBRField = null;
      this.lastPBRSurface = '';
      if (hadTextures) {
        this.material.map = null;
        this.material.normalMap = null;
        this.material.roughnessMap = null;
        this.material.aoMap = null;
        this.material.vertexColors = true;
        this.material.roughness = 0.94;
        this.material.needsUpdate = true;
      }
      this.needsRender = true;
      return;
    }
    const field = this.field, project = this.project;
    const surfaceKey = JSON.stringify([
      project.seed, project.surface ?? null, project.worldSize, project.heightScale,
    ]);
    if (this.lastPBRField === field && this.lastPBRSurface === surfaceKey) return;
    this.pbrRelease?.();
    const generation = ++this.pbrGeneration;
    this.lastPBRField = field;
    this.lastPBRSurface = surfaceKey;
    this.renderer.domElement.dataset.materialStatus = 'loading';
    const request = requestPBR(field, project);
    this.pbrRelease = request.release;
    request.promise.then((maps) => {
      if (this.disposed || generation !== this.pbrGeneration ||
          this.field !== field || this.settings.material !== 'pbr') return;
      this.pbrRelease?.();
      this.pbrRelease = null;
      const n = maps.resolution;
      const texture = (rgba: Uint8ClampedArray, srgb = false): THREE.DataTexture => {
        // A Uint8 view avoids copying the synthesized map yet another time.
        const data = new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
        const result = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
        result.flipY = true; // row 0 north; matches plane geometry v=1
        result.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        result.generateMipmaps = true;
        result.minFilter = THREE.LinearMipmapLinearFilter;
        result.magFilter = THREE.LinearFilter;
        result.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
        result.needsUpdate = true;
        return result;
      };
      const albedo = texture(maps.basecolor, true);
      const roughness = texture(pbrPixels(maps, field, project, 'roughness'));
      const occlusion = texture(pbrPixels(maps, field, project, 'ao'));
      // Geometric normals already hold the macro terrain slopes.
      const microNormal = texture(pbrPixels(maps, field, project, 'detailNormal'));
      this.pbrTextures.forEach((old) => old.dispose());
      this.pbrTextures = [albedo, roughness, occlusion, microNormal];
      this.material.map = albedo;
      this.material.normalMap = microNormal;
      this.material.roughnessMap = roughness;
      this.material.aoMap = occlusion;
      this.material.aoMapIntensity = 0.85;
      this.material.color.set('#ffffff');
      this.material.normalScale.set(1, 1);
      this.material.vertexColors = false;
      this.material.roughness = 1;
      this.material.metalness = 0;
      this.material.needsUpdate = true;
      this.renderer.domElement.dataset.materialStatus = 'ready';
      this.needsRender = true;
    }).catch((error: Error) => {
      if (this.disposed || generation !== this.pbrGeneration) return;
      this.pbrRelease?.();
      this.pbrRelease = null;
      this.lastPBRField = null;
      this.lastPBRSurface = '';
      this.renderer.domElement.dataset.materialStatus = 'error';
      this.onError(error.message || 'Could not generate PBR materials.');
    });
  }

  private fitCamera() {
    const positions = this.terrain?.geometry.getAttribute('position');
    if (!positions) return;
    const exaggeration = this.settings.exaggeration;
    let highest = -Infinity;
    for (let i = 0; i < positions.count; i++)
      highest = Math.max(highest, positions.getY(i) * exaggeration);
    const base = this.minimumElevation * exaggeration;
    const target = new THREE.Vector3(
      0,
      base + (highest - base) * (this.cameraView === 'top' ? 0.35 : 0.3),
      0,
    );
    const direction =
      this.cameraView === 'top'
        ? new THREE.Vector3(0, 1, 0.0001).normalize()
        : new THREE.Vector3(0.84, 0.74, 1).normalize();
    const right = new THREE.Vector3()
      .crossVectors(new THREE.Vector3(0, 1, 0), direction)
      .normalize();
    const up = new THREE.Vector3().crossVectors(direction, right).normalize();
    const tanVertical = Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5));
    const tanHorizontal = tanVertical * this.camera.aspect;
    // Reserve room for source, navigation, and map status controls. These margins
    // are in screen pixels, so portrait and split panes remain fully framed.
    const widthFraction = Math.max(0.55, 1 - 60 / Math.max(1, this.host.clientWidth));
    const heightFraction = Math.max(0.55, 1 - 100 / Math.max(1, this.host.clientHeight));
    const offset = new THREE.Vector3();
    let distance = 1;
    const include = (x: number, y: number, z: number) => {
      offset.set(x, y, z).sub(target);
      const depth = offset.dot(direction);
      distance = Math.max(
        distance,
        depth + Math.abs(offset.dot(right)) / (tanHorizontal * widthFraction),
        depth + Math.abs(offset.dot(up)) / (tanVertical * heightFraction),
      );
    };
    for (let i = 0; i < positions.count; i++) {
      include(positions.getX(i), positions.getY(i) * exaggeration, positions.getZ(i));
    }
    const half = TERRAIN_SIZE * 0.5 + 0.006;
    for (const x of [-half, half]) for (const z of [-half, half]) include(x, base - 0.04, z);
    this.controls.target.copy(target);
    this.camera.position.copy(target).addScaledVector(direction, distance * 1.015);
    this.camera.up.set(0, 1, 0);
    this.camera.far = Math.max(40, distance + highest - base + TERRAIN_SIZE * 3);
    this.camera.updateProjectionMatrix();
    this.controls.maxDistance = Math.max(12, distance * 2);
    this.controls.update();
    this.needsRender = true;
  }

  resetCamera() {
    this.cameraAdjusted = false;
    this.cameraView = 'perspective';
    this.fitCamera();
  }

  topView() {
    this.cameraAdjusted = false;
    this.cameraView = 'top';
    this.fitCamera();
  }

  downloadSnapshot(name: string) {
    this.renderer.render(this.scene, this.camera);
    this.renderer.domElement.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${name.replace(/[^a-z0-9-_]/gi, '-').toLowerCase()}-preview.png`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  }

  dispose() {
    this.disposed = true;
    ++this.pbrGeneration;
    this.pbrRelease?.();
    this.pbrRelease = null;
    this.pbrTextures.forEach(texture => texture.dispose());
    this.pbrTextures = [];
    cancelAnimationFrame(this.animation);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.atmosphere.dispose();
    this.groundExtension.dispose();
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost);
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
      else mesh.material?.dispose();
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
