import {
  AmbientLight,
  Box3,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  GridHelper,
  Group,
  LineBasicMaterial,
  LineLoop,
  LinearFilter,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { applyPackedPBRMaterial } from '../../render/pbrMaterial';
import { updatePreviewTexture } from '../../render/pbrTexture';
import type { WorldMaterialPreview } from '../../materials/worldMaterialPreview';
import { terrainAspectResize, terrainAspectScale } from './worldTerrainCamera';
import { buildWorldTerrainMesh } from './worldTerrainMesh';
import { clamp, worldGridBounds, worldMapPixels } from './worldViewMath';
import type { WorldLayer, WorldLayerScale, WorldRegion, WorldSnapshot } from './worldViewMath';

let sceneId = 0;

export interface WorldTerrainSettings {
  exaggeration: number;
  wireframe: boolean;
  sun: number;
  orthographic: boolean;
}
export interface WorldTerrainCameraState {
  footprint: string;
  position: [number, number, number];
  target: [number, number, number];
  zoom: number;
  aspect: number;
}

/** Owns one visible WebGL context. Field/material updates replace bounded GPU
 * resources without resetting camera, lighting, controls or the renderer. */
export class WorldTerrainScene {
  readonly renderer: WebGLRenderer;
  private scene = new Scene();
  private group = new Group();
  private material = new MeshStandardMaterial({ roughness: 0.94, metalness: 0, side: DoubleSide });
  private mesh = new Mesh(new BufferGeometry(), this.material);
  private wallMaterial = new MeshStandardMaterial({
    color: 0x5e6a60,
    roughness: 1,
    side: DoubleSide,
  });
  private walls = new Mesh(new BufferGeometry(), this.wallMaterial);
  private floor = new GridHelper(2.4, 24, 0x5e756c, 0x495c54);
  private outline = new LineLoop(
    new BufferGeometry(),
    new LineBasicMaterial({ color: 0xc9efbd, transparent: true, opacity: 0.8 }),
  );
  private key = new DirectionalLight(0xfff6dc, 2.6);
  private perspective = new PerspectiveCamera(39, 1, 0.005, 2000);
  private ortho = new OrthographicCamera(-1, 1, 1, -1, 0.005, 2000);
  private camera: PerspectiveCamera | OrthographicCamera;
  private controls: OrbitControls;
  private observer: ResizeObserver;
  private viewportAspect = 1;
  private frame = 0;
  private disposed = false;
  private lost = false;
  private snapshot?: WorldSnapshot;
  private geometry?: ReturnType<typeof buildWorldTerrainMesh>;
  private diagnosticTexture?: CanvasTexture;
  private materialTextures: DataTexture[] = [];
  private hasMaterial = false;
  private materialEnabled = false;
  private layer: WorldLayer = 'relief';
  private scale: WorldLayerScale = { min: 0, max: 1, flow: 0, wear: 0, deposition: 0 };
  private region: WorldRegion | null = null;
  private updates = 0;
  private materialUploads = 0;
  private savedCamera: WorldTerrainCameraState | null;

  constructor(
    private readonly host: HTMLElement,
    settings: WorldTerrainSettings,
    private readonly onError: (message: string) => void,
    savedCamera: WorldTerrainCameraState | null = null,
  ) {
    this.savedCamera = savedCamera;
    this.renderer = new WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'low-power',
    });
    try {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
      this.renderer.outputColorSpace = SRGBColorSpace;
      this.renderer.setClearColor(0x000000, 0);
      const canvas = this.renderer.domElement;
      canvas.setAttribute('aria-label', 'Three-dimensional sampled world terrain');
      canvas.setAttribute('role', 'img');
      canvas.tabIndex = -1;
      canvas.dataset.sceneId = String(++sceneId);
      canvas.dataset.materialState = 'off';
      canvas.addEventListener('webglcontextlost', this.contextLost);
      host.appendChild(canvas);
      this.viewportAspect =
        host.clientWidth > 0 && host.clientHeight > 0 ? host.clientWidth / host.clientHeight : 1;
      this.camera = settings.orthographic ? this.ortho : this.perspective;
      this.controls = new OrbitControls(this.camera, canvas);
      this.controls.enableDamping = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.controls.dampingFactor = 0.12;
      this.controls.minDistance = 0.08;
      this.controls.maxDistance = 1000;
      this.controls.minZoom = 0.2;
      this.controls.maxZoom = 24;
      this.controls.maxPolarAngle = Math.PI * 0.49;
      this.controls.screenSpacePanning = true;
      this.controls.addEventListener('change', this.requestRender);
      this.group.add(this.mesh, this.walls, this.outline);
      this.scene.add(this.group, this.floor, new AmbientLight(0xffffff, 1.65), this.key);
      const fill = new DirectionalLight(0xc8dfef, 0.65);
      fill.position.set(1, 0.5, 1);
      this.scene.add(fill);
      this.floor.position.y = -0.027;
      for (const material of Array.isArray(this.floor.material)
        ? this.floor.material
        : [this.floor.material]) {
        material.transparent = true;
        material.opacity = 0.2;
      }
      this.group.scale.y = settings.exaggeration;
      this.material.wireframe = settings.wireframe;
      this.setSun(settings.sun);
      this.observer = new ResizeObserver(this.resize);
      this.observer.observe(host);
      this.resize();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  setSnapshot(snapshot: WorldSnapshot): void {
    if (this.disposed || this.lost) return;
    const model = buildWorldTerrainMesh(snapshot);
    const changedFootprint = this.geometry?.footprint !== model.footprint;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(model.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(model.normals, 3));
    geometry.setAttribute('uv', new BufferAttribute(model.uv, 2));
    geometry.setIndex(new BufferAttribute(model.indices, 1));
    geometry.computeBoundingSphere();
    const wallGeometry = new BufferGeometry();
    wallGeometry.setAttribute('position', new BufferAttribute(model.walls, 3));
    wallGeometry.computeVertexNormals();
    this.mesh.geometry.dispose();
    this.walls.geometry.dispose();
    this.mesh.geometry = geometry;
    this.walls.geometry = wallGeometry;
    this.geometry = model;
    this.snapshot = snapshot;
    this.hasMaterial = false;
    this.perspective.far = this.ortho.far = Math.max(2000, model.verticalSpan * 32);
    this.perspective.updateProjectionMatrix();
    this.ortho.updateProjectionMatrix();
    this.controls.maxDistance = Math.max(1000, model.verticalSpan * 64);
    if (changedFootprint) {
      this.reset();
      const saved = this.savedCamera;
      if (saved?.footprint === model.footprint) {
        this.camera.position.fromArray(saved.position);
        this.controls.target.fromArray(saved.target);
        this.camera.position
          .sub(this.controls.target)
          .multiplyScalar(terrainAspectResize(saved.aspect, this.viewportAspect))
          .add(this.controls.target);
        if (this.camera instanceof OrthographicCamera) {
          this.camera.zoom = saved.zoom;
          this.camera.updateProjectionMatrix();
        }
      }
      this.savedCamera = null;
    }
    this.setLayer(this.layer, this.scale);
    this.setSelection(this.region);
    this.renderer.domElement.dataset.meshUpdates = String(++this.updates);
    this.renderer.domElement.dataset.meshColumns = String(model.columns);
    this.renderer.domElement.dataset.meshRows = String(model.rows);
    this.requestRender();
  }

  setLayer(layer: WorldLayer, scale: WorldLayerScale): void {
    this.layer = layer;
    this.scale = scale;
    if (!this.snapshot || this.disposed || this.lost) return;
    const canvas = document.createElement('canvas');
    canvas.width = this.snapshot.result.width;
    canvas.height = this.snapshot.result.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The terrain color surface could not be created.');
    const image = context.createImageData(canvas.width, canvas.height);
    image.data.set(worldMapPixels(this.snapshot, layer === 'relief' ? 'elevation' : layer, scale));
    context.putImageData(image, 0, 0);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = texture.magFilter = LinearFilter;
    texture.generateMipmaps = false;
    texture.offset.set(0.5 / canvas.width, 0.5 / canvas.height);
    texture.repeat.set((canvas.width - 1) / canvas.width, (canvas.height - 1) / canvas.height);
    this.diagnosticTexture?.dispose();
    this.diagnosticTexture = texture;
    this.bindMaterial();
  }

  setMaterial(maps: WorldMaterialPreview): void {
    if (!this.snapshot || this.disposed || this.lost) return;
    if (maps.width !== this.snapshot.result.width || maps.height !== this.snapshot.result.height)
      throw new Error('Material maps do not match the displayed world revision.');
    const anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.materialTextures = [maps.basecolor, maps.orm, maps.detailNormal].map((pixels, index) =>
      updatePreviewTexture(
        this.materialTextures[index],
        pixels,
        maps.width,
        index === 0,
        anisotropy,
        maps.height,
      ),
    );
    this.hasMaterial = true;
    this.renderer.domElement.dataset.materialUploads = String(++this.materialUploads);
    this.bindMaterial();
  }

  setMaterialEnabled(enabled: boolean): void {
    this.materialEnabled = enabled;
    this.bindMaterial();
  }
  setMaterialStatus(status: 'off' | 'loading' | 'ready' | 'error'): void {
    this.renderer.domElement.dataset.materialState = status;
  }
  private bindMaterial(): void {
    if (this.disposed || this.lost) return;
    if (this.materialEnabled && this.hasMaterial) {
      applyPackedPBRMaterial(
        this.material,
        this.materialTextures[0],
        this.materialTextures[1],
        this.materialTextures[2],
      );
      this.renderer.domElement.dataset.shading = 'material';
    } else {
      this.material.map = this.diagnosticTexture ?? null;
      this.material.roughnessMap = this.material.aoMap = this.material.normalMap = null;
      this.material.roughness = 0.94;
      this.material.needsUpdate = true;
      this.renderer.domElement.dataset.shading = 'diagnostic';
    }
    this.requestRender();
  }

  setSelection(region: WorldRegion | null): void {
    this.region = region;
    this.outline.visible = false;
    this.requestRender();
    if (!region || !this.snapshot || !this.geometry) return;
    const selected = worldGridBounds(this.snapshot.world, region);
    const { bounds, extent, width, depth, verticalSpan } = this.geometry;
    const sx = clamp((selected.x - bounds.x) / extent - width / 2, -width / 2, width / 2);
    const sz = clamp((selected.z - bounds.z) / extent - depth / 2, -depth / 2, depth / 2);
    const ex = clamp(
      (selected.x + selected.width - bounds.x) / extent - width / 2,
      -width / 2,
      width / 2,
    );
    const ez = clamp(
      (selected.z + selected.depth - bounds.z) / extent - depth / 2,
      -depth / 2,
      depth / 2,
    );
    if (ex > sx && ez > sz) {
      this.outline.geometry.setFromPoints([
        new Vector3(sx, verticalSpan + 0.015, sz),
        new Vector3(ex, verticalSpan + 0.015, sz),
        new Vector3(ex, verticalSpan + 0.015, ez),
        new Vector3(sx, verticalSpan + 0.015, ez),
      ]);
      this.outline.geometry.computeBoundingSphere();
      this.outline.visible = true;
    }
    this.requestRender();
  }
  reset(): void {
    const box = new Box3().setFromObject(this.group);
    const target = box.getCenter(new Vector3());
    this.controls.target.copy(target);
    const distance =
      Math.max(1.6, box.getSize(new Vector3()).length() * 1.6) *
      terrainAspectScale(this.viewportAspect);
    this.camera.position.set(distance * 0.65, target.y + distance * 0.65, distance * 0.8);
    this.camera.lookAt(target);
    if (this.camera instanceof OrthographicCamera) {
      this.camera.zoom = 1;
      this.camera.updateProjectionMatrix();
    }
    this.controls.update();
    this.requestRender();
  }
  setExaggeration(value: number): void {
    this.group.scale.y = value;
    this.requestRender();
  }
  setWireframe(value: boolean): void {
    this.material.wireframe = value;
    this.requestRender();
  }
  setSun(degrees: number): void {
    const angle = (degrees * Math.PI) / 180;
    this.key.position.set(Math.sin(angle) * 2, 2.4, -Math.cos(angle) * 2);
    this.requestRender();
  }
  setProjection(orthographic: boolean): void {
    const previous = this.camera;
    this.camera = orthographic ? this.ortho : this.perspective;
    this.camera.position.copy(previous.position);
    this.camera.quaternion.copy(previous.quaternion);
    this.controls.object = this.camera;
    this.resize();
  }
  cameraState(): WorldTerrainCameraState | null {
    if (!this.geometry) return this.savedCamera;
    return {
      footprint: this.geometry.footprint,
      position: this.camera.position.toArray(),
      target: this.controls.target.toArray(),
      zoom: this.camera instanceof OrthographicCamera ? this.camera.zoom : 1,
      aspect: this.viewportAspect,
    };
  }
  private contextLost = (event: Event) => {
    event.preventDefault();
    this.lost = true;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.renderer.domElement.dataset.rendered = 'false';
    const camera = this.cameraState();
    this.dispose();
    this.savedCamera = camera;
    this.onError('The 3D graphics context was lost. Your terrain remains available in Map view.');
  };
  private requestRender = () => {
    if (this.disposed || this.lost || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.disposed || this.lost) return;
      try {
        const changed = this.controls.update();
        this.renderer.render(this.scene, this.camera);
        this.renderer.domElement.dataset.rendered = 'true';
        if (changed) this.requestRender();
      } catch (error) {
        this.onError(error instanceof Error ? error.message : 'World terrain rendering failed.');
      }
    });
  };
  private resize = () => {
    if (this.disposed || this.lost) return;
    const width = this.host.clientWidth,
      height = this.host.clientHeight;
    if (width <= 0 || height <= 0) return;
    const aspect = width / height;
    this.camera.position
      .sub(this.controls.target)
      .multiplyScalar(terrainAspectResize(this.viewportAspect, aspect))
      .add(this.controls.target);
    this.viewportAspect = aspect;
    this.renderer.setSize(width, height, false);
    this.perspective.aspect = aspect;
    this.perspective.updateProjectionMatrix();
    const halfHeight = 0.9 * terrainAspectScale(aspect);
    this.ortho.left = -aspect * halfHeight;
    this.ortho.right = aspect * halfHeight;
    this.ortho.top = halfHeight;
    this.ortho.bottom = -halfHeight;
    this.ortho.updateProjectionMatrix();
    this.requestRender();
  };
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.observer?.disconnect();
    this.controls?.removeEventListener('change', this.requestRender);
    this.controls?.dispose();
    this.renderer.domElement.removeEventListener('webglcontextlost', this.contextLost);
    this.mesh.geometry.dispose();
    this.walls.geometry.dispose();
    this.material.dispose();
    this.wallMaterial.dispose();
    this.outline.geometry.dispose();
    this.outline.material.dispose();
    this.floor.geometry.dispose();
    for (const material of Array.isArray(this.floor.material)
      ? this.floor.material
      : [this.floor.material])
      material.dispose();
    this.diagnosticTexture?.dispose();
    this.materialTextures.forEach((texture) => texture.dispose());
    this.materialTextures.length = 0;
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.snapshot = undefined;
    this.geometry = undefined;
  }
}
