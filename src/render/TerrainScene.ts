import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { TerrainPoint } from '../model/viewportUX';
import type { HeightField, TerrainProject, ViewSettings } from '../model/types';
import { alpineMaterialVariation, terrainColor } from './maps';
import {
  adaptiveTerrainGeometrySteps, advanceWithinBudget, createTerrainSampler, planTerrainMesh,
  planUniform512Reference, runToCompletion,
} from './terrainMesh';
import type { BudgetedStep, TerrainMeshPlan, TerrainSampler } from './terrainMesh';
import { resolveSurface } from '../materials/pbr';
import { packPreviewPBR } from './previewMaterial';
import { createNearFieldUniforms, installNearFieldShader, nearFieldShouldRender } from './nearField';
import { createSlopeTexture, createSourceNormalUniforms, installSourceNormals } from './sourceNormals';
import { packedPreview, requestPBR } from '../materials/pbrClient';
import { sampleSpline } from '../model/splines';
import type { SplinePoint } from '../model/splines';
import { Atmosphere, skyLighting } from './Atmosphere';
import { GroundExtension, TERRAIN_SIZE } from './GroundExtension';
import { updatePreviewTexture } from './pbrTexture';
import { applyPackedPBRMaterial } from './pbrMaterial';
import { geometryBufferBytes } from './meshDiagnostics';

const clamp = (v: number) => Math.max(0, Math.min(1, v));

/**
 * Main-thread CPU spent per frame on a camera-driven LOD rebuild. An Ultra
 * rebuild costs 50–120 ms in one piece (3–7 dropped frames at 60 Hz); sliced,
 * the old mesh stays on screen until the new one is complete.
 */
export const MESH_SLICE_BUDGET_MS = 4;

interface BuiltTerrainMesh {
  geometry: THREE.BufferGeometry;
  /** The surface material the vertex colours were written for. */
  colorMaterial: ViewSettings['material'];
}

/** Present only on ?meshBenchmark=... pages; used by tests/perf. */
export interface MeshBenchmarkHooks {
  /** Place the orbit camera (scene units). */
  setCamera: (position: [number, number, number], target: [number, number, number]) => void;
  /** Displayed terrain surface height at scene x/z, including exaggeration. */
  heightAt: (x: number, z: number) => number | null;
}
type BenchmarkWindow = Window & { __nhMeshBenchmark?: MeshBenchmarkHooks };

interface PendingTerrainMesh {
  plan: TerrainMeshPlan;
  sampler: TerrainSampler;
  steps: Generator<void, BuiltTerrainMesh, undefined>;
  cpuMs: number;
  maxSliceMs: number;
  frames: number;
}

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
  private readonly camera = new THREE.PerspectiveCamera(36, 1, 0.002, 40);
  private readonly controls: OrbitControls;
  private readonly resizeObserver: ResizeObserver;
  private readonly sun: THREE.DirectionalLight;
  private readonly hemisphere: THREE.HemisphereLight;
  // Allocate optional atmosphere and foliage resources only while enabled.
  // Software WebGL and 2D-only sessions should pay no GPU setup cost.
  private atmosphere: Atmosphere | null = null;
  private groundExtension: GroundExtension | null = null;
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
  private heightSampler: TerrainSampler | null = null;
  private samplerSource: Float32Array | null = null;
  private samplerScaleKey = '';
  private lodKey = '';
  private currentMeshPlan: TerrainMeshPlan | null = null;
  // Camera-driven LOD refreshes are built a slice per frame, never in one stall.
  private pendingMesh: PendingTerrainMesh | null = null;
  // Source min/max are needed on every rebuild; scan each height array once.
  private rangeSource: Float32Array | null = null;
  private fieldMinimum = 0;
  private fieldMaximum = 0;
  private lastLODCheckMs = 0;
  private lastCameraChangeMs = 0;
  // LOD is event-driven, not recomputed at 300 ms intervals while idle.
  private lodDirty = true;
  private readonly meshBenchmark = new URLSearchParams(window.location.search)
    .get('meshBenchmark');
  private meshPlanChecks = 0;
  private meshBuilds = 0;
  private meshDisposals = 0;
  private pbrRequests = 0;
  private pbrUploads = 0;
  private lastMeshBuildMs = 0;
  private lastMeshPlanMs = 0;
  // Optional hardware timing. WebGL2 EXT_disjoint_timer_query_webgl2 is
  // queried only in the explicit benchmark URL mode; never fake GPU timings
  // using CPU submission or requestAnimationFrame intervals.
  private gpuTimer: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;
  private gpuPending: WebGLQuery[] = [];
  private gpuDurationsMs: number[] = [];
  private lastGpuPublishMs = 0;
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
  // Wall-clock diagnostics: the first draw includes shader/GPU uploads, not a
  // GPU timer query; useful for locating exceptional frame stalls.
  private measurePBRFirstRender = false;
  private lastWeatherFrame = 0;
  private weatherInterval = 1 / 24;
  private contourUniform = { value: false };
  private spacingUniform = { value: 0.015 };
  private readonly nearField = createNearFieldUniforms();
  // Per-pixel source normals: shading detail independent of mesh density.
  private readonly sourceNormals = createSourceNormalUniforms();
  private slopeTexture: THREE.DataTexture | null = null;
  private meadowBlendUniform = { value: 0 };
  private meadowTextureUniform: { value: THREE.Texture | null } = { value: null };
  private splinePath: readonly SplinePoint[] | null = null;
  private splineMode: 'river' | 'ridge' = 'river';
  private splineGuide: THREE.Group | null = null;
  private readonly onContextLost: (event: Event) => void;
  private readonly raycaster = new THREE.Raycaster();
  private readonly rayPointer = new THREE.Vector2();
  private readonly hoverMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.019, 12, 10),
    new THREE.MeshBasicMaterial({ color: '#fbf9ed', depthTest: false }),
  );
  private readonly pinnedMarkers = [0, 1].map(() => new THREE.Mesh(
    new THREE.SphereGeometry(0.023, 12, 10),
    new THREE.MeshBasicMaterial({ color: '#e2ae64', depthTest: false }),
  ));
  private readonly inspectLine = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: '#fff3da', linewidth: 2, depthTest: false }),
  );
  private inspectLineField: HeightField | null = null;
  private inspectLineKey = '';

  /** Hit-test the displayed terrain, returning coordinates in the source heightfield. */
  pickPoint(clientX: number, clientY: number): TerrainPoint | null {
    if (!this.terrain) return null;
    const bounds = this.renderer.domElement.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;
    this.rayPointer.set(
      ((clientX - bounds.left) / bounds.width) * 2 - 1,
      1 - ((clientY - bounds.top) / bounds.height) * 2,
    );
    this.raycaster.setFromCamera(this.rayPointer, this.camera);
    const hit = this.raycaster.intersectObject(this.terrain, false)[0];
    if (!hit) return null;
    return {
      u: THREE.MathUtils.clamp(hit.point.x / TERRAIN_SIZE + 0.5, 0, 1),
      v: THREE.MathUtils.clamp(hit.point.z / TERRAIN_SIZE + 0.5, 0, 1),
    };
  }

  /** Keep linked inspection markers independent of adaptive geometry and exports. */
  setInspection(hover: TerrainPoint | null, pinned: readonly TerrainPoint[]) {
    const field = this.field, project = this.project;
    const locate = (point: TerrainPoint, out: THREE.Object3D) => {
      if (!field || !project) return;
      const y = bilinear(field.height, field.resolution, point.u, point.v) *
        TERRAIN_SIZE * project.heightScale / project.worldSize * this.settings.exaggeration;
      out.position.set(
        (point.u - 0.5) * TERRAIN_SIZE, y + 0.03, (point.v - 0.5) * TERRAIN_SIZE,
      );
    };
    this.hoverMarker.visible = !!field && !!hover;
    if (hover) locate(hover, this.hoverMarker);
    for (let i = 0; i < 2; i++) {
      const marker = this.pinnedMarkers[i];
      marker.visible = !!field && !!pinned[i];
      if (pinned[i]) locate(pinned[i], marker);
    }
    this.inspectLine.visible = !!field && pinned.length === 2;
    const key = field && project && pinned.length === 2 ?
      JSON.stringify([pinned, project.worldSize, project.heightScale, this.settings.exaggeration]) : '';
    if (field && project && key && (field !== this.inspectLineField || key !== this.inspectLineKey)) {
      const positions: THREE.Vector3[] = [];
      const scale = TERRAIN_SIZE * project.heightScale / project.worldSize *
        this.settings.exaggeration;
      for (let i = 0; i <= 64; i++) {
        const t = i / 64;
        const u = pinned[0].u * (1 - t) + pinned[1].u * t;
        const v = pinned[0].v * (1 - t) + pinned[1].v * t;
        positions.push(new THREE.Vector3(
          (u - 0.5) * TERRAIN_SIZE,
          bilinear(field.height, field.resolution, u, v) * scale + 0.024,
          (v - 0.5) * TERRAIN_SIZE,
        ));
      }
      this.inspectLine.geometry.dispose();
      this.inspectLine.geometry = new THREE.BufferGeometry().setFromPoints(positions);
      this.inspectLineField = field;
      this.inspectLineKey = key;
    } else if (!key) {
      this.inspectLineField = null;
      this.inspectLineKey = '';
    }
    this.needsRender = true;
  }

  private readonly onFocusTerrain = (event: MouseEvent) => {
    if (!this.terrain) return;
    const point = this.pickPoint(event.clientX, event.clientY);
    if (!point || !this.field || !this.project) return;
    const hit = {
      point: new THREE.Vector3(
        (point.u - 0.5) * TERRAIN_SIZE,
        bilinear(this.field.height, this.field.resolution, point.u, point.v) *
          TERRAIN_SIZE * this.project.heightScale / this.project.worldSize * this.settings.exaggeration,
        (point.v - 0.5) * TERRAIN_SIZE,
      ),
    };
    // Move the orbit target to the actual mesh point while preserving the
    // current view direction/distance. This makes 1–5 m microstructure
    // inspectable on any cliff, not only at the tile's default center.
    const delta = hit.point.clone().sub(this.controls.target);
    this.controls.target.copy(hit.point);
    this.camera.position.add(delta);
    this.cameraAdjusted = true;
    this.controls.update();
    this.needsRender = true;
  };

  constructor(
    private readonly host: HTMLDivElement,
    settings: ViewSettings,
    private readonly onError: (message: string) => void,
    theme: 'light' | 'dark' = 'light',
    private readonly onCameraHeading?: (heading: number) => void,
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
    this.renderer.domElement.dataset.nearFieldDetail = 'inactive';
    if (this.meshBenchmark) {
      const gl = this.renderer.getContext();
      this.gpuTimer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      this.renderer.domElement.dataset.meshGpuTimerSupported = String(!!this.gpuTimer);
      // Benchmark-only hooks (?meshBenchmark=...): aim reproducible visual
      // captures at real ridges, cliffs and edges of the displayed terrain.
      (window as BenchmarkWindow).__nhMeshBenchmark = {
        setCamera: (position, target) => {
          this.controls.target.set(target[0], target[1], target[2]);
          this.camera.position.set(position[0], position[1], position[2]);
          this.cameraAdjusted = true;
          this.controls.update();
          this.needsRender = true;
        },
        heightAt: (x, z) => {
          if (!this.heightSampler || !this.project) return null;
          const scale = TERRAIN_SIZE * this.project.heightScale / this.project.worldSize;
          return this.heightSampler.height(x / TERRAIN_SIZE + 0.5, z / TERRAIN_SIZE + 0.5) *
            scale * this.settings.exaggeration;
        },
      };
    }
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
      shader.uniforms.nhMeadowBlend = this.meadowBlendUniform;
      shader.uniforms.nhMeadowMap = this.meadowTextureUniform;
      shader.vertexShader = 'varying vec3 vNHPosition;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvNHPosition = position;',
      );
      shader.fragmentShader =
        'varying vec3 vNHPosition;\nuniform bool nhContours;\nuniform float nhSpacing;\nuniform float nhMeadowBlend;\nuniform sampler2D nhMeadowMap;\n' +
        shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        if (nhMeadowBlend > 0.5) {
          // Blend the outer 12% of the displayed terrain into the adjacent
          // meadow. The generated PBR textures and actual elevations stay
          // completely unchanged; this affects the studio preview only.
          float edgeDistance = 1.3 - max(abs(vNHPosition.x), abs(vNHPosition.z));
          float grassFraction = 1.0 - smoothstep(0.0, 0.32, edgeDistance);
          if (grassFraction > 0.001) {
            // Match the apron texture mapping exactly: its UV origin is 0.5
            // and the shared grass texture is repeated at 0.8 cycles/unit.
            vec2 meadowUv = vec2(vNHPosition.x * 0.8 + 0.5, 0.5 - vNHPosition.z * 0.8);
            vec3 meadowAlbedo = texture2D(nhMeadowMap, meadowUv).rgb;
            diffuseColor.rgb = mix(diffuseColor.rgb, meadowAlbedo, grassFraction);
          }
        }`,
      );
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
      installNearFieldShader(shader, this.nearField);
      installSourceNormals(shader, this.sourceNormals);
    };

    this.camera.position.set(3.25, 2.4, 3.55);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.2, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    // At 8 km tile width the old 0.55-unit minimum stayed >1.6 km from
    // the orbit target, hiding all centimeter/meter shader detail.
    // 0.045 units is ~138 m on that tile; the matching near plane prevents
    // 3D clipping while retaining useful depth precision at the scene far plane.
    this.controls.minDistance = 0.045;
    this.controls.maxDistance = 12;
    this.controls.maxPolarAngle = Math.PI * 0.485;
    this.controls.autoRotateSpeed = 0.65;
    this.controls.enablePan = true;
    this.controls.screenSpacePanning = true;
    this.controls.update();
    this.controls.addEventListener('change', () => {
      this.onCameraHeading?.(this.cameraHeading());
      this.needsRender = true;
      this.lodDirty = true;
      this.lastCameraChangeMs = performance.now();
    });
    this.controls.addEventListener('start', () => {
      this.cameraAdjusted = true;
    });
    this.renderer.domElement.addEventListener('dblclick', this.onFocusTerrain);
    this.onCameraHeading?.(this.cameraHeading());
    this.hoverMarker.visible = false;
    this.hoverMarker.renderOrder = 10;
    this.scene.add(this.hoverMarker);
    for (const marker of this.pinnedMarkers) {
      marker.visible = false;
      marker.renderOrder = 10;
      this.scene.add(marker);
    }
    this.inspectLine.visible = false;
    this.inspectLine.renderOrder = 9;
    this.scene.add(this.inspectLine);

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
    this.lastLODCheckMs = 0;
    this.lodDirty = true;
    this.needsRender = true;
  }

  private animate = () => {
    if (this.disposed || this.contextLost) return;
    this.animation = requestAnimationFrame(this.animate);
    if (!this.host.clientWidth || !this.host.clientHeight || document.hidden) return;
    this.controls.update();
    // Camera changes mark LOD dirty. Don't re-plan 3x/s while idle. When
    // auto-rotating, refresh at most every 1.5 s rather than staying stale.
    const lodNow = performance.now();
    // Query GPU work on idle RAFs, too. A still camera may not produce any
    // additional draw calls, but the last submitted query can finish later.
    if (this.meshBenchmark && this.gpuPending.length)
      this.pollGpuTimers(lodNow);
    if (this.lodDirty && this.terrain && this.field && this.project &&
        this.heightSampler && lodNow - this.lastLODCheckMs > 240 &&
        (lodNow - this.lastCameraChangeMs > 220 ||
         lodNow - this.lastLODCheckMs > 1500)) {
      this.lastLODCheckMs = lodNow;
      this.lodDirty = false;
      const plan = this.planCurrentMesh();
      if (plan) this.scheduleMesh(plan);
    }
    if (this.pendingMesh) this.advancePendingMesh();
    // Enable the additional shader evaluation only when its physical wavelength
    // can influence screen pixels. This is a display-only uniform; orbit/zoom
    // never invalidates the erosion field or regenerates the PBR worker maps.
    const activeMicro = !!this.project && this.settings.material === 'pbr' &&
      nearFieldShouldRender(
        this.settings.nearFieldDetail,
        this.camera.position.distanceTo(this.controls.target),
        this.host.clientHeight * this.renderer.getPixelRatio(),
        this.camera.fov,
        this.nearField.nhMetersPerUnit.value,
        this.nearField.nhDetailMeters.value,
      );
    const activeValue = activeMicro ? 1 : 0;
    if (this.nearField.nhNearFieldActive.value !== activeValue) {
      this.nearField.nhNearFieldActive.value = activeValue;
      this.renderer.domElement.dataset.nearFieldDetail = activeMicro ? 'active' : 'inactive';
      this.needsRender = true;
    }
    const seconds = performance.now() / 1000;
    this.atmosphere?.follow(this.camera);
    this.atmosphere?.tick(seconds, this.settings);
    // The meadow is a static textured surface. Only moving sky clouds need
    // autonomous redraws; no grass sprites or wind-driven foliage remain.
    const weatherMoves = this.settings.cloudSpeed > 0 &&
      this.settings.skyEnabled && this.settings.cloudCoverage > 0;
    // Smooth 24 Hz weather on capable hardware; adapt toward 6 Hz on slow
    // software devices. User actions are never throttled.
    const weatherFrame = weatherMoves &&
      seconds - this.lastWeatherFrame >= this.weatherInterval;
    if (this.needsRender || this.controls.autoRotate || weatherFrame) {
      const started = performance.now();
      const gl = this.meshBenchmark && this.gpuTimer
        ? this.renderer.getContext() as WebGL2RenderingContext : null;
      let gpuQuery: WebGLQuery | null = null;
      if (gl && this.gpuTimer && this.gpuPending.length < 4) {
        gpuQuery = gl.createQuery();
        if (gpuQuery) gl.beginQuery(this.gpuTimer.TIME_ELAPSED_EXT, gpuQuery);
      }
      try {
        this.renderer.render(this.scene, this.camera);
      } finally {
        if (gpuQuery && gl && this.gpuTimer) {
          gl.endQuery(this.gpuTimer.TIME_ELAPSED_EXT);
          this.gpuPending.push(gpuQuery);
        }
      }
      if (this.meshBenchmark) {
        this.pollGpuTimers(performance.now());
        
        const stats = this.renderer.domElement.dataset;
        stats.meshRenderCpuMs = (performance.now() - started).toFixed(2);
        stats.meshCameraPosition = this.camera.position.toArray().map(n => n.toFixed(6)).join(',');
        stats.meshCameraTarget = this.controls.target.toArray().map(n => n.toFixed(6)).join(',');
        stats.meshRendererGeometries = String(this.renderer.info.memory.geometries);
        stats.meshRendererTextures = String(this.renderer.info.memory.textures);
      }
      if (this.measurePBRFirstRender) {
        this.renderer.domElement.dataset.pbrFirstRenderMs =
          (performance.now() - started).toFixed(2);
        this.measurePBRFirstRender = false;
      }
      if (weatherFrame) {
        const finished = performance.now();
        this.lastWeatherFrame = finished / 1000;
        const budget = THREE.MathUtils.clamp((finished - started) / 1000 * 5, 1 / 24, 1 / 6);
        this.weatherInterval = THREE.MathUtils.lerp(this.weatherInterval, budget, 0.25);
      }
      this.needsRender = false;
    }
  };

  /** Drain completed GPU queries without synchronously waiting for the GPU. */
  private pollGpuTimers(now: number) {
    const ext = this.gpuTimer;
    if (!ext || this.contextLost) return;
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const disjoint = Boolean(gl.getParameter(ext.GPU_DISJOINT_EXT));
    while (this.gpuPending.length &&
        gl.getQueryParameter(this.gpuPending[0], gl.QUERY_RESULT_AVAILABLE)) {
      const query = this.gpuPending.shift()!;
      if (!disjoint) {
        const elapsedNs = Number(gl.getQueryParameter(query, gl.QUERY_RESULT));
        if (Number.isFinite(elapsedNs) && elapsedNs >= 0) {
          this.gpuDurationsMs.push(elapsedNs / 1e6);
          if (this.gpuDurationsMs.length > 2048)
            this.gpuDurationsMs.splice(0, this.gpuDurationsMs.length - 2048);
        }
      }
      gl.deleteQuery(query);
    }
    if (now - this.lastGpuPublishMs >= 900) {
      this.lastGpuPublishMs = now;
      const data = this.renderer.domElement.dataset;
      data.meshGpuSampleCount = String(this.gpuDurationsMs.length);
      data.meshGpuSamples = JSON.stringify(this.gpuDurationsMs.slice(-512));
    }
  }

  update(field: HeightField, project: TerrainProject, settings: ViewSettings) {
    const previousBase = this.minimumElevation * this.settings.exaggeration;
    const geometryChanged =
      this.field !== field ||
      this.project?.worldSize !== project.worldSize ||
      this.project?.heightScale !== project.heightScale ||
      this.settings.meshQuality !== settings.meshQuality;
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
      this.renderer.toneMappingExposure = 0.97 * this.settings.skyExposure;
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
    const shadowGeometryChanged = scaleChanged ||
      this.settings.sunAzimuth !== settings.sunAzimuth ||
      this.settings.sunElevation !== settings.sunElevation ||
      this.settings.expandGround !== settings.expandGround;
    this.settings = settings;
    if (scaleChanged) this.lodDirty = true;
    this.sourceNormals.nhVerticalScale.value = settings.exaggeration;
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
    if (settings.skyEnabled) {
      this.atmosphere ??= new Atmosphere(this.scene, this.renderer, () => {
        this.needsRender = true;
      });
      this.atmosphere.apply(settings);
      this.atmosphere.attach(this.material);
    } else if (this.atmosphere) {
      this.atmosphere.dispose();
      this.atmosphere = null;
    }
    this.updateEnvironmentLighting();
    if (this.terrain) this.terrain.scale.y = settings.exaggeration;
    if (this.skirt) this.skirt.scale.y = settings.exaggeration;
    this.updateSupport();
    if (settings.expandGround) {
      this.groundExtension ??= new GroundExtension(this.scene, this.renderer);
      this.groundExtension.update(this.field, this.project, settings, this.minimumElevation, this.terrain);
      this.meadowBlendUniform.value = 1;
      this.meadowTextureUniform.value = this.groundExtension.grassMap;
      if (this.atmosphere) for (const material of this.groundExtension.materials)
        this.atmosphere.attach(material);
    } else {
      this.meadowBlendUniform.value = 0;
      this.meadowTextureUniform.value = null;
      if (this.groundExtension) {
        if (this.atmosphere) for (const material of this.groundExtension.materials)
          this.atmosphere.detach(material);
        this.groundExtension.dispose();
        this.groundExtension = null;
      }
    }
    if (paletteChanged && this.terrain) {
      this.updateColors();
      this.updatePBRTextures();
    }
    if (scaleChanged && this.terrain) this.rebuildSplineGuide();
    if (scaleChanged && this.terrain && !this.cameraAdjusted) this.fitCamera();
    // Changing haze, exposure, cloud shadows or materials must
    // not trigger a costly 2048² sun-shadow regeneration. Only the actual
    // shadow-caster geometry or light direction requires it.
    if (shadowGeometryChanged) this.renderer.shadowMap.needsUpdate = true;
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

  /** The original heightfield remains authoritative for every LOD. */
  private planCurrentMesh(): TerrainMeshPlan | null {
    if (!this.heightSampler || !this.project) return null;
    const started = performance.now();
    const plan = this.meshBenchmark === 'uniform512'
      ? planUniform512Reference()
      : planTerrainMesh(
          this.heightSampler, this.camera,
          this.host.clientHeight, this.renderer.getPixelRatio(),
          this.project.heightScale, this.project.worldSize,
          this.settings.exaggeration, this.settings.meshQuality,
          // Hysteresis is anchored to the mesh being converged to, so small
          // camera moves don't restart an in-progress sliced build.
          this.pendingMesh?.plan ?? this.currentMeshPlan,
        );
    this.lastMeshPlanMs = performance.now() - started;
    this.meshPlanChecks++;
    const stats = this.renderer.domElement.dataset;
    stats.meshPlanChecks = String(this.meshPlanChecks);
    stats.meshPlanMs = this.lastMeshPlanMs.toFixed(2);
    return plan;
  }

  /** Start (or keep) the sliced build that brings the displayed mesh to `plan`. */
  private scheduleMesh(plan: TerrainMeshPlan) {
    if (plan.key === this.lodKey) {
      // The camera came back to the displayed LOD; drop any obsolete build.
      this.pendingMesh = null;
      return;
    }
    if (this.pendingMesh?.plan.key === plan.key || !this.heightSampler || !this.project) return;
    this.pendingMesh = {
      plan,
      sampler: this.heightSampler,
      steps: this.terrainMeshSteps(
        this.heightSampler, plan, this.project.heightScale, this.project.worldSize,
      ),
      cpuMs: 0,
      maxSliceMs: 0,
      frames: 0,
    };
  }

  /** Spend at most one budgeted slice of this frame on the pending LOD mesh. */
  private advancePendingMesh() {
    const job = this.pendingMesh!;
    // A new field or tile scale replaces the sampler; that path rebuilds
    // synchronously, so a build for the old sampler is obsolete.
    if (job.sampler !== this.heightSampler || !this.field || !this.project) {
      this.pendingMesh = null;
      return;
    }
    const started = performance.now();
    let step: BudgetedStep<BuiltTerrainMesh>;
    try {
      step = advanceWithinBudget(job.steps, MESH_SLICE_BUDGET_MS);
    } catch (error) {
      this.pendingMesh = null;
      throw error;
    }
    job.frames++;
    if (!step.done) {
      const elapsed = performance.now() - started;
      job.cpuMs += elapsed;
      job.maxSliceMs = Math.max(job.maxSliceMs, elapsed);
      return;
    }
    this.pendingMesh = null;
    this.installTerrain(job.plan, step.value);
    const elapsed = performance.now() - started;
    this.publishBuildStats(job.cpuMs + elapsed, Math.max(job.maxSliceMs, elapsed), job.frames);
    this.renderer.shadowMap.needsUpdate = true;
    this.needsRender = true;
  }

  /** Geometry, then vertex colours: resumable so LOD refreshes can be sliced. */
  private *terrainMeshSteps(
    sampler: TerrainSampler, plan: TerrainMeshPlan, heightScale: number, worldSize: number,
  ): Generator<void, BuiltTerrainMesh, undefined> {
    const geometry = yield* adaptiveTerrainGeometrySteps(sampler, plan, heightScale, worldSize);
    const colorMaterial = this.settings.material;
    yield* this.colorSteps(geometry);
    return { geometry, colorMaterial };
  }

  /** Source min/max, computed once per height array rather than per LOD rebuild. */
  private fieldRange(): { min: number; max: number } {
    const height = this.field!.height;
    if (this.rangeSource !== height) {
      let min = Infinity,
        max = -Infinity;
      for (const value of height) {
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
      this.rangeSource = height;
      this.fieldMinimum = min;
      this.fieldMaximum = max;
    }
    return { min: this.fieldMinimum, max: this.fieldMaximum };
  }

  /**
   * Upload the source slopes for per-pixel shading. Built once per field and
   * tile scale: LOD rebuilds and camera motion never touch it.
   */
  private updateSlopeTexture() {
    this.slopeTexture?.dispose();
    this.slopeTexture = null;
    const sampler = this.heightSampler;
    const slopes = sampler?.slopes?.();
    if (sampler && slopes) {
      this.slopeTexture = createSlopeTexture(slopes, sampler.resolution);
      this.sourceNormals.nhSlopeSize.value.set(sampler.resolution, sampler.resolution);
    }
    this.sourceNormals.nhSlopeMap.value = this.slopeTexture;
    this.sourceNormals.nhSourceNormals.value = this.slopeTexture ? 1 : 0;
    this.needsRender = true;
  }

  /** Synchronous rebuild for a new field, tile scale or mesh quality. */
  private buildGeometry() {
    if (!this.field || !this.project) return;
    const started = performance.now();
    // This supersedes any camera-driven LOD build still in progress.
    this.pendingMesh = null;
    const { resolution: n, height } = this.field;
    const scaleKey = `${this.project.worldSize}/${this.project.heightScale}`;
    if (this.samplerSource !== height || this.samplerScaleKey !== scaleKey) {
      this.heightSampler = createTerrainSampler(
        height, n, this.project.heightScale, this.project.worldSize,
      );
      this.samplerSource = height;
      this.samplerScaleKey = scaleKey;
      // Never carry hysteresis state across a new erosion field or tile scale.
      this.currentMeshPlan = null;
      this.updateSlopeTexture();
    }
    const plan = this.planCurrentMesh();
    if (!plan || !this.heightSampler) return;
    const built = runToCompletion(this.terrainMeshSteps(
      this.heightSampler, plan, this.project.heightScale, this.project.worldSize,
    ));
    this.lodDirty = false;
    this.installTerrain(plan, built);
    const elapsed = performance.now() - started;
    this.publishBuildStats(elapsed, elapsed, 1);
  }

  /** Swap a finished mesh in, with its skirt, support and meadow boundary. */
  private installTerrain(plan: TerrainMeshPlan, built: BuiltTerrainMesh) {
    if (!this.field || !this.project) return;
    const { geometry } = built;
    const n = this.field.resolution;
    const positions = geometry.getAttribute('position');
    const scale = TERRAIN_SIZE * this.project.heightScale / this.project.worldSize;
    // min(value * scale) === min(value) * scale for the positive tile scale.
    this.minimumElevation = Math.min(0, this.fieldRange().min * scale);
    if (this.terrain) {
      this.scene.remove(this.terrain);
      this.terrain.geometry.dispose();
      this.meshDisposals++;
    }
    this.terrain = new THREE.Mesh(geometry, this.material);
    this.terrain.receiveShadow = true;
    this.terrain.castShadow = true;
    this.terrain.scale.y = this.settings.exaggeration;
    this.scene.add(this.terrain);
    this.lodKey = plan.key;
    this.currentMeshPlan = plan;
    this.meshBuilds++;
    const stats = this.renderer.domElement.dataset;
    stats.meshVertices = String(plan.vertexCount);
    stats.meshTriangles = String(plan.triangleCount);
    stats.meshMaxSegments = String(plan.maxSegments);
    stats.meshQuality = this.settings.meshQuality;
    stats.meshSourceResolution = String(n);
    this.spacingUniform.value = Math.max(0.001, TERRAIN_SIZE * 100 / this.project.worldSize);
    // Colours were written while building; only a material switch since then
    // (possible during a sliced build) needs them rewritten.
    if (built.colorMaterial !== this.settings.material) this.updateColors();
    // A tessellation-only update must not rerun or reupload unchanged PBR maps.
    this.updatePBRTextures();

    const boundary = geometry.userData.nhPerimeterIndices as number[];
    const skirtVertices = new Float32Array(boundary.length * 18);
    const skirtBottom = this.minimumElevation - 0.002 / this.settings.exaggeration;
    for (let i = 0; i < boundary.length; i++) {
      const a = boundary[i], b = boundary[(i + 1) % boundary.length];
      const ax = positions.getX(a), ay = positions.getY(a), az = positions.getZ(a);
      const bx = positions.getX(b), by = positions.getY(b), bz = positions.getZ(b);
      const k = i * 18;
      skirtVertices.set([
        ax, ay, az,
        ax, skirtBottom, az,
        bx, by, bz,
        bx, by, bz,
        ax, skirtBottom, az,
        bx, skirtBottom, bz,
      ], k);
    }
    const skirtGeometry = new THREE.BufferGeometry();
    skirtGeometry.setAttribute('position', new THREE.BufferAttribute(skirtVertices, 3));
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
    this.groundExtension?.update(
      this.field, this.project, this.settings, this.minimumElevation, this.terrain,
    );
    stats.meshBuildCount = String(this.meshBuilds);
    stats.meshDisposeCount = String(this.meshDisposals);
    stats.meshBufferBytes = String(geometryBufferBytes(
      this.terrain?.geometry, this.skirt?.geometry,
      this.groundExtension?.apronGeometry,
    ));
  }

  /**
   * Total CPU of the last terrain build, the largest share of it spent in any
   * one frame, and how many frames it was spread across.
   */
  private publishBuildStats(totalMs: number, maxSliceMs: number, frames: number) {
    this.lastMeshBuildMs = totalMs;
    const stats = this.renderer.domElement.dataset;
    stats.meshBuildMs = this.lastMeshBuildMs.toFixed(2);
    stats.meshBuildSliceMs = maxSliceMs.toFixed(2);
    stats.meshBuildFrames = String(frames);
  }

  private updateColors() {
    if (!this.terrain || !this.field || !this.project || this.settings.material === 'pbr') return;
    runToCompletion(this.colorSteps(this.terrain.geometry));
    if (this.groundExtension) this.groundExtension.syncBoundary(this.terrain, this.settings.exaggeration);
  }

  /** Vertex colours for the current material, resumable every 1024 vertices. */
  private *colorSteps(geometry: THREE.BufferGeometry): Generator<void, void, undefined> {
    if (!this.field || !this.project || this.settings.material === 'pbr') return;
    const material = this.settings.material;
    const colors = geometry.getAttribute('color') as THREE.BufferAttribute;
    const positions = geometry.getAttribute('position');
    const normals = geometry.getAttribute('normal');
    const { min, max } = this.fieldRange();
    const heightUnits = (TERRAIN_SIZE * this.project.heightScale) / this.project.worldSize;
    const color = new THREE.Color();
    if (material === 'clay') {
      // One constant colour: convert it from sRGB once, not once per vertex.
      color.setRGB(0.61, 0.64, 0.56, THREE.SRGBColorSpace);
      const array = colors.array;
      for (let i = 0; i < array.length; i += 3) {
        array[i] = color.r;
        array[i + 1] = color.g;
        array[i + 2] = color.b;
      }
      colors.needsUpdate = true;
      return;
    }
    for (let i = 0; i < positions.count; i++) {
      const h = positions.getY(i) / heightUnits;
      const elevation = (h - min) / Math.max(0.0001, max - min);
      if (material === 'height') {
        const t = clamp(h);
        color.setRGB(t, t, t, THREE.SRGBColorSpace);
      } else {
        // Full-source Sobel normals already include the physical slope.
        const rgb = terrainColor(
          elevation,
          normals.getY(i),
          alpineMaterialVariation(
            positions.getX(i) / TERRAIN_SIZE + 0.5,
            positions.getZ(i) / TERRAIN_SIZE + 0.5,
          ),
        );
        color.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
      }
      colors.setXYZ(i, color.r, color.g, color.b);
      if ((i & 1023) === 1023) yield;
    }
    colors.needsUpdate = true;
  }

  /** Off-thread material synthesis is shared with 2D and never reruns erosion. */
  private updatePBRTextures() {
    if (!this.field || !this.project) return;
    if (this.settings.material !== 'pbr') {
      this.measurePBRFirstRender = false;
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
    const surface = resolveSurface(project.surface);
    this.nearField.nhMetersPerUnit.value = project.worldSize / TERRAIN_SIZE;
    this.nearField.nhDetailMeters.value = surface.detailMeters;
    this.nearField.nhDetailStrength.value = surface.detailStrength;
    this.nearField.nhDetailSeed.value = (project.seed % 65521) / 911;
    const surfaceKey = JSON.stringify([
      project.seed, project.surface ?? null, project.worldSize, project.heightScale,
    ]);
    if (this.lastPBRField === field && this.lastPBRSurface === surfaceKey) return;
    this.pbrRelease?.();
    const generation = ++this.pbrGeneration;
    this.lastPBRField = field;
    this.lastPBRSurface = surfaceKey;
    this.renderer.domElement.dataset.materialStatus = 'loading';
    const workerStarted = performance.now();
    const request = requestPBR(field, project);
    this.pbrRequests++;
    this.renderer.domElement.dataset.pbrRequestCount = String(this.pbrRequests);
    this.pbrRelease = request.release;
    request.promise.then((maps) => {
      if (this.disposed || generation !== this.pbrGeneration ||
          this.field !== field || this.settings.material !== 'pbr') return;
      this.pbrRelease?.();
      this.pbrRelease = null;
      const preparedAt = performance.now();
      const n = maps.resolution;
      const anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      const existing = this.pbrTextures;
      const tex = (index: number, rgba: Uint8ClampedArray, srgb = false) =>
        updatePreviewTexture(existing[index], rgba, n, srgb, anisotropy);
      const albedo = tex(0, maps.basecolor, true);
      // MeshStandardMaterial reads AO from the RED channel and roughness from
      // GREEN. Share one linear/non-color ORM map for both rather than uploading
      // two separately expanded 4-channel grayscale images.
      // Packed off-thread by the PBR worker; pack here only as a fallback.
      const preview = packedPreview(maps) ?? packPreviewPBR(maps, field, project);
      const packedORM = tex(1, preview.orm);
      // Macro geometry remains displaced; the RGB detail normal is unchanged.
      // Alpha stores the vegetation layer weight for close-up shading only.
      const microNormal = tex(2, preview.microNormal);
      for (const surplus of existing.slice(3)) surplus.dispose();
      this.pbrTextures = [albedo, packedORM, microNormal];
      this.pbrUploads++;
      this.renderer.domElement.dataset.pbrUploadCount = String(this.pbrUploads);
      applyPackedPBRMaterial(this.material, albedo, packedORM, microNormal);
      this.groundExtension?.syncBoundary(this.terrain!, this.settings.exaggeration);
      const monitor = this.renderer.domElement.dataset;
      monitor.pbrWorkerMs = (preparedAt - workerStarted).toFixed(2);
      monitor.pbrPackMs = (performance.now() - preparedAt).toFixed(2);
      monitor.pbrTextureCount = String(this.pbrTextures.length);
      this.measurePBRFirstRender = true;
      monitor.materialStatus = 'ready';
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
    // Matched reference and adaptive cases must begin from exactly the same
    // camera transform, regardless of how many vertices their geometry has.
    // This only runs on ?meshBenchmark=...; normal artist framing is unchanged.
    if (this.meshBenchmark) {
      this.controls.target.set(0, 0.28, 0);
      this.camera.position.set(3.25, 2.4, 3.55);
      this.camera.up.set(0, 1, 0);
      this.camera.far = 40;
      this.camera.updateProjectionMatrix();
      this.controls.update();
      this.needsRender = true;
      return;
    }
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

  /** North is negative Z, matching the source map's first row. */
  cameraHeading(): number {
    const dx = this.camera.position.x - this.controls.target.x;
    const dz = this.camera.position.z - this.controls.target.z;
    return (Math.atan2(dx, dz) * 180 / Math.PI + 360) % 360;
  }

  /** Camera bookmarks affect only the viewport, never source terrain. */
  captureCamera(): { position: [number, number, number]; target: [number, number, number] } {
    return {
      position: this.camera.position.toArray() as [number, number, number],
      target: this.controls.target.toArray() as [number, number, number],
    };
  }

  restoreCamera(state: { position: [number, number, number]; target: [number, number, number] }) {
    if (![...state.position, ...state.target].every(Number.isFinite)) return;
    this.camera.position.fromArray(state.position);
    this.controls.target.fromArray(state.target);
    this.cameraAdjusted = true;
    this.cameraView = 'perspective';
    this.controls.update();
    this.needsRender = true;
    this.lodDirty = true;
  }

  /** Rotate to a cardinal direction while keeping distance, height, and focal point. */
  orientCamera(heading: number) {
    const delta = this.camera.position.clone().sub(this.controls.target);
    const radius = Math.max(0.01, Math.hypot(delta.x, delta.z));
    const radians = THREE.MathUtils.degToRad(heading);
    this.camera.position.set(
      this.controls.target.x + Math.sin(radians) * radius,
      this.controls.target.y + delta.y,
      this.controls.target.z + Math.cos(radians) * radius,
    );
    this.cameraAdjusted = true;
    this.cameraView = 'perspective';
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
    this.pendingMesh = null;
    if (this.meshBenchmark) delete (window as BenchmarkWindow).__nhMeshBenchmark;
    ++this.pbrGeneration;
    this.pbrRelease?.();
    this.pbrRelease = null;
    this.pbrTextures.forEach(texture => texture.dispose());
    this.slopeTexture?.dispose();
    this.slopeTexture = null;
    this.pbrTextures = [];
    cancelAnimationFrame(this.animation);
    if (!this.contextLost && this.gpuPending.length) {
      const gl = this.renderer.getContext() as WebGL2RenderingContext;
      for (const query of this.gpuPending) gl.deleteQuery(query);
    }
    this.gpuPending = [];
    this.gpuDurationsMs = [];
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.atmosphere?.dispose();
    this.groundExtension?.dispose();
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost);
    this.renderer.domElement.removeEventListener('dblclick', this.onFocusTerrain);
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
