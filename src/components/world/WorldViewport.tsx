import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import {
  ArrowDown,
  Box,
  ChevronDown,
  Compass,
  Focus,
  Grid2X2,
  Hand,
  Layers,
  LoaderCircle,
  Map as MapIcon,
  Maximize,
  Minus,
  MousePointer2,
  Plus,
  Scan,
  SplitSquareHorizontal,
  X,
} from 'lucide-react';
import type { WorldRegionResult } from '../../engine/world';
import type { WorldGridRequest } from '../../hooks/worldProtocol';
import type { WorldDefinition } from '../../model/world';
import type { TerrainProject } from '../../model/types';
import {
  WORLD_LAYERS,
  canCompareWorldSnapshots,
  clamp,
  fitWorldCamera,
  formatWorldDistance,
  frameWorldRegion,
  niceWorldDistance,
  sampleWorldProbe,
  screenToWorld,
  shiftWorldRegion,
  tileAtWorldPoint,
  unionWorldRegions,
  visibleWorldRegion,
  worldDifferenceRange,
  worldGridBounds,
  worldLayerScale,
  worldMapPixels,
  worldMapScale,
  zoomWorldCamera,
} from './worldViewMath';
import type {
  ViewSize,
  WorldCamera,
  WorldLayer,
  WorldLayerScale,
  WorldProbe,
  WorldRegion,
  WorldSnapshot,
  WorldViewMode,
} from './worldViewMath';
import { WorldTerrain3D } from './WorldTerrain3D';
import './WorldViewport.css';

export interface WorldViewportProps {
  materialProject?: TerrainProject | null;
  result: WorldRegionResult | null;
  world: WorldDefinition;
  grid: WorldGridRequest | null;
  overview?: WorldSnapshot | null;
  region: WorldRegion | null;
  onRegionChange: (region: WorldRegion | null) => void;
  layer: WorldLayer;
  onLayerChange: (layer: WorldLayer) => void;
  mode: WorldViewMode;
  onModeChange: (mode: WorldViewMode) => void;
  busy: boolean;
  stale: boolean;
  onRefine: () => void;
  onOverview: () => void;
  comparison?: WorldSnapshot | null;
  compareMode?: 'off' | 'wipe' | 'difference';
  onProbe?: (probe: WorldProbe | null) => void;
  frameRequest?: number;
  active?: boolean;
  onViewRegionChange?: (region: WorldRegion | null) => void;
}

interface RasterProps {
  snapshot: WorldSnapshot;
  layer: WorldLayer;
  scale: WorldLayerScale;
  difference?: { snapshot: WorldSnapshot; max: number };
  className?: string;
}

// The overview and navigator share the same real raster. Keep only two color variants per
// field; weak keys release complete rasters when their bounded terrain snapshot is released.
const rasterCache = new WeakMap<WorldRegionResult, Map<string, Uint8ClampedArray>>();
function rasterPixels(
  snapshot: WorldSnapshot,
  layer: WorldLayer,
  scale: WorldLayerScale,
  difference?: RasterProps['difference'],
) {
  if (difference) return worldMapPixels(snapshot, layer, scale, difference);
  const key = `${layer}/${snapshot.world.domain.heightScale}/${snapshot.world.domain.datum}/${scale.min}/${scale.max}/${scale.flow}/${scale.wear}/${scale.deposition}`;
  let entries = rasterCache.get(snapshot.result);
  const cached = entries?.get(key);
  if (cached) return cached;
  const pixels = worldMapPixels(snapshot, layer, scale);
  if (!entries) {
    entries = new Map();
    rasterCache.set(snapshot.result, entries);
  }
  if (entries.size >= 2) entries.delete(entries.keys().next().value!);
  entries.set(key, pixels);
  return pixels;
}

function WorldRaster({ snapshot, layer, scale, difference, className = '' }: RasterProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const surface = canvas.current;
    if (!surface) return;
    surface.width = snapshot.result.width;
    surface.height = snapshot.result.height;
    const context = surface.getContext('2d');
    if (!context) return;
    const image = context.createImageData(surface.width, surface.height);
    image.data.set(rasterPixels(snapshot, layer, scale, difference));
    context.putImageData(image, 0, 0);
  }, [
    snapshot.result,
    snapshot.world.domain.heightScale,
    snapshot.world.domain.datum,
    layer,
    scale,
    difference,
  ]);
  return (
    <canvas
      ref={canvas}
      className={`wv-raster ${className}`}
      aria-label={`${difference ? 'Elevation change' : WORLD_LAYERS.find((item) => item.id === layer)?.label} sampled terrain`}
    />
  );
}

const wholeRegion = (world: WorldDefinition): WorldRegion => ({
  startX: 0,
  startZ: 0,
  cellsX: world.domain.cellsX,
  cellsZ: world.domain.cellsZ,
});
const sameRegion = (a: WorldRegion, b: WorldRegion) =>
  a.startX === b.startX && a.startZ === b.startZ && a.cellsX === b.cellsX && a.cellsZ === b.cellsZ;
const numeric = (value: number, digits = 1) =>
  value.toLocaleString('en-US', { maximumFractionDigits: digits });
function regionStyle(region: WorldRegion, world: WorldDefinition): CSSProperties {
  return {
    left: `${(region.startX / world.domain.cellsX) * 100}%`,
    top: `${(region.startZ / world.domain.cellsZ) * 100}%`,
    width: `${(region.cellsX / world.domain.cellsX) * 100}%`,
    height: `${(region.cellsZ / world.domain.cellsZ) * 100}%`,
  };
}

function Legend({
  layer,
  scale,
  difference,
  comparing = false,
}: {
  layer: WorldLayer;
  scale: WorldLayerScale;
  difference?: number;
  comparing?: boolean;
}) {
  const description = WORLD_LAYERS.find((item) => item.id === layer)?.label ?? layer;
  let low = `${numeric(scale.min, 0)} m`,
    high = `${numeric(scale.max, 0)} m`;
  let note = comparing ? 'Shared comparison range' : 'Overview elevation range';
  if (layer === 'slope') {
    low = '0°';
    high = '90°';
    note = 'Physical slope';
  }
  if (layer === 'aspect') {
    low = 'N';
    high = 'N';
    note = 'N · E · S · W · N';
  }
  if (layer === 'flow') {
    low = 'Low';
    high = scale.flow > 0 ? 'High' : 'No flow';
    note = 'Relative flow · logarithmic';
  }
  if (layer === 'wear') {
    low = '0';
    high = numeric(scale.wear, 4);
    note = 'Relative erosion signal';
  }
  if (layer === 'deposition') {
    low = '0';
    high = numeric(scale.deposition, 4);
    note = 'Relative deposition signal';
  }
  if (layer === 'contours')
    note = `${formatWorldDistance(niceWorldDistance((scale.max - scale.min) / 12))} contour interval`;
  if (difference !== undefined) {
    low = `−${numeric(difference, 2)} m`;
    high = `+${numeric(difference, 2)} m`;
    note = 'Removed ← elevation change → added';
  }
  return (
    <div
      className="wv-legend"
      aria-label={`${difference !== undefined ? 'Elevation change' : description} legend`}
    >
      <div>
        <span>{difference !== undefined ? 'Elevation change' : description}</span>
        <small>{note}</small>
      </div>
      <div
        className={`wv-legend-ramp wv-ramp-${difference !== undefined ? 'difference' : layer}`}
      />
      <div className="wv-legend-range">
        <span>{low}</span>
        <span>{high}</span>
      </div>
    </div>
  );
}

export function WorldViewport({
  materialProject,
  result,
  world,
  grid,
  overview = null,
  region,
  onRegionChange,
  layer,
  onLayerChange,
  mode,
  onModeChange,
  busy,
  stale,
  onRefine,
  onOverview,
  comparison = null,
  compareMode = 'off',
  onProbe,
  frameRequest = 0,
  active = true,
  onViewRegionChange,
}: WorldViewportProps) {
  const map = useRef<HTMLDivElement>(null);
  const layerMenu = useRef<HTMLDivElement>(null);
  const layerTrigger = useRef<HTMLButtonElement>(null);
  const [size, setSize] = useState<ViewSize>({ width: 800, height: 600 });
  const [camera, setCamera] = useState<WorldCamera>(() => fitWorldCamera(world));
  const [gridVisible, setGridVisible] = useState(true);
  const [tool, setTool] = useState<'select' | 'pan'>('select');
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState<WorldRegion | null>(null);
  const [probe, setProbe] = useState<WorldProbe | null>(null);
  const [wipe, setWipe] = useState(50);
  const [helpVisible, setHelpVisible] = useState(false);
  const [layersVisible, setLayersVisible] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{
    kind: 'pan' | 'select' | 'pinch';
    point: { x: number; y: number };
    camera: WorldCamera;
    start: WorldRegion | null;
    extend: WorldRegion | null;
    distance?: number;
    moved: boolean;
    touch?: boolean;
  } | null>(null);
  const hoverFrame = useRef(0);
  const lastProbeTime = useRef(0);
  const onProbeRef = useRef(onProbe);
  onProbeRef.current = onProbe;
  const viewRegionCallback = useRef(onViewRegionChange);
  viewRegionCallback.current = onViewRegionChange;
  const lastViewRegion = useRef('overview');
  const snapshot = useMemo<WorldSnapshot | null>(
    () => (result && grid ? { result, world, grid } : null),
    [result, world, grid],
  );
  const usableOverview = useMemo(() => {
    if (!overview) return null;
    const a = overview.world.domain,
      b = world.domain;
    return a.originX === b.originX &&
      a.originZ === b.originZ &&
      a.width === b.width &&
      a.depth === b.depth &&
      a.cellsX === b.cellsX &&
      a.cellsZ === b.cellsZ
      ? overview
      : null;
  }, [overview, world]);
  const compatibleComparison = Boolean(
    snapshot && comparison && canCompareWorldSnapshots(snapshot, comparison),
  );
  const scaleSnapshot = usableOverview ?? snapshot;
  const baseScale = useMemo(
    () =>
      scaleSnapshot
        ? worldLayerScale(scaleSnapshot)
        : { min: 0, max: 0, flow: 0, wear: 0, deposition: 0 },
    [
      scaleSnapshot?.result,
      scaleSnapshot?.world.domain.heightScale,
      scaleSnapshot?.world.domain.datum,
    ],
  );
  const comparisonScale = useMemo(
    () => (comparison ? worldLayerScale(comparison) : null),
    [comparison?.result, comparison?.world.domain.heightScale, comparison?.world.domain.datum],
  );
  const scale = useMemo(() => {
    if (!comparisonScale || !compatibleComparison || compareMode === 'off') return baseScale;
    return {
      min: Math.min(baseScale.min, comparisonScale.min),
      max: Math.max(baseScale.max, comparisonScale.max),
      flow: Math.max(baseScale.flow, comparisonScale.flow),
      wear: Math.max(baseScale.wear, comparisonScale.wear),
      deposition: Math.max(baseScale.deposition, comparisonScale.deposition),
    };
  }, [baseScale, comparisonScale, compatibleComparison, compareMode]);
  const difference = useMemo(
    () =>
      snapshot && comparison && compatibleComparison && compareMode === 'difference'
        ? { snapshot: comparison, max: worldDifferenceRange(snapshot, comparison) }
        : undefined,
    [snapshot, comparison, compatibleComparison, compareMode],
  );
  const showingWipe = compatibleComparison && compareMode === 'wipe';
  const detail = Boolean(grid && !sameRegion(grid, wholeRegion(world)));
  const domainKey = `${world.domain.originX}/${world.domain.originZ}/${world.domain.width}/${world.domain.depth}`;
  const previousDomain = useRef(domainKey);
  const previousFrame = useRef(frameRequest);
  const scalePx = worldMapScale(world, size, camera.zoom);
  const origin = {
    x: size.width / 2 + (world.domain.originX - camera.centerX) * scalePx,
    y: size.height / 2 + (world.domain.originZ - camera.centerZ) * scalePx,
  };
  const planeWidth = world.domain.width * scalePx,
    planeHeight = world.domain.depth * scalePx;
  const scaleLength = niceWorldDistance(Math.min(110, size.width * 0.2) / scalePx);

  useEffect(() => {
    if (previousDomain.current !== domainKey) {
      previousDomain.current = domainKey;
      setCamera(fitWorldCamera(world));
      setHovered(null);
      setProbe(null);
      onProbeRef.current?.(null);
    }
  }, [domainKey, world]);
  useEffect(() => {
    cancelAnimationFrame(hoverFrame.current);
    setProbe(null);
    setHovered(null);
    onProbeRef.current?.(null);
  }, [result]);
  useEffect(() => {
    if (previousFrame.current === frameRequest) return;
    previousFrame.current = frameRequest;
    setCamera(region ? frameWorldRegion(region, world, size) : fitWorldCamera(world));
  }, [frameRequest, region, world, size]);
  useEffect(() => {
    if (!active) return;
    const element = map.current;
    if (!element) return;
    const measure = () =>
      setSize({
        width: Math.max(1, element.clientWidth),
        height: Math.max(1, element.clientHeight),
      });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [active, mode]);
  useEffect(
    () => () => {
      cancelAnimationFrame(hoverFrame.current);
    },
    [],
  );
  useEffect(() => {
    if (!layersVisible) return;
    const close = (event: globalThis.PointerEvent) => {
      if (!layerMenu.current?.contains(event.target as Node)) setLayersVisible(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [layersVisible]);
  useEffect(() => {
    if (stale) {
      lastViewRegion.current = '';
      return;
    }
    if (!active || mode === 'terrain') return;
    const timer = window.setTimeout(() => {
      const visible = visibleWorldRegion(camera, world, size);
      const key = visible
        ? `${visible.startX}/${visible.startZ}/${visible.cellsX}/${visible.cellsZ}`
        : 'overview';
      if (lastViewRegion.current === key) return;
      const wasDetail = lastViewRegion.current !== '' && lastViewRegion.current !== 'overview';
      lastViewRegion.current = key;
      // An initial fit is already owned by the preview hook. Do not restart an overview
      // after the user cancels merely because layout finishes measuring the viewport.
      if (visible || wasDetail) viewRegionCallback.current?.(visible);
    }, 350);
    return () => window.clearTimeout(timer);
    // Samples and layer changes must not request another build. Only a settled camera does.
  }, [
    camera.centerX,
    camera.centerZ,
    camera.zoom,
    size.width,
    size.height,
    domainKey,
    world.domain.cellsX,
    world.domain.cellsZ,
    active,
    mode,
    stale,
  ]);
  useEffect(() => {
    if (!active) {
      setSpaceHeld(false);
      setDragging(false);
      gesture.current = null;
      pointers.current.clear();
    }
  }, [active]);

  const localPoint = (clientX: number, clientY: number) => {
    const rect = map.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  };
  const zoom = useCallback(
    (factor: number, point = { x: size.width / 2, y: size.height / 2 }) => {
      setCamera((current) => zoomWorldCamera(current, factor, point, world, size));
    },
    [world, size],
  );
  useEffect(() => {
    const element = map.current;
    if (!element || !active) return;
    const wheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest('button,input,select,[data-map-control]')) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1;
      zoom(Math.exp(-clamp(event.deltaY * unit, -180, 180) * 0.0035), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [zoom, active, mode, size.height]);

  const updateProbe = (point: { x: number; y: number }) => {
    const position = screenToWorld(point, camera, world, size);
    const next = snapshot
      ? (sampleWorldProbe(snapshot, position.x, position.z) ??
        (usableOverview ? sampleWorldProbe(usableOverview, position.x, position.z) : null))
      : null;
    cancelAnimationFrame(hoverFrame.current);
    hoverFrame.current = requestAnimationFrame(() => {
      setProbe(next);
      setHovered(
        tool === 'select' && !spaceHeld ? tileAtWorldPoint(position.x, position.z, world) : null,
      );
      if (performance.now() - lastProbeTime.current > 80 || !next) {
        lastProbeTime.current = performance.now();
        onProbeRef.current?.(next);
      }
    });
  };
  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      (event.target as HTMLElement).closest('button,input,select,[data-map-control]') ||
      event.button > 2
    )
      return;
    event.preventDefault();
    map.current?.focus({ preventScroll: true });
    map.current?.setPointerCapture(event.pointerId);
    const point = localPoint(event.clientX, event.clientY);
    pointers.current.set(event.pointerId, point);
    setDragging(true);
    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = {
        kind: 'pinch',
        point: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        camera,
        start: null,
        extend: null,
        moved: true,
      };
      return;
    }
    const position = screenToWorld(point, camera, world, size);
    const tile = tileAtWorldPoint(position.x, position.z, world);
    const pan =
      event.button === 1 ||
      event.button === 2 ||
      spaceHeld ||
      tool === 'pan' ||
      event.pointerType === 'touch';
    gesture.current = {
      kind: pan ? 'pan' : 'select',
      point,
      camera,
      start: tile,
      extend: event.shiftKey ? region : null,
      moved: false,
      touch: event.pointerType === 'touch',
    };
    if (!pan)
      onRegionChange(tile && event.shiftKey && region ? unionWorldRegions(region, tile) : tile);
    updateProbe(point);
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const point = localPoint(event.clientX, event.clientY);
    if (pointers.current.has(event.pointerId)) pointers.current.set(event.pointerId, point);
    const current = gesture.current;
    if (current && pointers.current.has(event.pointerId)) {
      if (Math.hypot(point.x - current.point.x, point.y - current.point.y) > 4)
        current.moved = true;
      if (current.kind === 'pinch' && pointers.current.size >= 2) {
        const [a, b] = [...pointers.current.values()];
        const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const next = zoomWorldCamera(
          current.camera,
          Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, current.distance ?? 1),
          current.point,
          world,
          size,
        );
        const nextScale = worldMapScale(world, size, next.zoom);
        next.centerX -= (midpoint.x - current.point.x) / nextScale;
        next.centerZ -= (midpoint.y - current.point.y) / nextScale;
        setCamera(next);
      } else if (current.kind === 'pan') {
        const startScale = worldMapScale(world, size, current.camera.zoom);
        setCamera({
          ...current.camera,
          centerX: current.camera.centerX - (point.x - current.point.x) / startScale,
          centerZ: current.camera.centerZ - (point.y - current.point.y) / startScale,
        });
      } else if (current.kind === 'select' && current.start) {
        const position = screenToWorld(point, camera, world, size);
        const d = world.domain;
        const tile = tileAtWorldPoint(
          clamp(position.x, d.originX, d.originX + d.width),
          clamp(position.z, d.originZ, d.originZ + d.depth),
          world,
        );
        if (tile) {
          const selected = unionWorldRegions(current.start, tile);
          onRegionChange(current.extend ? unionWorldRegions(current.extend, selected) : selected);
        }
      }
    }
    updateProbe(point);
  };
  const pointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    pointers.current.delete(event.pointerId);
    if (
      event.type !== 'pointercancel' &&
      current?.kind === 'pan' &&
      current.touch &&
      !current.moved &&
      tool === 'select'
    )
      onRegionChange(current.start);
    if (map.current?.hasPointerCapture(event.pointerId))
      map.current.releasePointerCapture(event.pointerId);
    if (pointers.current.size === 1) {
      const [point] = [...pointers.current.values()];
      gesture.current = {
        kind: 'pan',
        point,
        camera,
        start: null,
        extend: null,
        moved: true,
        touch: true,
      };
    } else {
      gesture.current = null;
      setDragging(false);
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('input,select,button')) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.code === 'Space') {
      event.preventDefault();
      setSpaceHeld(true);
      return;
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const moved = shiftWorldRegion(
        region,
        event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0,
        event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0,
        world,
      );
      onRegionChange(event.shiftKey && region ? unionWorldRegions(region, moved) : moved);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setCamera(fitWorldCamera(world));
    } else if (event.key.toLowerCase() === 'f') {
      event.preventDefault();
      setCamera(region ? frameWorldRegion(region, world, size) : fitWorldCamera(world));
    } else if (event.key.toLowerCase() === 'g' && event.shiftKey) {
      event.preventDefault();
      setGridVisible((value) => !value);
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoom(1.5);
    } else if (event.key === '-') {
      event.preventDefault();
      zoom(1 / 1.5);
    } else if (event.key === 'Escape') {
      onRegionChange(null);
      setLayersVisible(false);
      setHelpVisible(false);
    } else if (event.key === 'Enter' && region && !busy && !stale) {
      event.preventDefault();
      onRefine();
    } else if (event.key === '?') {
      event.preventDefault();
      setHelpVisible((value) => !value);
    }
  };
  const gridLines = useMemo(() => {
    const xStride = Math.max(
      1,
      Math.ceil(20 / ((planeWidth * world.tileCells) / world.domain.cellsX)),
    );
    const zStride = Math.max(
      1,
      Math.ceil(20 / ((planeHeight * world.tileCells) / world.domain.cellsZ)),
    );
    const x: number[] = [],
      z: number[] = [];
    const topLeft = screenToWorld({ x: 0, y: 0 }, camera, world, size);
    const bottomRight = screenToWorld({ x: size.width, y: size.height }, camera, world, size);
    const xStep = world.tileCells * xStride,
      zStep = world.tileCells * zStride;
    const xStart = Math.max(
      xStep,
      Math.floor(
        (((topLeft.x - world.domain.originX) / world.domain.width) * world.domain.cellsX) / xStep,
      ) * xStep,
    );
    const zStart = Math.max(
      zStep,
      Math.floor(
        (((topLeft.z - world.domain.originZ) / world.domain.depth) * world.domain.cellsZ) / zStep,
      ) * zStep,
    );
    const xEnd = Math.min(
      world.domain.cellsX,
      Math.ceil(
        ((bottomRight.x - world.domain.originX) / world.domain.width) * world.domain.cellsX,
      ),
    );
    const zEnd = Math.min(
      world.domain.cellsZ,
      Math.ceil(
        ((bottomRight.z - world.domain.originZ) / world.domain.depth) * world.domain.cellsZ,
      ),
    );
    for (let cell = xStart; cell < xEnd && x.length < 160; cell += xStep) x.push(cell);
    for (let cell = zStart; cell < zEnd && z.length < 160; cell += zStep) z.push(cell);
    return { x, z };
  }, [world, planeWidth, planeHeight, camera, size]);
  const minimapViewport = {
    left: clamp(
      ((camera.centerX - size.width / scalePx / 2 - world.domain.originX) / world.domain.width) *
        100,
      0,
      100,
    ),
    top: clamp(
      ((camera.centerZ - size.height / scalePx / 2 - world.domain.originZ) / world.domain.depth) *
        100,
      0,
      100,
    ),
    right: clamp(
      ((camera.centerX + size.width / scalePx / 2 - world.domain.originX) / world.domain.width) *
        100,
      0,
      100,
    ),
    bottom: clamp(
      ((camera.centerZ + size.height / scalePx / 2 - world.domain.originZ) / world.domain.depth) *
        100,
      0,
      100,
    ),
  };
  const layerLabel = WORLD_LAYERS.find((item) => item.id === layer)?.label;
  const selectedBounds = region ? worldGridBounds(world, region) : null;
  const noDiagnostic =
    layer === 'flow'
      ? scale.flow === 0
      : layer === 'wear'
        ? scale.wear === 0
        : layer === 'deposition'
          ? scale.deposition === 0
          : false;

  return (
    <section
      className={`world-viewport wv-mode-${mode}`}
      aria-label="World viewport"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        if (layersVisible) {
          event.preventDefault();
          setLayersVisible(false);
          layerTrigger.current?.focus();
        }
        if (helpVisible) {
          event.preventDefault();
          setHelpVisible(false);
        }
      }}
    >
      <div className="wv-toolbar">
        <div className="wv-view-switch" role="group" aria-label="World view mode">
          <button type="button" aria-pressed={mode === 'map'} onClick={() => onModeChange('map')}>
            <MapIcon size={14} />
            <span>Map</span>
          </button>
          <button
            type="button"
            aria-pressed={mode === 'terrain'}
            onClick={() => onModeChange('terrain')}
          >
            <Box size={14} />
            <span>Terrain</span>
          </button>
          <button
            type="button"
            aria-pressed={mode === 'split'}
            onClick={() => onModeChange('split')}
          >
            <SplitSquareHorizontal size={14} />
            <span>Split</span>
          </button>
        </div>
        <div className="wv-layer-menu" ref={layerMenu}>
          <button
            type="button"
            ref={layerTrigger}
            className="wv-layer-trigger"
            aria-expanded={layersVisible}
            aria-controls="world-layer-menu"
            onClick={() => setLayersVisible((value) => !value)}
          >
            <Layers size={14} />
            <span>{layerLabel}</span>
            <ChevronDown size={12} />
          </button>
          {layersVisible && (
            <div
              id="world-layer-menu"
              className="wv-layer-options"
              role="group"
              aria-label="Terrain layers"
            >
              {WORLD_LAYERS.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  aria-pressed={layer === item.id}
                  onClick={() => {
                    onLayerChange(item.id);
                    setLayersVisible(false);
                  }}
                >
                  <span>{item.label}</span>
                  <small>{item.description}</small>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="wv-toolbar-spacer" />
        {busy ? (
          <span className="wv-quality wv-quality-busy">
            <LoaderCircle size={12} className="wv-spin" />
            <span>Building</span>
          </span>
        ) : stale ? (
          <span className="wv-quality wv-quality-stale">
            <span className="wv-status-dot" />
            Previous revision
          </span>
        ) : snapshot ? (
          <span className="wv-quality">
            <span className="wv-status-dot" />
            {detail ? 'Region detail' : 'World overview'}
            <small>
              {result?.width} × {result?.height}
            </small>
          </span>
        ) : null}
        <button
          type="button"
          className="wv-shortcuts-button"
          aria-label="Map keyboard shortcuts"
          aria-expanded={helpVisible}
          onClick={() => setHelpVisible((value) => !value)}
        >
          ?
        </button>
      </div>
      {helpVisible && (
        <div className="wv-shortcuts" role="region" aria-label="Map keyboard shortcuts">
          <div>
            <strong>Move around your world</strong>
            <button
              type="button"
              aria-label="Close keyboard shortcuts"
              onClick={() => setHelpVisible(false)}
            >
              <X size={14} />
            </button>
          </div>
          <dl>
            <dt>Zoom at cursor</dt>
            <dd>Scroll / pinch</dd>
            <dt>Pan</dt>
            <dd>Space + drag / middle drag</dd>
            <dt>Select tiles</dt>
            <dd>Click / drag</dd>
            <dt>Extend selection</dt>
            <dd>Shift + click / arrows</dd>
            <dt>Move selection</dt>
            <dd>Arrow keys</dd>
            <dt>Frame selection</dt>
            <dd>F</dd>
            <dt>Show whole world</dt>
            <dd>Home</dd>
            <dt>Refine selection</dt>
            <dd>Enter</dd>
            <dt>Toggle tile grid</dt>
            <dd>Shift + G</dd>
            <dt>Clear selection</dt>
            <dd>Esc</dd>
          </dl>
        </div>
      )}
      <div className="wv-content">
        {mode !== 'terrain' && (
          <div className="wv-map-pane">
            <div
              className={`wv-map ${tool === 'pan' || spaceHeld ? 'wv-tool-pan' : ''} ${dragging ? 'wv-dragging' : ''}`}
              ref={map}
              role="region"
              tabIndex={0}
              aria-label="Interactive world map"
              aria-describedby="world-map-instructions"
              onPointerDown={pointerDown}
              onPointerMove={pointerMove}
              onPointerUp={pointerEnd}
              onPointerCancel={pointerEnd}
              onPointerLeave={() => {
                if (!gesture.current) {
                  setHovered(null);
                  setProbe(null);
                  onProbeRef.current?.(null);
                }
              }}
              onKeyDown={keyDown}
              onKeyUp={(event) => {
                if (event.code === 'Space') {
                  setSpaceHeld(false);
                  event.preventDefault();
                }
              }}
              onBlur={() => setSpaceHeld(false)}
              onContextMenu={(event) => event.preventDefault()}
              onDoubleClick={(event) => {
                if (!(event.target as HTMLElement).closest('button,input,[data-map-control]'))
                  zoom(1.8, localPoint(event.clientX, event.clientY));
              }}
            >
              {snapshot ? (
                <>
                  <div
                    className="wv-plane"
                    style={{
                      left: origin.x,
                      top: origin.y,
                      width: planeWidth,
                      height: planeHeight,
                    }}
                  >
                    {usableOverview && (detail || usableOverview.result !== result) && (
                      <div className="wv-field" style={regionStyle(usableOverview.grid, world)}>
                        <WorldRaster snapshot={usableOverview} layer={layer} scale={scale} />
                      </div>
                    )}
                    <div
                      className={`wv-field ${detail ? 'wv-detail-field' : ''}`}
                      style={regionStyle(snapshot.grid, world)}
                    >
                      <WorldRaster
                        snapshot={snapshot}
                        layer={layer}
                        scale={scale}
                        difference={difference}
                      />
                      {showingWipe && comparison && (
                        <div
                          className="wv-before-field"
                          style={{ clipPath: `inset(0 ${100 - wipe}% 0 0)` }}
                        >
                          <WorldRaster snapshot={comparison} layer={layer} scale={scale} />
                        </div>
                      )}
                      {showingWipe && <div className="wv-wipe-line" style={{ left: `${wipe}%` }} />}
                    </div>
                    {gridVisible && (
                      <svg
                        className="wv-grid"
                        viewBox={`0 0 ${world.domain.cellsX} ${world.domain.cellsZ}`}
                        preserveAspectRatio="none"
                        aria-hidden="true"
                      >
                        {gridLines.x.map((value) => (
                          <line
                            key={`x${value}`}
                            x1={value}
                            y1="0"
                            x2={value}
                            y2={world.domain.cellsZ}
                          />
                        ))}
                        {gridLines.z.map((value) => (
                          <line
                            key={`z${value}`}
                            x1="0"
                            y1={value}
                            x2={world.domain.cellsX}
                            y2={value}
                          />
                        ))}
                      </svg>
                    )}
                    {hovered && !dragging && (!region || !sameRegion(hovered, region)) && (
                      <div className="wv-hover-tile" style={regionStyle(hovered, world)} />
                    )}
                    {region && (
                      <div className="wv-selected-region" style={regionStyle(region, world)}>
                        <i className="wv-corner nw" />
                        <i className="wv-corner ne" />
                        <i className="wv-corner sw" />
                        <i className="wv-corner se" />
                        {(region.cellsX / world.domain.cellsX) * planeWidth > 88 && (
                          <span className="wv-selection-label">Selection</span>
                        )}
                      </div>
                    )}
                    <div className="wv-world-edge-label">
                      {formatWorldDistance(world.domain.width)} ×{' '}
                      {formatWorldDistance(world.domain.depth)}
                    </div>
                  </div>
                  <div
                    className="wv-map-tools"
                    role="group"
                    aria-label="Map tools"
                    data-map-control
                  >
                    <button
                      type="button"
                      aria-label="Select terrain regions"
                      title="Select terrain regions"
                      aria-pressed={tool === 'select'}
                      onClick={() => setTool('select')}
                    >
                      <MousePointer2 size={16} />
                    </button>
                    <button
                      type="button"
                      aria-label="Pan world map"
                      title="Pan map · Space + drag"
                      aria-pressed={tool === 'pan'}
                      onClick={() => setTool('pan')}
                    >
                      <Hand size={16} />
                    </button>
                    <span />
                    <button
                      type="button"
                      aria-label="Zoom in"
                      title="Zoom in"
                      onClick={() => zoom(1.5)}
                    >
                      <Plus size={16} />
                    </button>
                    <button
                      type="button"
                      aria-label="Zoom out"
                      title="Zoom out"
                      onClick={() => zoom(1 / 1.5)}
                    >
                      <Minus size={16} />
                    </button>
                    <button
                      type="button"
                      aria-label="Fit whole world"
                      title="Fit world · Home"
                      onClick={() => setCamera(fitWorldCamera(world))}
                    >
                      <Maximize size={16} />
                    </button>
                    <span />
                    <button
                      type="button"
                      aria-label="Show tile grid"
                      title="Tile grid · Shift + G"
                      aria-pressed={gridVisible}
                      onClick={() => setGridVisible((value) => !value)}
                    >
                      <Grid2X2 size={16} />
                    </button>
                  </div>
                  <div className="wv-north" aria-label="North is up">
                    <span>N</span>
                    <Compass size={28} strokeWidth={1.2} />
                    <small>+Z south</small>
                  </div>
                  {detail && (
                    <button
                      type="button"
                      className="wv-overview-button"
                      onClick={() => {
                        onOverview();
                        setCamera(fitWorldCamera(world));
                      }}
                      data-map-control
                    >
                      <MapIcon size={13} />
                      World overview
                    </button>
                  )}
                  <div className="wv-scale" style={{ width: scaleLength * scalePx }}>
                    <span>{formatWorldDistance(scaleLength)}</span>
                    <i />
                  </div>
                  <div className="wv-map-zoom">{numeric(camera.zoom * 100, 0)}%</div>
                  <button
                    type="button"
                    className="wv-minimap"
                    aria-label="World navigator: click to recenter map"
                    title="Click to recenter · double-click to fit world"
                    style={{ aspectRatio: `${world.domain.width} / ${world.domain.depth}` }}
                    data-map-control
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      if (event.detail === 0) {
                        setCamera(fitWorldCamera(world));
                        return;
                      }
                      setCamera((current) => ({
                        ...current,
                        centerX:
                          world.domain.originX +
                          clamp((event.clientX - rect.left) / rect.width, 0, 1) *
                            world.domain.width,
                        centerZ:
                          world.domain.originZ +
                          clamp((event.clientY - rect.top) / rect.height, 0, 1) *
                            world.domain.depth,
                      }));
                    }}
                    onDoubleClick={() => setCamera(fitWorldCamera(world))}
                  >
                    {usableOverview ? (
                      <WorldRaster snapshot={usableOverview} layer="relief" scale={scale} />
                    ) : (
                      <div className="wv-minimap-field" style={regionStyle(snapshot.grid, world)}>
                        <WorldRaster snapshot={snapshot} layer="relief" scale={scale} />
                      </div>
                    )}
                    <span
                      className="wv-minimap-viewport"
                      style={{
                        left: `${minimapViewport.left}%`,
                        top: `${minimapViewport.top}%`,
                        width: `${minimapViewport.right - minimapViewport.left}%`,
                        height: `${minimapViewport.bottom - minimapViewport.top}%`,
                      }}
                    />
                    <span className="wv-minimap-label">WORLD</span>
                  </button>
                  {region && selectedBounds && !showingWipe && (
                    <div className="wv-selection-actions" data-map-control>
                      <div>
                        <span className="wv-selection-dot" />
                        <strong>
                          {formatWorldDistance(selectedBounds.width)} ×{' '}
                          {formatWorldDistance(selectedBounds.depth)}
                        </strong>
                        <small>
                          {Math.ceil(region.cellsX / world.tileCells) *
                            Math.ceil(region.cellsZ / world.tileCells)}{' '}
                          tiles
                        </small>
                      </div>
                      <button
                        type="button"
                        title="Frame selection · F"
                        aria-label="Frame selected region"
                        onClick={() => setCamera(frameWorldRegion(region, world, size))}
                      >
                        <Focus size={14} />
                      </button>
                      <button
                        type="button"
                        className="wv-refine-button"
                        disabled={busy || stale}
                        onClick={onRefine}
                      >
                        <Scan size={14} />
                        <span>Refine</span>
                      </button>
                      <button
                        type="button"
                        aria-label="Clear region selection"
                        onClick={() => onRegionChange(null)}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <div className="wv-empty">
                  <div className="wv-empty-globe">
                    <MapIcon size={38} strokeWidth={1} />
                  </div>
                  <span className="wv-eyebrow">YOUR WORLD, IN CONTEXT</span>
                  <h2>
                    {busy ? 'Bringing your terrain into view' : 'A canvas for a larger world'}
                  </h2>
                  <p>
                    {busy
                      ? 'The engine is sampling your terrain graph at real world coordinates. Your first overview will appear here.'
                      : 'Build a world overview to explore your terrain, inspect its shape and choose a region to refine.'}
                  </p>
                  {busy ? (
                    <span className="wv-empty-progress">
                      <LoaderCircle size={15} className="wv-spin" />
                      Preparing sampled terrain
                    </span>
                  ) : (
                    <button type="button" onClick={onOverview}>
                      <MapIcon size={15} />
                      Build world overview
                    </button>
                  )}
                </div>
              )}
            </div>
            {snapshot && (
              <div className="wv-map-footer">
                <Legend
                  layer={layer}
                  scale={scale}
                  difference={difference?.max}
                  comparing={compatibleComparison && compareMode !== 'off'}
                />
                <div className="wv-probe-readout" aria-label="Terrain cursor readout">
                  <span>
                    <small>X</small>
                    {probe ? `${numeric(probe.x)} m` : '—'}
                  </span>
                  <span>
                    <small>Z</small>
                    {probe ? `${numeric(probe.z)} m` : '—'}
                  </span>
                  <span>
                    <small>HEIGHT</small>
                    {probe ? `${numeric(probe.elevation)} m` : '—'}
                  </span>
                  <span>
                    <small>SLOPE</small>
                    {probe ? `${numeric(probe.slope)}°` : '—'}
                  </span>
                </div>
              </div>
            )}
            {showingWipe && (
              <div className="wv-comparison-slider" data-map-control>
                <span>{comparison?.label ?? 'Pinned state'}</span>
                <input
                  aria-label="Compare terrain wipe position"
                  type="range"
                  min="0"
                  max="100"
                  value={wipe}
                  onChange={(event) => setWipe(Number(event.target.value))}
                />
                <span>Current terrain</span>
              </div>
            )}
            {compareMode !== 'off' && comparison && !compatibleComparison && (
              <p className="wv-comparison-note">
                Build the same region to compare this pinned state. Both views must cover the same
                physical footprint.
              </p>
            )}
            {noDiagnostic && snapshot && (
              <p className="wv-diagnostic-note">
                <ArrowDown size={12} />
                No {layer === 'wear' ? 'erosion' : layer} signal in this evaluated field.
              </p>
            )}
          </div>
        )}
        {snapshot ? (
          <WorldTerrain3D
            snapshot={snapshot}
            project={materialProject}
            rangeSnapshot={usableOverview}
            layer={layer}
            scale={scale}
            region={region}
            active={active && mode !== 'map'}
          />
        ) : (
          mode !== 'map' && (
            <div className="wv-terrain wv-empty">
              <Box size={36} strokeWidth={1} />
              <h2>Your world in three dimensions</h2>
              <p>The sampled terrain will appear here once the overview finishes.</p>
              {!busy && (
                <button type="button" onClick={onOverview}>
                  Build world overview
                </button>
              )}
            </div>
          )
        )}
      </div>
      <p id="world-map-instructions" className="wv-sr-only">
        Scroll or pinch to zoom. Space and drag to pan. Click or drag to select tiles. Arrow keys
        move the selection. Shift extends it. F frames selection, Home fits the world, Shift + G
        toggles the tile grid, Enter refines selection, Escape clears it. Map coordinates are local
        Cartesian metres, with north at the top.
      </p>
    </section>
  );
}
