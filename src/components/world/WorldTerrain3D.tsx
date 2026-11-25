import { useEffect, useRef, useState } from 'react';
import {
  AmbientLight,
  Box3,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
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
import { Box, Focus, Mountain, RotateCcw, Sun, TriangleAlert } from 'lucide-react';
import { clamp, formatWorldDistance, worldGridBounds, worldMapPixels } from './worldViewMath';
import type { WorldLayer, WorldLayerScale, WorldRegion, WorldSnapshot } from './worldViewMath';

interface Props {
  snapshot: WorldSnapshot;
  layer: WorldLayer;
  scale: WorldLayerScale;
  region: WorldRegion | null;
  active?: boolean;
}

interface SceneControls {
  reset: () => void;
  exaggeration: (value: number) => void;
  wireframe: (value: boolean) => void;
  sun: (degrees: number) => void;
  projection: (orthographic: boolean) => void;
  layer: (layer: WorldLayer, scale: WorldLayerScale) => void;
  selection: (region: WorldRegion | null) => void;
}

/** A bounded mesh of real World samples. Camera movement never evaluates terrain. */
export function WorldTerrain3D({ snapshot, layer, scale, region, active = true }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<SceneControls | null>(null);
  const [exaggeration, setExaggeration] = useState(1);
  const [wireframe, setWireframe] = useState(false);
  const [sun, setSun] = useState(315);
  const [orthographic, setOrthographic] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const settingsRef = useRef({ exaggeration, wireframe, sun, orthographic });
  settingsRef.current = { exaggeration, wireframe, sun, orthographic };
  const initialDisplay = useRef({ layer, scale, region });
  initialDisplay.current = { layer, scale, region };
  const savedView = useRef<{
    footprint: string;
    position: [number, number, number];
    target: [number, number, number];
    zoom: number;
  } | null>(null);

  useEffect(() => {
    const element = host.current;
    if (!element || !active) return;
    let disposed = false;
    let cleaned = false;
    let frame = 0;
    let renderer: WebGLRenderer | null = null;
    let controls: OrbitControls | null = null;
    let observer: ResizeObserver | null = null;
    const disposables: Array<{ dispose(): void }> = [];
    const cleanups: Array<() => void> = [];
    const dispose = () => {
      if (cleaned) return;
      cleaned = true;
      disposed = true;
      cancelAnimationFrame(frame);
      controlsRef.current = null;
      observer?.disconnect();
      cleanups.forEach((cleanup) => cleanup());
      controls?.dispose();
      disposables.forEach((resource) => resource.dispose());
      renderer?.dispose();
      renderer?.forceContextLoss();
      renderer?.domElement.remove();
    };
    setError('');
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
      renderer.outputColorSpace = SRGBColorSpace;
      renderer.setClearColor(0x000000, 0);
      renderer.domElement.setAttribute('aria-label', 'Three-dimensional sampled world terrain');
      renderer.domElement.setAttribute('role', 'img');
      renderer.domElement.tabIndex = -1;
      element.appendChild(renderer.domElement);
      const onContextLost = (event: Event) => {
        event.preventDefault();
        cancelAnimationFrame(frame);
        if (renderer) renderer.domElement.dataset.rendered = 'false';
        setError('The 3D graphics context was lost. Your terrain remains available in Map view.');
      };
      renderer.domElement.addEventListener('webglcontextlost', onContextLost);
      cleanups.push(() =>
        renderer?.domElement.removeEventListener('webglcontextlost', onContextLost),
      );

      const scene = new Scene();
      const group = new Group();
      scene.add(group);
      const { result: field, world, grid } = snapshot;
      const bounds = worldGridBounds(world, grid);
      const footprint = `${bounds.x}/${bounds.z}/${bounds.width}/${bounds.depth}`;
      const extent = Math.max(bounds.width, bounds.depth);
      const width = bounds.width / extent;
      const depth = bounds.depth / extent;
      const minimum = world.domain.datum + field.min * world.domain.heightScale;
      const maximum = world.domain.datum + field.max * world.domain.heightScale;
      const verticalSpan = (maximum - minimum) / extent;
      const columns = Math.min(257, field.width),
        rows = Math.min(257, field.height);
      const positions = new Float32Array(columns * rows * 3);
      const uv = new Float32Array(columns * rows * 2);
      for (let z = 0; z < rows; z++)
        for (let x = 0; x < columns; x++) {
          const sourceX = Math.round((x / (columns - 1)) * (field.width - 1));
          const sourceZ = Math.round((z / (rows - 1)) * (field.height - 1));
          const u = sourceX / (field.width - 1),
            v = sourceZ / (field.height - 1);
          const i = z * columns + x;
          positions[i * 3] = (u - 0.5) * width;
          positions[i * 3 + 1] =
            (field.heights[sourceZ * field.width + sourceX] * world.domain.heightScale +
              world.domain.datum -
              minimum) /
            extent;
          positions[i * 3 + 2] = (v - 0.5) * depth;
          uv[i * 2] = u;
          uv[i * 2 + 1] = 1 - v;
        }
      const indices = new Uint32Array((columns - 1) * (rows - 1) * 6);
      let index = 0;
      for (let z = 0; z < rows - 1; z++)
        for (let x = 0; x < columns - 1; x++) {
          const a = z * columns + x,
            b = a + 1,
            c = a + columns,
            d = c + 1;
          indices.set([a, c, b, b, c, d], index);
          index += 6;
        }
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(positions, 3));
      geometry.setAttribute('uv', new BufferAttribute(uv, 2));
      geometry.setIndex(new BufferAttribute(indices, 1));
      geometry.computeVertexNormals();
      disposables.push(geometry);

      const map = document.createElement('canvas');
      map.width = field.width;
      map.height = field.height;
      const context = map.getContext('2d');
      if (!context) throw new Error('The terrain color surface could not be created.');
      const image = context.createImageData(field.width, field.height);
      image.data.set(
        worldMapPixels(
          snapshot,
          initialDisplay.current.layer === 'relief' ? 'elevation' : initialDisplay.current.layer,
          initialDisplay.current.scale,
        ),
      );
      context.putImageData(image, 0, 0);
      const texture = new CanvasTexture(map);
      texture.colorSpace = SRGBColorSpace;
      texture.minFilter = LinearFilter;
      texture.magFilter = LinearFilter;
      texture.generateMipmaps = false;
      disposables.push(texture);
      const material = new MeshStandardMaterial({
        map: texture,
        roughness: 0.94,
        metalness: 0,
        side: DoubleSide,
        wireframe: settingsRef.current.wireframe,
      });
      disposables.push(material);
      const mesh = new Mesh(geometry, material);
      group.add(mesh);

      // A vertical section to the sampled minimum makes the physical footprint readable.
      // These presentation-only walls never alter samples or exported elevations.
      const boundary: number[] = [];
      for (let x = 0; x < columns; x++) boundary.push(x);
      for (let z = 1; z < rows; z++) boundary.push(z * columns + columns - 1);
      for (let x = columns - 2; x >= 0; x--) boundary.push((rows - 1) * columns + x);
      for (let z = rows - 2; z >= 1; z--) boundary.push(z * columns);
      const wallPositions: number[] = [];
      for (let i = 0; i < boundary.length; i++) {
        const a = boundary[i] * 3,
          b = boundary[(i + 1) % boundary.length] * 3;
        const p = [positions[a], positions[a + 1], positions[a + 2]];
        const q = [positions[b], positions[b + 1], positions[b + 2]];
        wallPositions.push(
          ...p,
          p[0],
          -0.025,
          p[2],
          ...q,
          ...q,
          p[0],
          -0.025,
          p[2],
          q[0],
          -0.025,
          q[2],
        );
      }
      const wallGeometry = new BufferGeometry();
      wallGeometry.setAttribute('position', new Float32BufferAttribute(wallPositions, 3));
      wallGeometry.computeVertexNormals();
      const wallMaterial = new MeshStandardMaterial({
        color: 0x5e6a60,
        roughness: 1,
        side: DoubleSide,
      });
      disposables.push(wallGeometry, wallMaterial);
      group.add(new Mesh(wallGeometry, wallMaterial));

      const floor = new GridHelper(2.4, 24, 0x5e756c, 0x495c54);
      floor.position.y = -0.027;
      const floorMaterial = floor.material;
      if (!Array.isArray(floorMaterial)) {
        floorMaterial.transparent = true;
        floorMaterial.opacity = 0.2;
      }
      scene.add(floor);
      disposables.push(
        floor.geometry,
        ...(Array.isArray(floorMaterial) ? floorMaterial : [floorMaterial]),
      );

      const outlineGeometry = new BufferGeometry();
      const outlineMaterial = new LineBasicMaterial({
        color: 0xc9efbd,
        transparent: true,
        opacity: 0.8,
      });
      const outline = new LineLoop(outlineGeometry, outlineMaterial);
      group.add(outline);
      disposables.push(outlineGeometry, outlineMaterial);
      const setSelection = (selection: WorldRegion | null) => {
        outline.visible = false;
        if (!selection) return;
        const selected = worldGridBounds(world, selection);
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
          outlineGeometry.setFromPoints([
            new Vector3(sx, verticalSpan + 0.015, sz),
            new Vector3(ex, verticalSpan + 0.015, sz),
            new Vector3(ex, verticalSpan + 0.015, ez),
            new Vector3(sx, verticalSpan + 0.015, ez),
          ]);
          outlineGeometry.computeBoundingSphere();
          outline.visible = true;
        }
      };
      setSelection(initialDisplay.current.region);

      group.scale.y = settingsRef.current.exaggeration;
      const ambient = new AmbientLight(0xffffff, 1.65);
      const key = new DirectionalLight(0xfff6dc, 2.6);
      const fill = new DirectionalLight(0xc8dfef, 0.65);
      fill.position.set(1, 0.5, 1);
      scene.add(ambient, key, fill);
      const setSun = (degrees: number) => {
        const angle = (degrees * Math.PI) / 180;
        key.position.set(Math.sin(angle) * 2, 2.4, -Math.cos(angle) * 2);
      };
      setSun(settingsRef.current.sun);
      scene.background = null;

      const far = Math.max(2000, verticalSpan * 32);
      const perspective = new PerspectiveCamera(39, 1, 0.005, far);
      const ortho = new OrthographicCamera(-1, 1, 1, -1, 0.005, far);
      let camera: PerspectiveCamera | OrthographicCamera = settingsRef.current.orthographic
        ? ortho
        : perspective;
      const target = new Vector3(0, (verticalSpan * settingsRef.current.exaggeration) / 2, 0);
      const resetPosition = () => {
        const box = new Box3().setFromObject(group);
        box.getCenter(target);
        controls?.target.copy(target);
        const sceneSize = box.getSize(new Vector3());
        const distance = Math.max(1.6, sceneSize.length() * 1.6);
        camera.position.set(distance * 0.65, target.y + distance * 0.65, distance * 0.8);
        camera.lookAt(target);
        if (camera instanceof OrthographicCamera) {
          camera.zoom = 1;
          camera.updateProjectionMatrix();
        }
      };
      resetPosition();
      controls = new OrbitControls(camera, renderer.domElement);
      controls.target.copy(target);
      if (savedView.current?.footprint === footprint) {
        camera.position.fromArray(savedView.current.position);
        controls.target.fromArray(savedView.current.target);
        if (camera instanceof OrthographicCamera) {
          camera.zoom = savedView.current.zoom;
          camera.updateProjectionMatrix();
        }
      }
      cleanups.push(() => {
        if (controls)
          savedView.current = {
            footprint,
            position: [camera.position.x, camera.position.y, camera.position.z],
            target: [controls.target.x, controls.target.y, controls.target.z],
            zoom: camera instanceof OrthographicCamera ? camera.zoom : 1,
          };
      });
      controls.enableDamping = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      controls.dampingFactor = 0.12;
      controls.minDistance = 0.08;
      controls.maxDistance = Math.max(1000, verticalSpan * 64);
      controls.minZoom = 0.2;
      controls.maxZoom = 24;
      controls.maxPolarAngle = Math.PI * 0.49;
      controls.screenSpacePanning = true;
      const render = () => {
        frame = 0;
        if (disposed || !renderer || !controls) return;
        const changed = controls.update();
        renderer.render(scene, camera);
        renderer.domElement.dataset.rendered = 'true';
        if (changed) requestRender();
      };
      const requestRender = () => {
        if (!disposed && !frame) frame = requestAnimationFrame(render);
      };
      controls.addEventListener('change', requestRender);
      cleanups.push(() => controls?.removeEventListener('change', requestRender));
      const resize = () => {
        if (!renderer) return;
        const width = Math.max(1, element.clientWidth),
          height = Math.max(1, element.clientHeight);
        renderer.setSize(width, height, false);
        perspective.aspect = width / height;
        perspective.updateProjectionMatrix();
        ortho.left = (-width / height) * 0.9;
        ortho.right = (width / height) * 0.9;
        ortho.top = 0.9;
        ortho.bottom = -0.9;
        ortho.updateProjectionMatrix();
        requestRender();
      };
      observer = new ResizeObserver(resize);
      observer.observe(element);
      resize();
      controlsRef.current = {
        reset: () => {
          controls?.target.copy(target);
          resetPosition();
          controls?.update();
          requestRender();
        },
        exaggeration: (value) => {
          group.scale.y = value;
          requestRender();
        },
        wireframe: (value) => {
          material.wireframe = value;
          requestRender();
        },
        sun: (value) => {
          setSun(value);
          requestRender();
        },
        projection: (useOrtho) => {
          const previous = camera;
          camera = useOrtho ? ortho : perspective;
          camera.position.copy(previous.position);
          camera.quaternion.copy(previous.quaternion);
          if (controls) controls.object = camera;
          resize();
          requestRender();
        },
        layer: (nextLayer, nextScale) => {
          image.data.set(
            worldMapPixels(snapshot, nextLayer === 'relief' ? 'elevation' : nextLayer, nextScale),
          );
          context.putImageData(image, 0, 0);
          texture.needsUpdate = true;
          requestRender();
        },
        selection: (selection) => {
          setSelection(selection);
          requestRender();
        },
      };
      requestRender();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The 3D terrain view could not start.');
      dispose();
    }
    return dispose;
  }, [snapshot, active, retry]);

  useEffect(() => {
    controlsRef.current?.layer(layer, scale);
  }, [layer, scale]);
  useEffect(() => {
    controlsRef.current?.selection(region);
  }, [region]);

  return (
    <section className="wv-terrain" aria-label="World terrain view">
      <div className="wv-terrain-canvas" ref={host} />
      <div className="wv-terrain-tag">
        <Mountain size={13} />
        <span>Physical terrain</span>
        <span className="wv-tag-detail">
          {formatWorldDistance(worldGridBounds(snapshot.world, snapshot.grid).width)} ×{' '}
          {formatWorldDistance(worldGridBounds(snapshot.world, snapshot.grid).depth)}
        </span>
      </div>
      {error ? (
        <div className="wv-3d-error" role="alert">
          <TriangleAlert size={25} />
          <strong>3D view unavailable</strong>
          <p>{error}</p>
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            <RotateCcw size={14} /> Retry 3D
          </button>
        </div>
      ) : (
        <>
          <div className="wv-terrain-tools" aria-label="Terrain view controls">
            <button
              type="button"
              title="Reset terrain camera"
              aria-label="Reset terrain camera"
              onClick={() => controlsRef.current?.reset()}
            >
              <Focus size={15} />
            </button>
            <button
              type="button"
              title="Orthographic projection"
              aria-label="Orthographic projection"
              aria-pressed={orthographic}
              onClick={() => {
                setOrthographic(!orthographic);
                controlsRef.current?.projection(!orthographic);
              }}
            >
              <Box size={15} />
            </button>
            <button
              type="button"
              title="Show terrain wireframe"
              aria-label="Show terrain wireframe"
              aria-pressed={wireframe}
              onClick={() => {
                setWireframe(!wireframe);
                controlsRef.current?.wireframe(!wireframe);
              }}
            >
              <span className="wv-wire-icon">△</span>
            </button>
          </div>
          <div className="wv-terrain-settings">
            <label>
              <Mountain size={13} />
              <span>Vertical scale</span>
              <input
                aria-label="Terrain vertical exaggeration"
                type="range"
                min="0.25"
                max="4"
                step="0.25"
                value={exaggeration}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  setExaggeration(value);
                  controlsRef.current?.exaggeration(value);
                }}
              />
              <output>{exaggeration.toFixed(2).replace(/\.00$/, '')}×</output>
            </label>
            <label>
              <Sun size={13} />
              <span>Sun azimuth</span>
              <input
                aria-label="Terrain sun azimuth"
                type="range"
                min="0"
                max="360"
                step="5"
                value={sun}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  setSun(value);
                  controlsRef.current?.sun(value);
                }}
              />
              <output>{sun}°</output>
            </label>
          </div>
          <p className="wv-terrain-help">
            Drag to orbit · right drag to pan · scroll to zoom
            <span>Display mesh ≤ 257 × 257 samples</span>
          </p>
        </>
      )}
    </section>
  );
}
