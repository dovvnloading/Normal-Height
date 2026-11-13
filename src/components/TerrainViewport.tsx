import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Camera,
  CloudSun,
  Sprout,
  Wind,
  Check,
  ChevronDown,
  Columns2,
  Focus,
  Grid2X2,
  LoaderCircle,
  Map,
  Maximize,
  Mountain,
  RotateCcw,
  Settings2,
  Sun,
  X,
  ZoomIn,
  ZoomOut,
  Crosshair,
  Ruler,
  ChartNoAxesCombined,
  MousePointer2,
  Minimize2,
  Maximize2,
  GitCompareArrows,
  Pin,
  PinOff,
  Bookmark,
  BookmarkPlus,
  Trash2,
  Layers2,
} from 'lucide-react';
import type {
  HeightField,
  MapChannel,
  TerrainProject,
  ViewMode,
  ViewSettings,
} from '../model/types';
import { TerrainScene } from '../render/TerrainScene';
import { DEFAULT_VIEW_SETTINGS } from '../model/viewSettings';
import { DEFAULT_MAP_FRAMING, sampleTerrain, terrainProfile, formatMeters } from '../model/viewportUX';
import type { MapFraming, TerrainPoint, ViewportTool } from '../model/viewportUX';
import { TerrainIcon, MAP_ICON_NAMES } from './TerrainIcon';
import { colorizeMap, sampleSlope } from '../render/maps';
import { pbrPixels } from '../materials/pbr';
import { requestPBR } from '../materials/pbrClient';
import type { PBRChannel, PBRMaps } from '../materials/pbr';
import { DEFAULT_SPLINE_PATH, insertSplinePoint, sampleSpline } from '../model/splines';
import type { SplinePoint } from '../model/splines';
import type { TerrainNode } from '../model/types';
import './TerrainViewport.css';

type Baseline = { field: HeightField; project: TerrainProject; label: string };

interface TerrainViewportProps {
  spline: TerrainNode | null;
  splineEditing: boolean;
  onSplinePath: (path: SplinePoint[]) => void;
  theme: 'light' | 'dark';
  field: HeightField | null;
  project: TerrainProject;
  viewMode: ViewMode;
  channel: MapChannel;
  settings: ViewSettings;
  busy: boolean;
  progress: number;
  stage: string;
  stale: boolean;
  previewLabel: string;
  onViewModeChange: (mode: ViewMode) => void;
  onChannelChange: (channel: MapChannel) => void;
  onSettingsChange: (settings: ViewSettings) => void;
  onCancel: () => void;
  focusMode: boolean;
  onFocusModeChange: (focus: boolean) => void;
  baseline: Baseline | null;
  onCaptureBaseline: () => void;
  onClearBaseline: () => void;
}

const CHANNELS: { value: MapChannel; label: string }[] = [
  { value: 'height', label: 'Height' },
  { value: 'terrain', label: 'Shaded relief' },
  { value: 'normal', label: 'Normals' },
  { value: 'slope', label: 'Slope' },
  { value: 'flow', label: 'Water flow' },
  { value: 'wear', label: 'Erosion' },
  { value: 'deposition', label: 'Deposition' },
  { value: 'basecolor', label: 'PBR base color' },
  { value: 'roughness', label: 'PBR roughness' },
  { value: 'ao', label: 'PBR occlusion' },
  { value: 'splat', label: 'Material weights' },
  { value: 'rockWeight', label: 'Rock coverage' },
  { value: 'soilWeight', label: 'Soil coverage' },
  { value: 'vegetationWeight', label: 'Vegetation coverage' },
  { value: 'snowWeight', label: 'Snow coverage' },
  { value: 'curvature', label: 'PBR curvature' },
  { value: 'orm', label: 'Packed ORM' },
];

type CameraBookmark = {
  name: string;
  position: [number, number, number];
  target: [number, number, number];
};
function readCameraBookmarks(): CameraBookmark[] {
  try {
    const value = JSON.parse(localStorage.getItem('normal-height.camera-bookmarks.v1') || '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((bookmark: CameraBookmark) =>
      typeof bookmark.name === 'string' &&
      Array.isArray(bookmark.position) && bookmark.position.length === 3 &&
      Array.isArray(bookmark.target) && bookmark.target.length === 3 &&
      [...bookmark.position, ...bookmark.target].every(Number.isFinite)
    ).slice(0, 8);
  } catch { return []; }
}

const CHANNEL_GROUPS = [
  { label: 'Terrain', values: ['height', 'terrain', 'normal', 'slope'] },
  { label: 'Water & erosion', values: ['flow', 'wear', 'deposition'] },
  { label: 'PBR textures', values: ['basecolor', 'roughness', 'ao', 'curvature', 'orm'] },
  { label: 'Material distribution', values: ['splat', 'rockWeight', 'soilWeight',
    'vegetationWeight', 'snowWeight'] },
] as const;

const VIEWPORT_TOOLS = [
  { value: 'navigate', label: 'Navigate', Icon: MousePointer2 },
  { value: 'inspect', label: 'Inspect', Icon: Crosshair },
  { value: 'measure', label: 'Measure', Icon: Ruler },
  { value: 'profile', label: 'Profile', Icon: ChartNoAxesCombined },
] as const;

const MATERIAL_WEIGHT_INDEX: Partial<Record<MapChannel, number>> = {
  rockWeight: 0, soilWeight: 1, vegetationWeight: 2, snowWeight: 3,
};

// The map canvas mounts each time the 2D or split view opens. Re-rasterizing
// an unchanged 1024² field cost 55–75 ms of main thread on every switch, so
// keep a few finished rasters per field (released with the field itself).
const MAP_RASTERS_PER_FIELD = 4;
const MAP_VIEW_STORAGE_KEY = 'normal-height.map-framing.v1';
function loadMapFraming(): MapFraming {
  try {
    const value = JSON.parse(localStorage.getItem(MAP_VIEW_STORAGE_KEY) || 'null');
    if (value && Number.isFinite(value.zoom) && value.zoom >= 0.35 && value.zoom <= 12 &&
      Number.isFinite(value.offset?.x) && Number.isFinite(value.offset?.y)) {
      return { zoom: value.zoom, offset: { x: value.offset.x, y: value.offset.y } };
    }
  } catch { /* Non-persistent browsing still supports in-session framing. */ }
  return { ...DEFAULT_MAP_FRAMING, offset: { ...DEFAULT_MAP_FRAMING.offset } };
}
const mapRasters = new WeakMap<HeightField, Map<string, HTMLCanvasElement>>();
function rememberRaster(field: HeightField, key: string, raster: HTMLCanvasElement) {
  let rasters = mapRasters.get(field);
  // `Map` in this file is the lucide icon; use the global collection.
  if (!rasters) mapRasters.set(field, rasters = new globalThis.Map());
  rasters.delete(key);
  rasters.set(key, raster);
  if (rasters.size > MAP_RASTERS_PER_FIELD) rasters.delete(rasters.keys().next().value!);
}

function MapCanvas({
  field,
  channel,
  project,
  spline,
  splineEditing,
  onSplinePath,
  initialFraming,
  onFramingChange,
  tool,
  hoverPoint,
  inspectionPoints,
  onHoverPoint,
  onChoosePoint,
  baseline,
  compareKind,
  wipe,
  overlayChannel,
  overlayOpacity,
}: {
  field: HeightField | null;
  channel: MapChannel;
  project: TerrainProject;
  spline: TerrainNode | null;
  splineEditing: boolean;
  onSplinePath: (path: SplinePoint[]) => void;
  initialFraming: MapFraming;
  onFramingChange: (framing: MapFraming) => void;
  tool: ViewportTool;
  hoverPoint: TerrainPoint | null;
  inspectionPoints: TerrainPoint[];
  onHoverPoint: (point: TerrainPoint | null) => void;
  onChoosePoint: (point: TerrainPoint) => void;
  baseline: Baseline | null;
  compareKind: 'wipe' | 'difference';
  wipe: number;
  overlayChannel: MapChannel | null;
  overlayOpacity: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLCanvasElement | null>(null);
  const baselineRasterRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRasterRef = useRef<HTMLCanvasElement | null>(null);
  const [deltaScale, setDeltaScale] = useState(0);
  const materialMapsRef = useRef<PBRMaps | null>(null);
  const [rasterVersion, setRasterVersion] = useState(0);
  const [zoom, setZoom] = useState(initialFraming.zoom);
  const [offset, setOffset] = useState(initialFraming.offset);
  const [mapBusy, setMapBusy] = useState(false);
  const [mapError, setMapError] = useState(false);
  useEffect(() => onFramingChange({ zoom, offset }), [zoom, offset]);
  const [sample, setSample] = useState<{
    x: number;
    y: number;
    elevation: number;
    value: string;
  } | null>(null);
  const [dimensions, setDimensions] = useState({ width: 100, height: 100 });
  const drag = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
  const clickStart = useRef<{ x: number; y: number } | null>(null);
  const touches = useRef(new globalThis.Map<number, { x: number; y: number }>());
  const pinch = useRef<{
    distance: number; middleX: number; middleY: number;
    zoom: number; offset: { x: number; y: number };
  } | null>(null);
  const [draftSpline, setDraftSpline] = useState<SplinePoint[] | null>(null);
  const draftRef = useRef<SplinePoint[] | null>(null);
  const handleDrag = useRef<{ index: number; pointer: number } | null>(null);
  const splinePoints = draftSpline ?? spline?.path ?? DEFAULT_SPLINE_PATH;
  const splineCurve = useMemo(
    () => spline ? sampleSpline(splinePoints, 22) : [],
    [spline, splinePoints],
  );
  const layerSize = Math.max(1, Math.min(dimensions.width - 84, dimensions.height - 82)) * zoom;
  const layerLeft = (dimensions.width - layerSize) / 2 + offset.x;
  const layerTop = (dimensions.height - layerSize) / 2 + offset.y;
  const layerRef = useRef<HTMLDivElement>(null);
  const pointFromEvent = (event: React.PointerEvent): SplinePoint => {
    const bounds = layerRef.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width))),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / Math.max(1, bounds.height))),
    };
  };

  const mapPoint = (clientX: number, clientY: number): TerrainPoint | null => {
    if (!field) return null;
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const u = (clientX - rect.left - layerLeft) / layerSize;
    const v = (clientY - rect.top - layerTop) / layerSize;
    return u >= 0 && u <= 1 && v >= 0 && v <= 1 ? { u, v } : null;
  };
  const view = useRef({ zoom, offset, dimensions });
  view.current = { zoom, offset, dimensions };

  useEffect(() => {
    if (!hostRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      setDimensions({ width: rect.width, height: rect.height });
    });
    observer.observe(hostRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    materialMapsRef.current = null;
    baselineRasterRef.current = null;
    if (baseline && compareKind === 'wipe') {
      const key = `terrain/${baseline.project.worldSize}/${baseline.project.heightScale}`;
      const cached = mapRasters.get(baseline.field)?.get(key);
      if (cached) baselineRasterRef.current = cached;
      else {
        const n = baseline.field.resolution;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = n;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const image = ctx.createImageData(n, n);
          image.data.set(colorizeMap(baseline.field, 'terrain',
            baseline.project.worldSize, baseline.project.heightScale));
          ctx.putImageData(image, 0, 0);
          baselineRasterRef.current = canvas;
          rememberRaster(baseline.field, key, canvas);
        }
      }
    }
    // Never label a previous raster as the newly chosen material channel.
    imageRef.current = null;
    setRasterVersion((version) => version + 1);
    setMapError(false);
    setMapBusy(false);
    if (!field) {
      imageRef.current = null;
      setRasterVersion((version) => version + 1);
      return;
    }
    const paintPixels = (source: Uint8ClampedArray, resolution = field.resolution): HTMLCanvasElement | null => {
      if (!active) return null;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = resolution;
      const context = canvas.getContext('2d');
      if (!context) return null;
      let pixels = source;
      if (channel === 'splat') {
        // Splat alpha is a fourth physical material, not canvas transparency.
        const display = pixels.slice();
        for (let i = 0; i < display.length; i += 4) {
          display[i] = Math.min(255, pixels[i] + pixels[i + 3]);
          display[i + 1] = Math.min(255, pixels[i + 1] + pixels[i + 3]);
          display[i + 2] = Math.min(255, pixels[i + 2] + pixels[i + 3]);
          display[i + 3] = 255;
        }
        pixels = display;
      }
      const image = context.createImageData(resolution, resolution);
      image.data.set(pixels);
      context.putImageData(image, 0, 0);
      imageRef.current = canvas;
      // The visible canvas must repaint for every newly generated map. Changing
      // surface settings/seed does not necessarily change field or view state.
      setRasterVersion((version) => version + 1);
      return canvas;
    };
    if (baseline && compareKind === 'difference') {
      setMapBusy(true);
      const worker = new Worker(new URL('../render/compare.worker.ts', import.meta.url),
        { type: 'module' });
      worker.onmessage = (event: MessageEvent<{
        pixels: Uint8ClampedArray; resolution: number; maxAbs: number;
      }>) => {
        if (!active) return;
        paintPixels(event.data.pixels, event.data.resolution);
        setDeltaScale(event.data.maxAbs);
        setMapBusy(false);
        worker.terminate();
      };
      worker.onerror = () => {
        if (!active) return;
        setMapBusy(false);
        setMapError(true);
        worker.terminate();
      };
      const currentHeight = field.height.slice();
      const baselineHeight = baseline.field.height.slice();
      worker.postMessage({
        current: currentHeight, baseline: baselineHeight,
        currentSize: field.resolution, baselineSize: baseline.field.resolution,
        currentScale: project.heightScale, baselineScale: baseline.project.heightScale,
        outputSize: Math.min(512, Math.max(field.resolution, baseline.field.resolution)),
      }, [currentHeight.buffer, baselineHeight.buffer]);
      return () => { active = false; worker.terminate(); };
    }
    const material = [
      'basecolor', 'roughness', 'ao', 'splat', 'curvature', 'orm',
      'rockWeight', 'soilWeight', 'vegetationWeight', 'snowWeight',
    ].includes(channel);
    if (material) {
      setMapBusy(true);
      const request = requestPBR(field, project);
      request.promise.then((maps) => {
        if (!active) return;
        materialMapsRef.current = maps;
        paintPixels(pbrPixels(maps, field, project, channel as PBRChannel));
        setMapBusy(false);
      }).catch(() => {
        if (!active) return;
        setMapBusy(false);
        setMapError(true);
      });
      return () => { active = false; request.release(); };
    }
    // colorizeMap depends only on these inputs, so its raster is reusable.
    const key = `${channel}/${project.worldSize}/${project.heightScale}`;
    const cached = mapRasters.get(field)?.get(key);
    if (cached) {
      imageRef.current = cached;
      setRasterVersion((version) => version + 1);
    } else {
      const raster = paintPixels(colorizeMap(field, channel, project.worldSize, project.heightScale));
      if (raster) rememberRaster(field, key, raster);
    }
    return () => { active = false; };
  }, [field, channel, project.worldSize, project.heightScale, project.surface, project.seed,
    baseline, compareKind]);

  useEffect(() => {
    overlayRasterRef.current = null;
    if (field && overlayChannel && !baseline) {
      const key = `${overlayChannel}/${project.worldSize}/${project.heightScale}`;
      const cached = mapRasters.get(field)?.get(key);
      if (cached) overlayRasterRef.current = cached;
      else {
        const n = field.resolution;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = n;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const image = ctx.createImageData(n, n);
          image.data.set(colorizeMap(field, overlayChannel,
            project.worldSize, project.heightScale));
          ctx.putImageData(image, 0, 0);
          overlayRasterRef.current = canvas;
          rememberRaster(field, key, canvas);
        }
      }
    }
    setRasterVersion(n => n + 1);
  }, [field, overlayChannel, project.worldSize, project.heightScale, baseline]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const { width, height } = dimensions;
    if (!width || !height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    if (!imageRef.current) return;
    const size = Math.max(1, Math.min(width - 84, height - 82)) * zoom;
    const left = (width - size) / 2 + offset.x,
      top = (height - size) / 2 + offset.y;
    context.imageSmoothingEnabled = size < imageRef.current.width;
    context.drawImage(imageRef.current, left, top, size, size);
    if (!baseline && overlayRasterRef.current) {
      context.save();
      context.globalAlpha = overlayOpacity / 100;
      context.drawImage(overlayRasterRef.current, left, top, size, size);
      context.restore();
    }
    if (baseline && compareKind === 'wipe' && baselineRasterRef.current) {
      context.save();
      context.beginPath();
      context.rect(left, top, size * wipe / 100, size);
      context.clip();
      context.drawImage(baselineRasterRef.current, left, top, size, size);
      context.restore();
      context.strokeStyle = '#fff9ec';
      context.lineWidth = 1.5;
      const divider = left + size * wipe / 100;
      context.beginPath();
      context.moveTo(divider, top);
      context.lineTo(divider, top + size);
      context.stroke();
    }
    context.strokeStyle = '#6d7b6f';
    context.lineWidth = 0.75;
    context.strokeRect(left - 0.5, top - 0.5, size + 1, size + 1);
    const length = 8;
    context.strokeStyle = '#a1b09d';
    context.lineWidth = 1;
    for (const [x, y, dx, dy] of [
      [left - 5, top - 5, 1, 1],
      [left + size + 5, top - 5, -1, 1],
      [left - 5, top + size + 5, 1, -1],
      [left + size + 5, top + size + 5, -1, -1],
    ]) {
      context.beginPath();
      context.moveTo(x, y + dy * length);
      context.lineTo(x, y);
      context.lineTo(x + dx * length, y);
      context.stroke();
    }
  }, [dimensions, zoom, offset, rasterVersion, field, channel, project.worldSize,
    project.heightScale, baseline, compareKind, wipe, overlayOpacity, overlayChannel]);

  useEffect(() => {
    const canvas = hostRef.current;
    if (!canvas) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const oldZoom = view.current.zoom;
      const next = Math.max(0.35, Math.min(12, oldZoom * Math.exp(-event.deltaY * 0.0015)));
      const px = event.clientX - rect.left - view.current.dimensions.width / 2;
      const py = event.clientY - rect.top - view.current.dimensions.height / 2;
      const ratio = next / oldZoom;
      setOffset({
        x: px - (px - view.current.offset.x) * ratio,
        y: py - (py - view.current.offset.y) * ratio,
      });
      setZoom(next);
    };
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => canvas.removeEventListener('wheel', wheel);
  }, []);

  function inspect(event: React.PointerEvent<HTMLCanvasElement>) {
    if (event.pointerType === 'touch' && touches.current.size >= 2 && pinch.current) {
      touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const [a, b] = [...touches.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const next = Math.max(0.35, Math.min(12, pinch.current.zoom * distance / pinch.current.distance));
      const middleX = (a.x + b.x) / 2, middleY = (a.y + b.y) / 2;
      const rect = hostRef.current!.getBoundingClientRect();
      const x0 = pinch.current.middleX - rect.left - dimensions.width / 2;
      const y0 = pinch.current.middleY - rect.top - dimensions.height / 2;
      const x1 = middleX - rect.left - dimensions.width / 2;
      const y1 = middleY - rect.top - dimensions.height / 2;
      setOffset({
        x: x1 - (x0 - pinch.current.offset.x) * next / pinch.current.zoom,
        y: y1 - (y0 - pinch.current.offset.y) * next / pinch.current.zoom,
      });
      setZoom(next);
      return;
    }
    if (drag.current) {
      setOffset({
        x: drag.current.startX + event.clientX - drag.current.x,
        y: drag.current.startY + event.clientY - drag.current.y,
      });
      return;
    }
    if (!field || event.pointerType === 'touch') return;
    onHoverPoint(mapPoint(event.clientX, event.clientY));
    const rect = event.currentTarget.getBoundingClientRect();
    const size = Math.max(1, Math.min(dimensions.width - 84, dimensions.height - 82)) * zoom;
    const left = (dimensions.width - size) / 2 + offset.x,
      top = (dimensions.height - size) / 2 + offset.y;
    const x = Math.floor(((event.clientX - rect.left - left) / size) * field.resolution);
    const y = Math.floor(((event.clientY - rect.top - top) / size) * field.resolution);
    if (x < 0 || y < 0 || x >= field.resolution || y >= field.resolution) {
      setSample(null);
      return;
    }
    const index = y * field.resolution + x;
    let value = '';
    if (channel === 'flow' || channel === 'wear' || channel === 'deposition')
      value = `${CHANNELS.find((c) => c.value === channel)?.label}: ${field[channel][index].toPrecision(3)}`;
    if (channel === 'slope')
      value = `${sampleSlope(field, x, y, project.worldSize, project.heightScale).degrees.toFixed(1)}° slope`;
    const weightChannel = MATERIAL_WEIGHT_INDEX[channel];
    if (weightChannel !== undefined && materialMapsRef.current)
      value = `${CHANNELS.find(c => c.value === channel)?.label}: ${(
        materialMapsRef.current.splat[index * 4 + weightChannel] / 255 * 100
      ).toFixed(1)}%`;
    setSample({ x, y, elevation: field.height[index] * project.heightScale, value });
  }

  return (
    <div className="nh-map" ref={hostRef}>
      <canvas
        ref={canvasRef}
        aria-label={`${CHANNELS.find((c) => c.value === channel)?.label} map. Drag to pan, scroll to zoom. Press Home to fit.`}
        role="img"
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
          clickStart.current = { x: event.clientX, y: event.clientY };
          if (event.pointerType === 'touch') {
            touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
            if (touches.current.size === 2) {
              const [a, b] = [...touches.current.values()];
              pinch.current = {
                distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
                middleX: (a.x + b.x) / 2, middleY: (a.y + b.y) / 2,
                zoom, offset: { ...offset },
              };
              drag.current = null;
            }
          }
          if ((tool === 'navigate' || event.button !== 0 || event.pointerType === 'touch') &&
            touches.current.size < 2) {
            drag.current = { x: event.clientX, y: event.clientY,
              startX: offset.x, startY: offset.y };
          }
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={inspect}
        onPointerUp={(event) => {
          const start = clickStart.current;
          if (event.pointerType === 'touch') touches.current.delete(event.pointerId);
          if (touches.current.size < 2) pinch.current = null;
          if (start && !splineEditing && tool !== 'navigate' &&
            Math.hypot(event.clientX - start.x, event.clientY - start.y) < 6) {
            const point = mapPoint(event.clientX, event.clientY);
            if (point) onChoosePoint(point);
          }
          clickStart.current = null;
          drag.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={(event) => {
          touches.current.delete(event.pointerId);
          pinch.current = null;
          clickStart.current = null;
          drag.current = null;
        }}
        onPointerLeave={() => { setSample(null); onHoverPoint(null); }}
        onKeyDown={(event) => {
          if (event.key === 'Home') {
            setZoom(1);
            setOffset({ x: 0, y: 0 });
          }
          if (event.key === '+' || event.key === '=') setZoom((v) => Math.min(12, v * 1.2));
          if (event.key === '-') setZoom((v) => Math.max(0.35, v / 1.2));
        }}
      />
      {(hoverPoint || inspectionPoints.length > 0) && (
        <svg className="nh-inspection-overlay" aria-hidden="true"
          style={{ left: layerLeft, top: layerTop, width: layerSize, height: layerSize }}
          viewBox="0 0 1000 1000" preserveAspectRatio="none">
          {inspectionPoints.length >= 2 && (
            <line x1={inspectionPoints[0].u * 1000} y1={inspectionPoints[0].v * 1000}
              x2={inspectionPoints[1].u * 1000} y2={inspectionPoints[1].v * 1000}
              stroke="#ffe7a8" strokeWidth="2.6" vectorEffect="non-scaling-stroke" />
          )}
          {inspectionPoints.map((p, index) => (
            <g key={index}>
              <circle cx={p.u * 1000} cy={p.v * 1000} r="10" fill="#edbc6b"
                stroke="#2e3b36" strokeWidth="3" vectorEffect="non-scaling-stroke" />
              <text x={p.u * 1000 + 16} y={p.v * 1000 - 16} fill="#fff"
                stroke="#25332e" strokeWidth="3" paintOrder="stroke"
                fontSize="24" fontWeight="bold">{String.fromCharCode(65 + index)}</text>
            </g>
          ))}
          {hoverPoint && (
            <g stroke="#f9faf2" strokeWidth="2" vectorEffect="non-scaling-stroke">
              <circle cx={hoverPoint.u * 1000} cy={hoverPoint.v * 1000} r="8" fill="none" />
              <path d={`M ${hoverPoint.u * 1000 - 18} ${hoverPoint.v * 1000}
                h 8 m 20 0 h 8 M ${hoverPoint.u * 1000} ${hoverPoint.v * 1000 - 18}
                v 8 m 0 20 v 8`} fill="none" />
            </g>
          )}
        </svg>
      )}
      {mapBusy && <div className="nh-map-update" role="status">
        {baseline && compareKind === 'difference' ? 'Computing elevation change…' :
          `Generating ${CHANNELS.find(c => c.value === channel)?.label}…`}
      </div>}
      {baseline && compareKind === 'difference' && !mapBusy && !mapError &&
        <div className="nh-difference-legend">
          <strong>Δ elevation in meters</strong>
          <div className="nh-difference-gradient" />
          <div><span>−{formatMeters(deltaScale)}</span>
            <span>0 m</span><span>+{formatMeters(deltaScale)}</span></div>
          <small>Warm = lower · Cool = higher</small>
        </div>}
      {mapError && <div className="nh-map-update error" role="alert">Could not generate this material map.</div>}
      {spline && (
        <div
          ref={layerRef}
          className={`nh-spline-layer ${splineEditing ? 'is-editing' : ''} ${spline.params.mode === 'ridge' ? 'is-ridge' : 'is-river'}`}
          style={{ left: layerLeft, top: layerTop, width: layerSize, height: layerSize }}
          aria-label="Spline path overlay"
          onPointerDown={(event) => {
            if (!splineEditing) return;
            if (event.button === 1 || event.button === 2) {
              event.preventDefault();
              drag.current = {
                x: event.clientX, y: event.clientY,
                startX: offset.x, startY: offset.y,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
              return;
            }
            if (event.button !== 0 || event.target !== event.currentTarget) return;
            event.preventDefault();
            onSplinePath(insertSplinePoint(splinePoints, pointFromEvent(event)));
          }}
          onPointerMove={(event) => {
            if (drag.current) {
              setOffset({
                x: drag.current.startX + event.clientX - drag.current.x,
                y: drag.current.startY + event.clientY - drag.current.y,
              });
            }
          }}
          onPointerUp={(event) => {
            drag.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <svg
            className="nh-spline-drawing"
            viewBox="0 0 1000 1000"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <polyline
              className="nh-spline-outline"
              points={splineCurve.map((p) => `${p.x * 1000},${p.y * 1000}`).join(' ')}
              fill="none"
              vectorEffect="non-scaling-stroke"
              strokeWidth={5}
            />
            <polyline
              className="nh-spline-centerline"
              points={splineCurve.map((p) => `${p.x * 1000},${p.y * 1000}`).join(' ')}
              fill="none"
              vectorEffect="non-scaling-stroke"
              strokeWidth={2.5}
            />
          </svg>
          {splineEditing && splinePoints.map((point, index) => (
            <button
              key={index}
              type="button"
              className={`nh-spline-handle ${handleDrag.current?.index === index ? 'is-dragging' : ''}`}
              aria-label={`Move spline point ${index + 1}`}
              title={`${index === 0 ? 'Headwater' : index === splinePoints.length - 1 ? 'Outlet' : 'Control point'} ${index + 1} · ${Math.round(point.x * 100)}% E, ${Math.round(point.y * 100)}% S. Double-click to remove.`}
              style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.stopPropagation();
                event.preventDefault();
                handleDrag.current = { index, pointer: event.pointerId };
                draftRef.current = splinePoints.map((p) => ({ ...p }));
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (handleDrag.current?.pointer !== event.pointerId ||
                  handleDrag.current.index !== index) return;
                const next = (draftRef.current ?? splinePoints).map((p) => ({ ...p }));
                next[index] = pointFromEvent(event);
                draftRef.current = next;
                setDraftSpline(next);
              }}
              onPointerUp={(event) => {
                if (handleDrag.current?.pointer !== event.pointerId) return;
                event.stopPropagation();
                const next = draftRef.current;
                handleDrag.current = null;
                draftRef.current = null;
                if (event.currentTarget.hasPointerCapture(event.pointerId))
                  event.currentTarget.releasePointerCapture(event.pointerId);
                if (next) onSplinePath(next);
                setDraftSpline(null);
              }}
              onPointerCancel={() => {
                handleDrag.current = null;
                draftRef.current = null;
                setDraftSpline(null);
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
                if (splinePoints.length > 2)
                  onSplinePath(splinePoints.filter((_, i) => i !== index).map((p) => ({ ...p })));
              }}
            >
              <span>{index + 1}</span>
            </button>
          ))}
          {splineEditing && (
            <span className="nh-spline-edit-hint">
              {spline.params.mode === 'ridge' ? 'RIDGE' : 'RIVER'} · Move points · Click to add · Middle/right drag to pan
            </span>
          )}
        </div>
      )}
      <div className="nh-map-scale">
        {(project.worldSize / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} ×{' '}
        {(project.worldSize / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} km
      </div>
      <div className="nh-map-controls">
        <button
          type="button"
          title="Zoom out"
          aria-label="Zoom map out"
          onClick={() => setZoom((v) => Math.max(0.35, v / 1.25))}
        >
          <ZoomOut size={15} />
        </button>
        <span title="Zoom relative to fitted map">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          title="Zoom in"
          aria-label="Zoom map in"
          onClick={() => setZoom((v) => Math.min(12, v * 1.25))}
        >
          <ZoomIn size={15} />
        </button>
        <button
          type="button"
          title="Fit map (Home)"
          aria-label="Fit map"
          onClick={() => {
            setZoom(1);
            setOffset({ x: 0, y: 0 });
          }}
        >
          <Maximize size={15} />
        </button>
      </div>
      <div className="nh-map-sample" aria-live="off">
        {sample ? (
          <>
            <span>
              {sample.x}, {sample.y}
            </span>
            <b>{sample.elevation.toFixed(1)} m</b>
            {sample.value && <span>{sample.value}</span>}
          </>
        ) : (
          <span>Hover to inspect · Drag to pan</span>
        )}
      </div>
    </div>
  );
}

function MapLegend({
  field,
  channel,
  project,
}: {
  field: HeightField | null;
  channel: MapChannel;
  project: TerrainProject;
}) {
  const legend = useMemo(() => {
    if (!field) return null;
    if (channel === 'normal')
      return { label: 'Tangent normals · OpenGL', start: '+X', end: '+Y', empty: false };
    if (channel === 'slope')
      return { label: 'Surface slope', start: '0°', end: '70°+', empty: false };
    if (channel === 'height')
      return {
        label: 'Elevation · fixed scale',
        start: '0 m',
        end: `${Math.round(project.heightScale).toLocaleString()} m`,
        empty: false,
      };
    if (channel === 'terrain') {
      let min = Infinity,
        max = -Infinity;
      for (const h of field.height) {
        min = Math.min(min, h);
        max = Math.max(max, h);
      }
      return {
        label: 'Elevation',
        start: `${Math.round(min * project.heightScale).toLocaleString()} m`,
        end: `${Math.round(max * project.heightScale).toLocaleString()} m`,
        empty: false,
      };
    }
    if ([
      'basecolor', 'roughness', 'ao', 'splat', 'curvature', 'orm',
      'rockWeight', 'soilWeight', 'vegetationWeight', 'snowWeight',
    ].includes(channel)) {
      return { label: channel === 'splat' ? 'R rock · G soil · B vegetation · A snow'
        : channel === 'orm' ? 'R occlusion · G roughness · B metallic'
          : CHANNELS.find(c => c.value === channel)?.label ?? 'PBR map',
        start: channel === 'curvature' ? 'Concave' :
          MATERIAL_WEIGHT_INDEX[channel] !== undefined ? '0%' : '0',
        end: channel === 'curvature' ? 'Convex' :
          MATERIAL_WEIGHT_INDEX[channel] !== undefined ? '100%' : '1',
        empty: false };
    }
    let max = 0;
    const diagnostic = field[channel as 'flow' | 'wear' | 'deposition'];
    for (const v of diagnostic) max = Math.max(max, v);
    return {
      label: max
        ? `${CHANNELS.find((c) => c.value === channel)?.label} · ${channel === 'flow' ? 'normalized' : 'log scale'}`
        : `No ${channel === 'flow' ? 'water flow' : channel === 'wear' ? 'erosion' : 'deposition'} recorded`,
      start: '0',
      end: max.toPrecision(3),
      empty: max === 0,
    };
  }, [field, channel, project.heightScale]);
  if (!legend) return null;
  return (
    <div className={`nh-map-legend nh-map-legend-${channel}`}>
      <span>{legend.label}</span>
      {!legend.empty && (
        <>
          <div className="nh-legend-gradient" />
          <div className="nh-legend-labels">
            <span>{legend.start}</span>
            <span>{legend.end}</span>
          </div>
        </>
      )}
    </div>
  );
}

export function TerrainViewport({
  spline,
  splineEditing,
  onSplinePath,
  theme,
  field,
  project,
  viewMode,
  channel,
  settings,
  busy,
  progress,
  stage,
  stale,
  previewLabel,
  onViewModeChange,
  onChannelChange,
  onSettingsChange,
  onCancel,
  focusMode,
  onFocusModeChange,
  baseline,
  onCaptureBaseline,
  onClearBaseline,
}: TerrainViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<TerrainScene | null>(null);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [tool, setTool] = useState<ViewportTool>('navigate');
  const [compareKind, setCompareKind] = useState<'wipe' | 'difference'>('wipe');
  const [wipe, setWipe] = useState(50);
  const [showLayers, setShowLayers] = useState(false);
  const [overlayChannel, setOverlayChannel] = useState<MapChannel | null>(null);
  const [overlayOpacity, setOverlayOpacity] = useState(45);
  const [hoverPoint, setHoverPoint] = useState<TerrainPoint | null>(null);
  const [inspectionPoints, setInspectionPoints] = useState<TerrainPoint[]>([]);
  const [splitRatio, setSplitRatio] = useState(() => {
    try {
      const stored = Number(localStorage.getItem('normal-height.split.v1'));
      return stored >= 22 && stored <= 78 ? stored : 50;
    } catch { return 50; }
  });
  const [cameraHeading, setCameraHeading] = useState(0);
  const [bookmarks, setBookmarks] = useState<CameraBookmark[]>(readCameraBookmarks);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [compactSplit, setCompactSplit] = useState(
    () => window.matchMedia('(max-width: 660px)').matches,
  );
  const displayPanel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 660px)');
    const onChange = (e: MediaQueryListEvent) => setCompactSplit(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  useEffect(() => {
    try { localStorage.setItem('normal-height.camera-bookmarks.v1',
      JSON.stringify(bookmarks)); } catch { /* optional */ }
  }, [bookmarks]);
  const mapFraming = useRef<MapFraming>(loadMapFraming());
  const choosePoint = (point: TerrainPoint) =>
    setInspectionPoints((points) => tool === 'inspect' ? [point] :
      points.length >= 2 ? [point] : [...points, point]);
  const interactions = useRef({ tool, choosePoint });
  interactions.current = { tool, choosePoint };
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const effectiveMode = sceneError ? '2d' : viewMode;
  const activePoint = hoverPoint ?? inspectionPoints.at(-1) ?? null;
  const activeSample = useMemo(() =>
    field && activePoint ? sampleTerrain(field, project, activePoint) : null,
    [field, project, activePoint]);
  const profile = useMemo(() =>
    field && inspectionPoints.length === 2
      ? terrainProfile(field, project, inspectionPoints[0], inspectionPoints[1]) : null,
    [field, project, inspectionPoints]);
  useEffect(() => {
    try { localStorage.setItem('normal-height.split.v1', String(splitRatio)); } catch { /* optional */ }
  }, [splitRatio]);
  useEffect(() => {
    const save = () => {
      try { localStorage.setItem(MAP_VIEW_STORAGE_KEY, JSON.stringify(mapFraming.current)); }
      catch { /* optional */ }
    };
    window.addEventListener('pagehide', save);
    return () => { save(); window.removeEventListener('pagehide', save); };
  }, []);

  useEffect(() => {
    if (!hostRef.current) return;
    try {
      sceneRef.current = new TerrainScene(hostRef.current, settingsRef.current, setSceneError,
        theme, (next) => setCameraHeading((current) => Math.abs(next - current) >= 1 ? next : current));
      setSceneError(null);
    } catch (error) {
      setSceneError(
        `3D preview is unavailable in this browser. ${error instanceof Error ? error.message : 'WebGL 2 is required.'}`,
      );
    }
    return () => {
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, [attempt]);

  useEffect(() => {
    if (field) sceneRef.current?.update(field, project, settings);
    else sceneRef.current?.applySettings(settings);
  }, [field, project, settings, attempt]);

  useEffect(() => {
    sceneRef.current?.setInspection(hoverPoint, inspectionPoints);
  }, [hoverPoint, inspectionPoints, field, settings.exaggeration, attempt]);

  useEffect(() => {
    const canvas = hostRef.current?.querySelector('canvas');
    if (!canvas) return;
    let pressed: { x: number; y: number } | null = null;
    let lastHover = 0;
    const down = (event: PointerEvent) => {
      if (event.button === 0) pressed = { x: event.clientX, y: event.clientY };
    };
    const move = (event: PointerEvent) => {
      if (interactions.current.tool === 'navigate' || event.pointerType === 'touch') return;
      const now = performance.now();
      // Raycasting the adaptive mesh on every pointer event would block orbiting.
      if (now - lastHover < 100) return;
      lastHover = now;
      const p = sceneRef.current?.pickPoint(event.clientX, event.clientY) ?? null;
      setHoverPoint((old) => old && p &&
        Math.abs(old.u - p.u) < 0.0002 && Math.abs(old.v - p.v) < 0.0002 ? old : p);
    };
    const up = (event: PointerEvent) => {
      if (pressed && interactions.current.tool !== 'navigate' &&
        Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) < 6) {
        const p = sceneRef.current?.pickPoint(event.clientX, event.clientY);
        if (p) interactions.current.choosePoint(p);
      }
      pressed = null;
    };
    const leave = () => setHoverPoint(null);
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', leave);
    canvas.addEventListener('pointerleave', leave);
    return () => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', leave);
      canvas.removeEventListener('pointerleave', leave);
    };
  }, [attempt]);

  useEffect(() => {
    sceneRef.current?.setSplineGuide(
      spline?.path ?? null,
      spline?.params.mode === 'ridge' ? 'ridge' : 'river',
    );
  }, [spline, field, settings.exaggeration, attempt]);

  useEffect(() => {
    sceneRef.current?.applyTheme(theme);
  }, [theme, attempt]);

  useEffect(() => {
    if (!showSettings) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowSettings(false);
    };
    const outside = (event: PointerEvent) => {
      if (!displayPanel.current?.contains(event.target as Node) &&
          !(event.target as HTMLElement).closest('.nh-viewport-tool')) {
        setShowSettings(false);
      }
    };
    window.addEventListener('keydown', escape);
    window.addEventListener('pointerdown', outside);
    return () => {
      window.removeEventListener('keydown', escape);
      window.removeEventListener('pointerdown', outside);
    };
  }, [showSettings]);

  const change = (patch: Partial<ViewSettings>) => onSettingsChange({ ...settings, ...patch });
  const progressPercent = Math.max(0, Math.min(100, progress <= 1 ? progress * 100 : progress));
  const [meshTriangles, setMeshTriangles] = useState(0);
  useEffect(() => {
    const canvas = hostRef.current?.querySelector('canvas');
    if (!canvas) return;
    const refresh = () => setMeshTriangles(Number(canvas.dataset.meshTriangles) || 0);
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(canvas, { attributes: true, attributeFilter: ['data-mesh-triangles'] });
    return () => observer.disconnect();
  }, [field, attempt]);

  return (
    <section className="nh-viewport" aria-label="Terrain preview">
      <div className="nh-viewport-toolbar">
        <div className="nh-view-tabs" role="group" aria-label="Preview mode">
          <button
            type="button"
            className={effectiveMode === '3d' ? 'active' : ''}
            aria-pressed={effectiveMode === '3d'}
            disabled={!!sceneError}
            onClick={() => onViewModeChange('3d')}
          >
            <Box size={14} />
            <span>3D terrain</span>
          </button>
          <button
            type="button"
            className={effectiveMode === '2d' ? 'active' : ''}
            aria-pressed={effectiveMode === '2d'}
            onClick={() => onViewModeChange('2d')}
          >
            <Map size={14} />
            <span>2D map</span>
          </button>
          <button
            type="button"
            className={effectiveMode === 'split' ? 'active' : ''}
            aria-pressed={effectiveMode === 'split'}
            disabled={!!sceneError}
            title="Compare 3D terrain and 2D map"
            onClick={() => onViewModeChange('split')}
          >
            <Columns2 size={14} />
            <span>Split</span>
          </button>
          <button type="button" className={effectiveMode === 'compare' ? 'active' : ''}
            aria-pressed={effectiveMode === 'compare'} disabled={!baseline || !field}
            title={baseline ? 'Compare the pinned baseline with the current terrain' :
              'Pin a terrain baseline first'}
            onClick={() => { onChannelChange('terrain'); onViewModeChange('compare'); }}>
            <GitCompareArrows size={14} /><span>Compare</span>
          </button>
        </div>
        <div className="nh-viewport-toolset" role="group" aria-label="Viewport tool">
          {VIEWPORT_TOOLS.map(({ value, label, Icon }) => (
            <button key={value} type="button" aria-label={label + ' terrain'}
              title={label + (value === 'measure' || value === 'profile' ? ' · select two points' : '')}
              aria-pressed={tool === value} disabled={!field && value !== 'navigate'}
              className={tool === value ? 'active' : ''}
              onClick={() => { setTool(value); setInspectionPoints([]); setHoverPoint(null); }}>
              <Icon size={15} /><span>{label}</span>
            </button>
          ))}
        </div>
        <div className="nh-viewport-toolbar-right">
          {effectiveMode !== '3d' && effectiveMode !== 'compare' && (
            <button type="button" className={`nh-viewport-tool ${showLayers ? 'active' : ''}`}
              title="Map overlays" aria-label="Map overlays" aria-expanded={showLayers}
              onClick={() => setShowLayers(v => !v)}>
              <Layers2 size={16} /><span>Layers</span>
            </button>
          )}
          {effectiveMode !== '3d' && effectiveMode !== 'compare' && (
            <label className="nh-channel-select">
              <TerrainIcon name={MAP_ICON_NAMES[channel]} height={16} />
              <select
                aria-label="Map channel"
                value={channel}
                onChange={(event) => onChannelChange(event.target.value as MapChannel)}
              >
                {CHANNEL_GROUPS.map(group => (
                  <optgroup key={group.label} label={group.label}>
                    {CHANNELS.filter(c => (group.values as readonly string[]).includes(c.value))
                      .map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </optgroup>
                ))}
              </select>
              <ChevronDown size={12} />
            </label>
          )}
          <button type="button" className="nh-viewport-tool"
            title={baseline ? `Replace baseline: ${baseline.label}` : 'Pin baseline for comparison'}
            aria-label={baseline ? 'Replace comparison baseline' : 'Pin comparison baseline'}
            disabled={!field || busy || stale} onClick={onCaptureBaseline}>
            <Pin size={15} />
            <span>{baseline ? 'Pinned' : 'Pin'}</span>
          </button>
          {baseline && (
            <button type="button" className="nh-viewport-tool" title="Clear comparison baseline"
              aria-label="Clear comparison baseline"
              onClick={() => {
                if (effectiveMode === 'compare') onViewModeChange('2d');
                onClearBaseline();
              }}><PinOff size={15} /></button>
          )}
          <button type="button" className="nh-viewport-tool"
            title={focusMode ? 'Exit viewport focus mode (F)' : 'Focus viewport (F)'}
            aria-label={focusMode ? 'Exit viewport focus mode' : 'Focus viewport'}
            aria-pressed={focusMode}
            onClick={() => onFocusModeChange(!focusMode)}>
            {focusMode ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            <span>{focusMode ? 'Restore' : 'Focus'}</span>
          </button>
          {effectiveMode !== '2d' && (
            <button
              className={`nh-viewport-tool ${showSettings ? 'active' : ''}`}
              type="button"
              title="Display settings"
              aria-label="Display settings"
              aria-expanded={showSettings}
              onClick={() => setShowSettings((v) => !v)}
            >
              <Settings2 size={16} />
              <span>Display</span>
              <ChevronDown size={12} />
            </button>
          )}
        </div>
      </div>
      <div className={`nh-preview-surface nh-mode-${effectiveMode}`}>
        <div
          className="nh-three-pane"
          style={{ display: effectiveMode === '2d' || effectiveMode === 'compare' ? 'none' : undefined,
            flex: effectiveMode === 'split' ? `0 0 ${splitRatio}%` : undefined }}
        >
          <div className="nh-three-host" ref={hostRef} />
          {field && (
            <>
              <div className="nh-viewport-coordinate">
                <button type="button" className="nh-compass-control"
                  aria-label="Face north" title="Face north · compass follows camera"
                  onClick={() => sceneRef.current?.orientCamera(0)}>
                  <span className="nh-compass" style={{ transform: `rotate(${cameraHeading}deg)` }}>
                    N<span />
                  </span>
                </button>
                <div>
                  <span>
                    {settings.material === 'alpine'
                      ? 'ALPINE'
                      : settings.material === 'pbr'
                        ? 'PBR MATERIAL'
                      : settings.material === 'clay'
                        ? 'CLAY'
                        : 'ELEVATION'}
                  </span>
                  <small>{settings.exaggeration.toFixed(1)}× vertical scale</small>
                </div>
              </div>
              <div className="nh-three-tools" role="group" aria-label="Camera controls">
                <button
                  type="button"
                  aria-label="Reset 3D camera"
                  title="Reset camera"
                  onClick={() => sceneRef.current?.resetCamera()}
                >
                  <Focus size={16} />
                </button>
                <button
                  type="button"
                  aria-label="View terrain from above"
                  title="Top view"
                  onClick={() => sceneRef.current?.topView()}
                >
                  <Grid2X2 size={16} />
                </button>
                <button type="button" aria-label="Camera bookmarks"
                  title="Camera views and bookmarks"
                  aria-expanded={showBookmarks}
                  onClick={() => setShowBookmarks(v => !v)}>
                  <Bookmark size={16} />
                </button>
                <button
                  type="button"
                  aria-label="Download preview image"
                  title="Save preview image"
                  onClick={() => sceneRef.current?.downloadSnapshot(project.name)}
                >
                  <Camera size={16} />
                </button>
              </div>
              {showBookmarks && (
                <div className="nh-camera-bookmarks" role="region" aria-label="Saved camera views">
                  <div className="nh-bookmarks-header">
                    <strong>Camera views</strong>
                    <button type="button" aria-label="Close camera views"
                      onClick={() => setShowBookmarks(false)}><X size={13}/></button>
                  </div>
                  <div className="nh-cardinal-buttons" role="group" aria-label="Face direction">
                    {[['N', 0], ['E', 90], ['S', 180], ['W', 270]].map(([name, angle]) => (
                      <button key={name} type="button" aria-label={`Face ${name}`}
                        onClick={() => sceneRef.current?.orientCamera(Number(angle))}>{name}</button>
                    ))}
                  </div>
                  <button type="button" className="nh-save-bookmark"
                    onClick={() => {
                      const camera = sceneRef.current?.captureCamera();
                      if (!camera) return;
                      setBookmarks(old => [...old.slice(-7), {
                        ...camera, name: `View ${old.length + 1}`,
                      }]);
                    }}>
                    <BookmarkPlus size={14}/> Save current view
                  </button>
                  {bookmarks.length === 0 && <small>No saved views yet.</small>}
                  {bookmarks.map((bookmark, index) => (
                    <div className="nh-bookmark-item" key={index}>
                      <button type="button" onClick={() => {
                        sceneRef.current?.restoreCamera(bookmark);
                        setShowBookmarks(false);
                      }}>{bookmark.name}</button>
                      <button type="button" aria-label={`Delete ${bookmark.name}`}
                        onClick={() => setBookmarks(old => old.filter((_, i) => i !== index))}>
                        <Trash2 size={13}/>
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="nh-view-hint">
                Drag to orbit<span>·</span>Right-drag to pan<span>·</span>Double-click to focus<span>·</span>Scroll to zoom
              </div>
              <div
                className="nh-scene-resolution"
                title="Adaptive triangle count from the current camera view. Original heightfields and exports remain at their full source resolution."
              >
                {meshTriangles > 0
                  ? `${new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(meshTriangles)} tris · ${settings.meshQuality}`
                  : 'Adaptive mesh'}
              </div>
            </>
          )}
        </div>
        {effectiveMode === 'split' && (
          <div className="nh-split-divider" role="separator" aria-label="Resize 3D and map views"
            aria-orientation={compactSplit ? 'horizontal' : 'vertical'}
            aria-valuemin={22} aria-valuemax={78}
            aria-valuenow={Math.round(splitRatio)} tabIndex={0}
            onPointerDown={e => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); }}
            onPointerMove={e => {
              if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
              const rect = e.currentTarget.parentElement?.getBoundingClientRect();
              if (rect) setSplitRatio(Math.max(22, Math.min(78,
                compactSplit ? (e.clientY - rect.top) / rect.height * 100
                  : (e.clientX - rect.left) / rect.width * 100)));
            }}
            onPointerUp={e => {
              if (e.currentTarget.hasPointerCapture(e.pointerId))
                e.currentTarget.releasePointerCapture(e.pointerId);
            }}
            onKeyDown={e => {
              if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
                e.preventDefault();
                const increment = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 5 : -5;
                setSplitRatio(r => Math.max(22, Math.min(78, r + increment)));
              } else if (e.key === 'Home') { e.preventDefault(); setSplitRatio(50); }
            }}><span /></div>
        )}
        {effectiveMode !== '3d' && (
          <div className="nh-map-pane">
            <MapCanvas field={field} channel={effectiveMode === 'compare' ? 'terrain' : channel}
              project={project} spline={spline} splineEditing={splineEditing}
              onSplinePath={onSplinePath}
              initialFraming={mapFraming.current}
              onFramingChange={next => { mapFraming.current = next; }}
              tool={tool} hoverPoint={hoverPoint} inspectionPoints={inspectionPoints}
              onHoverPoint={setHoverPoint} onChoosePoint={choosePoint}
              baseline={effectiveMode === 'compare' && baseline?.project.worldSize === project.worldSize
                ? baseline : null}
              compareKind={compareKind} wipe={wipe}
              overlayChannel={effectiveMode === 'compare' ? null : overlayChannel}
              overlayOpacity={overlayOpacity} />
            {effectiveMode !== 'compare' && <MapLegend field={field} channel={channel} project={project} />}
          </div>
        )}
        {showLayers && effectiveMode !== '3d' && effectiveMode !== 'compare' && (
          <div className="nh-overlay-panel" role="region" aria-label="Map overlays">
            <div className="nh-overlay-heading">
              <strong>Map overlay</strong>
              <button type="button" aria-label="Close map overlays"
                onClick={() => setShowLayers(false)}><X size={14}/></button>
            </div>
            <label>Layer
              <select aria-label="Overlay channel" value={overlayChannel ?? ''}
                onChange={e => setOverlayChannel(e.target.value ?
                  e.target.value as MapChannel : null)}>
                <option value="">No overlay</option>
                {CHANNELS.filter(c => ['slope', 'flow', 'wear', 'deposition', 'normal']
                  .includes(c.value)).map(c =>
                    <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </label>
            {overlayChannel && <label>Opacity <b>{overlayOpacity}%</b>
              <input type="range" aria-label="Overlay opacity" min="5" max="100"
                step="5" value={overlayOpacity}
                onChange={e => setOverlayOpacity(Number(e.target.value))}/>
            </label>}
            <small>Display-only overlay; source and exports stay unchanged.</small>
          </div>
        )}
        {effectiveMode === 'compare' && baseline && (
          <div className="nh-compare-panel">
            <strong>{baseline.label} → {previewLabel}</strong>
            {baseline.project.worldSize !== project.worldSize ?
              <span>Cannot compare different tile widths. Restore the original tile width.</span> : (
                <>
                  <div className="nh-compare-kinds" role="group" aria-label="Comparison style">
                    <button type="button" aria-pressed={compareKind === 'wipe'}
                      className={compareKind === 'wipe' ? 'active' : ''}
                      onClick={() => setCompareKind('wipe')}>Before / after wipe</button>
                    <button type="button" aria-pressed={compareKind === 'difference'}
                      className={compareKind === 'difference' ? 'active' : ''}
                      onClick={() => setCompareKind('difference')}>Elevation change</button>
                  </div>
                  {compareKind === 'wipe' &&
                    <label className="nh-compare-wipe">
                      <span>Baseline {wipe}%</span>
                      <input type="range" aria-label="Before after wipe position"
                        min="0" max="100" step="1" value={wipe}
                        onChange={e => setWipe(Number(e.target.value))} />
                      <span>Current {100 - wipe}%</span>
                    </label>}
                </>
            )}
          </div>
        )}
        {field && tool !== 'navigate' && (
          <div className="nh-inspection-readout" role="status" aria-live="off">
            <div className="nh-inspect-header">
              <strong>{tool === 'profile' ? 'Elevation profile' : tool === 'measure'
                ? 'Measure terrain' : 'Terrain inspector'}</strong>
              {inspectionPoints.length > 0 && (
                <button type="button" aria-label="Clear sample points"
                  title="Clear sample points" onClick={() => setInspectionPoints([])}>
                  <X size={14} />
                </button>
              )}
            </div>
            {activeSample ? (
              <>
                <div className="nh-inspect-values">
                  <span>E {formatMeters(activeSample.easting)}</span>
                  <span>N {formatMeters(activeSample.northing)}</span>
                  <b>{formatMeters(activeSample.elevation)} elevation</b>
                  <span>{activeSample.slope.toFixed(1)}° slope</span>
                  <span>Flow {activeSample.flow.toPrecision(3)}</span>
                </div>
                {profile && tool !== 'inspect' && (
                  <div className="nh-measure-results">
                    <span>Distance <b>{formatMeters(profile.horizontalDistance)}</b></span>
                    <span>Δ elev. <b>{formatMeters(profile.elevationChange)}</b></span>
                    <span>Grade <b>{profile.grade.toFixed(1)}%</b></span>
                    <span>Surface <b>{formatMeters(profile.surfaceDistance)}</b></span>
                    {tool === 'profile' && (() => {
                      const heights = profile.samples.map(sample => sample.elevation);
                      const min = Math.min(...heights), max = Math.max(...heights);
                      const span = Math.max(1, max - min);
                      const points = heights.map((h, i) =>
                        `${(i / (heights.length - 1) * 280).toFixed(2)},${(78 - (h - min) / span * 64).toFixed(2)}`).join(' ');
                      return (
                        <svg className="nh-profile-chart" role="img" aria-label="Terrain elevation profile"
                          viewBox="0 0 280 90" preserveAspectRatio="none">
                          <line x1="0" y1="78" x2="280" y2="78" stroke="currentColor" opacity=".3" />
                          <polyline points={points} fill="none" stroke="#83c4b0" strokeWidth="2"
                            strokeLinejoin="round" strokeLinecap="round" />
                          <text x="3" y="11" fontSize="9" fill="currentColor">
                            {formatMeters(max)}</text>
                          <text x="3" y="89" fontSize="9" fill="currentColor">
                            {formatMeters(min)}</text>
                        </svg>
                      );
                    })()}
                  </div>
                )}
              </>
            ) : <span>Click a terrain point to begin.</span>}
            {(tool === 'measure' || tool === 'profile') && inspectionPoints.length < 2 &&
              <small>{inspectionPoints.length === 0 ? 'Choose point A' : 'Choose point B'}</small>}
          </div>
        )}
        <div className="nh-preview-source">
          <span
            className={
              busy ? 'nh-source-dot busy' : stale ? 'nh-source-dot stale' : 'nh-source-dot'
            }
          />
          <span>{previewLabel}</span>
          {stale && !busy && <em>Out of date</em>}
        </div>
        {sceneError && (
          <div className="nh-render-error">
            <span>{sceneError}</span>
            <button type="button" onClick={() => setAttempt((v) => v + 1)}>
              Retry 3D
            </button>
          </div>
        )}
        {!field && (
          <div className="nh-preview-empty">
            <div className="nh-empty-mark">
              <Mountain size={34} strokeWidth={1} />
            </div>
            <strong>{busy ? 'Building your landscape' : 'Your landscape starts here'}</strong>
            <span>
              {busy
                ? stage || 'Preparing terrain pipeline…'
                : 'Connect a source to the output, then build your terrain.'}
            </span>
            {busy && <LoaderCircle className="nh-spin" size={17} />}
          </div>
        )}
        {busy && (
          <div className="nh-render-progress" role="status">
            <div className="nh-progress-track">
              <span style={{ width: `${progressPercent}%` }} />
            </div>
            <LoaderCircle size={13} className="nh-spin" />
            <span>{stage || 'Evaluating terrain'}</span>
            <b>{Math.round(progressPercent)}%</b>
            <button
              type="button"
              title="Cancel generation"
              aria-label="Cancel generation"
              onClick={onCancel}
            >
              <X size={14} />
            </button>
          </div>
        )}
        {showSettings && effectiveMode !== '2d' && (
          <div className="nh-display-panel" ref={displayPanel}
            role="region" aria-label="Display settings">
            <div className="nh-display-title">
              <span>DISPLAY SETTINGS</span>
              <button
                type="button"
                aria-label="Close display settings"
                onClick={() => setShowSettings(false)}
              >
                <X size={14} />
              </button>
            </div>
            <label className="nh-display-label">Surface</label>
            <div className="nh-material-options">
              {(['pbr', 'alpine', 'clay', 'height'] as const).map((material) => (
                <button
                  key={material}
                  type="button"
                  aria-pressed={settings.material === material}
                  className={settings.material === material ? 'active' : ''}
                  onClick={() => change({ material })}
                >
                  <span className={`nh-material-swatch nh-swatch-${material}`} />
                  <span>
                    {material === 'height'
                      ? 'Height'
                      : material === 'pbr' ? 'PBR'
                      : material[0].toUpperCase() + material.slice(1)}
                  </span>
                  {settings.material === material && <Check size={11} />}
                </button>
              ))}
            </div>
            <div className="nh-display-divider" />
            <div className="nh-display-section-heading"><CloudSun size={13} /> Atmosphere & lighting</div>
            <div className="nh-sky-presets" role="group" aria-label="Sky lighting presets">
              {([
                { key: 'clear', label: 'Clear day', sunAzimuth: 265, sunElevation: 57,
                  skyTurbidity: 2.5, skyRayleigh: 2.2, skyExposure: 0.96,
                  cloudCoverage: 0.12 },
                { key: 'golden', label: 'Golden hour', sunAzimuth: 252, sunElevation: 11,
                  skyTurbidity: 5.5, skyRayleigh: 2.9, skyExposure: 1.04,
                  cloudCoverage: 0.29 },
                { key: 'overcast', label: 'Overcast', sunAzimuth: 315, sunElevation: 36,
                  skyTurbidity: 7.5, skyRayleigh: 1.8, skyExposure: 0.92,
                  cloudCoverage: 0.88 },
              ] as const).map(({ key, label, ...preset }) => (
                <button
                  key={key}
                  className="nh-sky-preset"
                  type="button"
                  aria-label={`${label} sky preset`}
                  onClick={() => change({ ...preset, skyEnabled: true })}
                >
                  <span className={`nh-sky-preset-swatch nh-sky-preset-${key}`} aria-hidden="true" />
                  <span>{label}</span>
                </button>
              ))}
            </div>
            <label className="nh-display-check">
              <input
                type="checkbox"
                aria-label="Enable sky dome"
                checked={settings.skyEnabled}
                onChange={(e) => change({ skyEnabled: e.target.checked })}
              />
              <span>Enable sky dome</span>
            </label>
            <p className="nh-display-help">
              Physical sky light, sun color, atmosphere and PBR reflections respond to these controls.
            </p>
            <label className="nh-display-range">
              <span>
                <Sun size={13} />
                Sun direction<b>{Math.round(settings.sunAzimuth)}°</b>
              </span>
              <input
                aria-label="Sun direction"
                type="range"
                min="0"
                max="360"
                step="1"
                value={settings.sunAzimuth}
                onChange={(e) => change({ sunAzimuth: Number(e.target.value) })}
              />
            </label>
            <label className="nh-display-range">
              <span>
                Sun elevation<b>{Math.round(settings.sunElevation)}°</b>
              </span>
              <input
                aria-label="Sun elevation"
                type="range"
                min="2"
                max="85"
                step="1"
                value={settings.sunElevation}
                onChange={(e) => change({ sunElevation: Number(e.target.value) })}
              />
            </label>
            {settings.skyEnabled && (
              <div className="nh-display-subsection">
                <label className="nh-display-range">
                  <span>Atmospheric haze<b>{settings.skyTurbidity.toFixed(1)}</b></span>
                  <input aria-label="Atmospheric haze" type="range" min="1" max="16" step="0.5"
                    value={settings.skyTurbidity} onChange={(e) => change({ skyTurbidity: Number(e.target.value) })} />
                </label>
                <label className="nh-display-range">
                  <span>Rayleigh scattering<b>{settings.skyRayleigh.toFixed(1)}</b></span>
                  <input aria-label="Rayleigh scattering" type="range" min="0.2" max="4" step="0.1"
                    value={settings.skyRayleigh} onChange={(e) => change({ skyRayleigh: Number(e.target.value) })} />
                </label>
                <label className="nh-display-range">
                  <span>Sky exposure<b>{settings.skyExposure.toFixed(2)}×</b></span>
                  <input aria-label="Sky exposure" type="range" min="0.6" max="1.5" step="0.05"
                    value={settings.skyExposure} onChange={(e) => change({ skyExposure: Number(e.target.value) })} />
                </label>
                <label className="nh-display-range">
                  <span><CloudSun size={13} /> Cloud cover<b>{Math.round(settings.cloudCoverage * 100)}%</b></span>
                  <input aria-label="Cloud cover" type="range" min="0" max="1" step="0.01"
                    value={settings.cloudCoverage} onChange={(e) => change({ cloudCoverage: Number(e.target.value) })} />
                </label>
                <label className="nh-display-range">
                  <span>Cloud shadow strength<b>{Math.round(settings.cloudShadowStrength * 100)}%</b></span>
                  <input aria-label="Cloud shadow strength" type="range" min="0" max="1" step="0.05"
                    value={settings.cloudShadowStrength}
                    onChange={(e) => change({ cloudShadowStrength: Number(e.target.value) })} />
                </label>
              </div>
            )}
            <label className="nh-display-range">
              <span><Wind size={13} /> Wind speed<b>{settings.cloudSpeed.toFixed(2)}×</b></span>
              <input aria-label="Wind speed" type="range" min="0" max="2" step="0.05"
                value={settings.cloudSpeed} onChange={(e) => change({ cloudSpeed: Number(e.target.value) })} />
            </label>
            <div className="nh-display-divider" />
            <div className="nh-display-section-heading"><Sprout size={13} /> Landscape context</div>
            <label className="nh-display-check">
              <input
                type="checkbox"
                aria-label="Expand ground"
                checked={settings.expandGround}
                onChange={(e) => change({ expandGround: e.target.checked })}
              />
              <span>Expand ground · textured meadow</span>
            </label>
            {settings.expandGround && (
              <div className="nh-display-subsection">
                <label className="nh-display-range">
                  <span>Ground reach<b>{settings.groundReach.toFixed(1)}×</b></span>
                  <input aria-label="Ground reach" type="range" min="3" max="8" step="0.5"
                    value={settings.groundReach} onChange={(e) => change({ groundReach: Number(e.target.value) })} />
                </label>
                <p className="nh-display-help">The meadow flattens beyond the heightmap boundary.
                  Your generated terrain and exported maps stay untouched.</p>
              </div>
            )}
            <div className="nh-display-divider" />
            <label className="nh-display-range">
              <span>
                Vertical scale<b>{settings.exaggeration.toFixed(1)}×</b>
              </span>
              <input
                aria-label="Vertical exaggeration"
                type="range"
                min="0.5"
                max="3"
                step="0.1"
                value={settings.exaggeration}
                onChange={(e) => change({ exaggeration: Number(e.target.value) })}
              />
            </label>
            <p className="nh-display-help">
              Preview scale only. Exported elevations stay unchanged.
            </p>
            <div className="nh-display-divider" />
            <label className="nh-display-check">
              <input
                type="checkbox"
                checked={settings.contours}
                onChange={(e) => change({ contours: e.target.checked })}
              />
              <span>100 m contours</span>
            </label>
            <label className="nh-display-check">
              <input
                type="checkbox"
                checked={settings.wireframe}
                onChange={(e) => change({ wireframe: e.target.checked })}
              />
              <span>Wireframe</span>
            </label>
            <label className="nh-display-check">
              <input
                type="checkbox"
                checked={settings.autoRotate}
                onChange={(e) => change({ autoRotate: e.target.checked })}
              />
              <span>Slow orbit</span>
            </label>
            <button
              type="button"
              className="nh-display-reset"
              onClick={() => {
                onSettingsChange({ ...DEFAULT_VIEW_SETTINGS });
                sceneRef.current?.resetCamera();
              }}
            >
              <RotateCcw size={12} />
              Reset display
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
