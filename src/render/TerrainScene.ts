import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { HeightField, TerrainProject, ViewSettings } from '../model/types';
import { sampleSlope, terrainColor } from './maps';

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
  private animation = 0;
  private disposed = false;
  private firstField = true;
  private contextLost = false;
  private needsRender = true;
  private contourUniform = { value: false };
  private spacingUniform = { value: 0.015 };
  private readonly onContextLost: (event: Event) => void;

  constructor(
    private readonly host: HTMLDivElement,
    settings: ViewSettings,
    onError: (message: string) => void,
  ) {
    this.settings = settings;
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor('#20292a');
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.setAttribute(
      'aria-label',
      'Interactive 3D terrain. Drag to orbit, right-drag to pan, and scroll to zoom.',
    );
    this.renderer.domElement.setAttribute('role', 'img');
    this.renderer.domElement.tabIndex = 0;
    host.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color('#20292a');
    this.scene.fog = new THREE.Fog('#20292a', 7, 15);

    const hemisphere = new THREE.HemisphereLight('#dce7f0', '#6e7560', 2.0);
    this.scene.add(hemisphere);
    this.sun = new THREE.DirectionalLight('#fff1d6', 3.0);
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
    this.sun.shadow.radius = 2;
    this.sun.target.position.set(0, 0.15, 0);
    this.scene.add(this.sun, this.sun.target);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 30),
      new THREE.MeshStandardMaterial({ color: '#293332', roughness: 1 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.048;
    floor.receiveShadow = true;
    this.scene.add(floor);
    const grid = new THREE.GridHelper(10.4, 40, '#46514b', '#35423e');
    grid.position.y = -0.045;
    const gridMaterial = grid.material as THREE.LineBasicMaterial;
    gridMaterial.transparent = true;
    gridMaterial.opacity = 0.42;
    this.scene.add(grid);

    const plinth = new THREE.Mesh(
      new THREE.BoxGeometry(TERRAIN_SIZE + 0.012, 0.035, TERRAIN_SIZE + 0.012),
      new THREE.MeshStandardMaterial({ color: '#333d34', roughness: 0.98 }),
    );
    plinth.position.y = -0.019;
    plinth.receiveShadow = true;
    plinth.castShadow = true;
    this.scene.add(plinth);

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

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.onContextLost = (event) => {
      event.preventDefault();
      this.contextLost = true;
      onError('The 3D graphics context was lost. Your heightmap is safe; switch to the 2D view.');
    };
    this.renderer.domElement.addEventListener('webglcontextlost', this.onContextLost);
    this.applySettings(settings);
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
    } else if (paletteChanged) this.updateColors();
    if (this.firstField) {
      this.firstField = false;
      this.resetCamera();
    }
  }

  applySettings(settings: ViewSettings) {
    const paletteChanged = this.settings.material !== settings.material;
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
    if (paletteChanged && this.terrain) this.updateColors();
    this.renderer.shadowMap.needsUpdate = true;
    this.needsRender = true;
  }

  private buildGeometry() {
    if (!this.field || !this.project) return;
    const { resolution: n, height } = this.field;
    const segments = Math.min(n - 1, 511);
    const geometry = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, segments, segments);
    geometry.rotateX(-Math.PI / 2);
    const positions = geometry.getAttribute('position');
    const scale = (TERRAIN_SIZE * this.project.heightScale) / this.project.worldSize;
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
        -0.002,
        az,
        bx,
        by,
        bz,
        bx,
        by,
        bz,
        ax,
        -0.002,
        az,
        bx,
        -0.002,
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
          Math.sin(px * 0.83 + py * 0.47),
        );
        color.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
      }
      colors.setXYZ(i, color.r, color.g, color.b);
    }
    colors.needsUpdate = true;
  }

  resetCamera() {
    let highest = 0.4;
    if (this.field && this.project) {
      let max = 0;
      for (const value of this.field.height) max = Math.max(max, value);
      highest =
        ((max * TERRAIN_SIZE * this.project.heightScale) / this.project.worldSize) *
        this.settings.exaggeration;
    }
    const aspect = this.camera.aspect;
    const distance = Math.max(3.55, aspect < 1.2 ? 4.4 : 3.6);
    this.controls.target.set(0, highest * 0.38, 0);
    this.camera.position.set(distance * 0.68, highest * 0.4 + distance * 0.54, distance * 0.75);
    this.camera.up.set(0, 1, 0);
    this.controls.update();
  }

  topView() {
    this.controls.target.set(0, 0.05, 0);
    this.camera.position.set(0, 5.4, 0.001);
    this.camera.up.set(0, 1, 0);
    this.controls.update();
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
