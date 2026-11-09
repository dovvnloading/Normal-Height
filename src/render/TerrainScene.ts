import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { HeightField, TerrainProject, ViewSettings } from '../model/types';
import { alpineMaterialVariation, sampleSlope, terrainColor } from './maps';

const TERRAIN_SIZE = 2.6;
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
  private readonly floor: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  private readonly grid: THREE.GridHelper;
  private readonly plinth: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  private readonly material: THREE.MeshStandardMaterial;
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
  private contourUniform = { value: false };
  private spacingUniform = { value: 0.015 };
  private readonly onContextLost: (event: Event) => void;

  constructor(
    private readonly host: HTMLDivElement,
    settings: ViewSettings,
    onError: (message: string) => void,
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
    this.scene.background = new THREE.Color('#cbd2cf');
    this.scene.fog = new THREE.Fog('#cbd2cf', 7, 15);

    const hemisphere = new THREE.HemisphereLight('#dbe7ee', '#777b6f', 2.35);
    this.scene.add(hemisphere);
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
    if (this.needsRender || this.controls.autoRotate) {
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
    this.field = field;
    this.project = project;
    if (settings !== this.settings) this.applySettings(settings);
    if (geometryChanged) {
      this.buildGeometry();
      this.renderer.shadowMap.needsUpdate = true;
      this.needsRender = true;
      if (!this.cameraAdjusted && previousBase !== this.minimumElevation * settings.exaggeration)
        this.fitCamera();
    } else if (paletteChanged) this.updateColors();
    if (this.firstField) {
      this.firstField = false;
      this.resetCamera();
    }
  }

  /** The scene's chrome adapts instantly; terrain geometry and data are untouched. */
  applyTheme(theme: 'light' | 'dark') {
    const background = theme === 'dark' ? '#292e30' : '#cbd2cf';
    this.renderer.setClearColor(background);
    (this.scene.background as THREE.Color).set(background);
    if (this.scene.fog instanceof THREE.Fog) this.scene.fog.color.set(background);
    this.floor.material.color.set(theme === 'dark' ? '#303839' : '#b3bdb7');
    this.plinth.material.color.set(theme === 'dark' ? '#414944' : '#8f9b92');
    this.skirtMaterial.color.set(theme === 'dark' ? '#515b52' : '#5b6054');
    this.grid.setColors(
      theme === 'dark' ? '#596862' : '#909f96',
      theme === 'dark' ? '#3d4c49' : '#a7b2aa',
    );
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
    if (this.terrain) this.terrain.scale.y = settings.exaggeration;
    if (this.skirt) this.skirt.scale.y = settings.exaggeration;
    this.updateSupport();
    if (paletteChanged && this.terrain) this.updateColors();
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
  }

  private updateColors() {
    if (!this.terrain || !this.field || !this.project) return;
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
    cancelAnimationFrame(this.animation);
    this.resizeObserver.disconnect();
    this.controls.dispose();
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
