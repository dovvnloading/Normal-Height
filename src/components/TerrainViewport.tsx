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
} from 'lucide-react';
import type {
  HeightField,
  MapChannel,
  TerrainProject,
  ViewMode,
  ViewSettings,
} from '../model/types';
import { TerrainScene } from '../render/TerrainScene';
import { TerrainIcon, MAP_ICON_NAMES } from './TerrainIcon';
import { colorizeMap, sampleSlope } from '../render/maps';
import { pbrPixels } from '../materials/pbr';
import { requestPBR } from '../materials/pbrClient';
import type { PBRChannel } from '../materials/pbr';
import { DEFAULT_SPLINE_PATH, insertSplinePoint, sampleSpline } from '../model/splines';
import type { SplinePoint } from '../model/splines';
import type { TerrainNode } from '../model/types';
import './TerrainViewport.css';

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
  { value: 'curvature', label: 'PBR curvature' },
  { value: 'orm', label: 'Packed ORM' },
];

function MapCanvas({
  field,
  channel,
  project,
  spline,
  splineEditing,
  onSplinePath,
}: {
  field: HeightField | null;
  channel: MapChannel;
  project: TerrainProject;
  spline: TerrainNode | null;
  splineEditing: boolean;
  onSplinePath: (path: SplinePoint[]) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLCanvasElement | null>(null);
  const [rasterVersion, setRasterVersion] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [sample, setSample] = useState<{
    x: number;
    y: number;
    elevation: number;
    value: string;
  } | null>(null);
  const [dimensions, setDimensions] = useState({ width: 100, height: 100 });
  const drag = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
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
    if (!field) {
      imageRef.current = null;
      setRasterVersion((version) => version + 1);
      return;
    }
    const paintPixels = (source: Uint8ClampedArray) => {
      if (!active) return;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = field.resolution;
      const context = canvas.getContext('2d');
      if (!context) return;
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
      const image = context.createImageData(field.resolution, field.resolution);
      image.data.set(pixels);
      context.putImageData(image, 0, 0);
      imageRef.current = canvas;
      // The visible canvas must repaint for every newly generated map. Changing
      // surface settings/seed does not necessarily change field or view state.
      setRasterVersion((version) => version + 1);
    };
    const material = ['basecolor', 'roughness', 'ao', 'splat', 'curvature', 'orm'].includes(channel);
    if (material) {
      const request = requestPBR(field, project);
      request.promise.then((maps) =>
        paintPixels(pbrPixels(maps, field, project, channel as PBRChannel))
      ).catch(() => {
        // A replaced or unmounted request is expected; the next edit queues
        // the correct version without showing a stale worker result.
      });
      return () => { active = false; request.release(); };
    }
    paintPixels(colorizeMap(field, channel, project.worldSize, project.heightScale));
    return () => { active = false; };
  }, [field, channel, project.worldSize, project.heightScale, project.surface, project.seed]);

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
  }, [dimensions, zoom, offset, rasterVersion, field, channel, project.worldSize, project.heightScale]);

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
    if (drag.current) {
      setOffset({
        x: drag.current.startX + event.clientX - drag.current.x,
        y: drag.current.startY + event.clientY - drag.current.y,
      });
      return;
    }
    if (!field) return;
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
          if (event.button !== 0 && event.button !== 1) return;
          drag.current = { x: event.clientX, y: event.clientY, startX: offset.x, startY: offset.y };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={inspect}
        onPointerUp={(event) => {
          drag.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onPointerLeave={() => setSample(null)}
        onKeyDown={(event) => {
          if (event.key === 'Home') {
            setZoom(1);
            setOffset({ x: 0, y: 0 });
          }
          if (event.key === '+' || event.key === '=') setZoom((v) => Math.min(12, v * 1.2));
          if (event.key === '-') setZoom((v) => Math.max(0.35, v / 1.2));
        }}
      />
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
    if (['basecolor', 'roughness', 'ao', 'splat', 'curvature', 'orm'].includes(channel)) {
      return { label: channel === 'splat' ? 'R rock · G soil · B vegetation · A snow'
        : channel === 'orm' ? 'R occlusion · G roughness · B metallic'
          : CHANNELS.find(c => c.value === channel)?.label ?? 'PBR map',
        start: channel === 'curvature' ? 'Concave' : '0',
        end: channel === 'curvature' ? 'Convex' : '1',
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
}: TerrainViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<TerrainScene | null>(null);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const effectiveMode = sceneError ? '2d' : viewMode;

  useEffect(() => {
    if (!hostRef.current) return;
    try {
      sceneRef.current = new TerrainScene(hostRef.current, settingsRef.current, setSceneError, theme);
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
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [showSettings]);

  const change = (patch: Partial<ViewSettings>) => onSettingsChange({ ...settings, ...patch });
  const progressPercent = Math.max(0, Math.min(100, progress <= 1 ? progress * 100 : progress));
  const meshResolution = field ? Math.min(512, field.resolution) : 0;

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
        </div>
        <div className="nh-viewport-toolbar-right">
          {effectiveMode !== '3d' && (
            <label className="nh-channel-select">
              <TerrainIcon name={MAP_ICON_NAMES[channel]} height={16} />
              <select
                aria-label="Map channel"
                value={channel}
                onChange={(event) => onChannelChange(event.target.value as MapChannel)}
              >
                {CHANNELS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
              <ChevronDown size={12} />
            </label>
          )}
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
          style={{ display: effectiveMode === '2d' ? 'none' : undefined }}
        >
          <div className="nh-three-host" ref={hostRef} />
          {field && (
            <>
              <div className="nh-viewport-coordinate">
                <span className="nh-compass">
                  N<span />
                </span>
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
                <button
                  type="button"
                  aria-label="Download preview image"
                  title="Save preview image"
                  onClick={() => sceneRef.current?.downloadSnapshot(project.name)}
                >
                  <Camera size={16} />
                </button>
              </div>
              <div className="nh-view-hint">
                Drag to orbit<span>·</span>Right-drag to pan<span>·</span>Scroll to zoom
              </div>
              <div
                className="nh-scene-resolution"
                title="Actual mesh resolution; the heightfield retains its full simulation resolution"
              >
                {meshResolution}² mesh
              </div>
            </>
          )}
        </div>
        {effectiveMode !== '3d' && (
          <div className="nh-map-pane">
            <MapCanvas field={field} channel={channel} project={project} spline={spline} splineEditing={splineEditing} onSplinePath={onSplinePath} />
            <MapLegend field={field} channel={channel} project={project} />
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
          <div className="nh-display-panel" role="dialog" aria-label="Display settings">
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
              <span>Expand ground · grassy meadow</span>
            </label>
            {settings.expandGround && (
              <div className="nh-display-subsection">
                <label className="nh-display-range">
                  <span>Ground reach<b>{settings.groundReach.toFixed(1)}×</b></span>
                  <input aria-label="Ground reach" type="range" min="3" max="8" step="0.5"
                    value={settings.groundReach} onChange={(e) => change({ groundReach: Number(e.target.value) })} />
                </label>
                <label className="nh-display-range">
                  <span>Grass density<b>{Math.round(settings.grassDensity * 100)}%</b></span>
                  <input aria-label="Grass density" type="range" min="0.2" max="1.5" step="0.05"
                    value={settings.grassDensity} onChange={(e) => change({ grassDensity: Number(e.target.value) })} />
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
                change({
                  material: 'pbr',
                  sunAzimuth: 315,
                  sunElevation: 38,
                  exaggeration: 1,
                  contours: false,
                  wireframe: false,
                  autoRotate: false,
                  skyEnabled: true,
                  skyTurbidity: 4.5,
                  skyRayleigh: 2.2,
                  skyExposure: 1,
                  cloudCoverage: 0.42,
                  cloudSpeed: 0.35,
                  expandGround: false,
                  groundReach: 5,
                  grassDensity: 0.75,
                });
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
