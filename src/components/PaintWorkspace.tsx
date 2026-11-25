import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Blend,
  Check,
  ChevronDown,
  Copy,
  Eraser,
  Eye,
  EyeOff,
  Hand,
  Keyboard,
  Layers,
  LockKeyhole,
  PaintBucket,
  Paintbrush,
  PanelRightClose,
  PanelRightOpen,
  Pipette,
  Plus,
  Redo2,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  SquareDashedMousePointer,
  Trash2,
  Undo2,
  UnlockKeyhole,
  X,
} from 'lucide-react';
import {
  BRUSH_PRESETS,
  DEFAULT_BRUSH_SETTINGS,
  applyBrushPreset,
  normalizeBrushSettings,
  type BrushInputSettings,
} from '../materials/brushPresets';
import {
  MAX_PAINT_POINTS,
  MAX_PAINT_STROKES,
  type MaterialLayer,
  type PaintMask,
  type PaintSelection,
} from '../materials/materialPaint';
import { createPaintLayer, MAX_PAINT_LAYERS, paintCapacity, type PaintLayer } from '../materials/paintLayers';
import type { TerrainProject } from '../model/types';
import { SPLAT_LAYERS, layerColorHex, type SurfaceSettings } from '../materials/pbr';
import { NumberField } from './Controls';
import {
  MaterialBrushControls,
  MaterialSwatch,
  MATERIAL_NAMES,
  PaintNumberControl,
} from './MaterialBrush';
import './PaintWorkspace.css';

export interface PaintWorkspaceProps {
  children: ReactNode;
  active?: boolean;
  settings: BrushInputSettings;
  previousLayer: MaterialLayer;
  worldSize: number;
  resolution: number;
  screenRadiusScale?: number;
  elevationRange?: [number, number];
  surface: SurfaceSettings;
  onSettingsChange: (settings: BrushInputSettings) => void;
  onLayerColor: (layer: MaterialLayer, color: string) => void;
  project: TerrainProject;
  layers: PaintLayer[];
  activeLayerId: string;
  onSelectLayer: (id: string) => void;
  onLayersChange: (layers: PaintLayer[]) => boolean;
  before: boolean;
  onBeforeChange: (before: boolean) => void;
  status?: string;
  disabledReason?: string;
  picking: boolean;
  onPickingChange: (picking: boolean) => void;
  selecting: boolean;
  onSelectingChange: (selecting: boolean) => void;
  selection: PaintSelection | null;
  onSelectionChange: (selection: PaintSelection | null) => void;
  onFill: (kind: 'selection' | 'connected' | 'replace') => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
}

type InspectorTab = 'materials' | 'brush' | 'layers';
interface SavedBrush {
  id: string;
  name: string;
  settings: BrushInputSettings;
}
const SAVED_BRUSHES_KEY = 'normal-height.paint-presets.v1';
const MAX_SAVED_BRUSHES = 24;
function readSavedBrushes(): SavedBrush[] {
  try {
    const raw = localStorage.getItem(SAVED_BRUSHES_KEY);
    if (!raw || raw.length > 500_000) return [];
    const input: unknown = JSON.parse(raw);
    if (!Array.isArray(input)) return [];
    const ids = new Set<string>();
    return input.slice(0, MAX_SAVED_BRUSHES).flatMap((value) => {
      if (
        !value ||
        typeof value !== 'object' ||
        typeof value.id !== 'string' ||
        value.id.length > 100 ||
        typeof value.name !== 'string' ||
        !value.name.trim() ||
        !value.settings ||
        typeof value.settings !== 'object' ||
        ids.has(value.id)
      )
        return [];
      ids.add(value.id);
      return [
        {
          id: value.id,
          name: value.name.trim().slice(0, 48),
          settings: normalizeBrushSettings(value.settings),
        },
      ];
    });
  } catch {
    return [];
  }
}
const MATERIAL_DESCRIPTIONS: Record<MaterialLayer, string> = {
  rock: 'Mineral faces & broken outcrops',
  soil: 'Loose earth & weathered ground',
  vegetation: 'Meadows, moss & low growth',
  snow: 'Powder, firn & alpine cover',
};

function SelectControl({
  label,
  value,
  children,
  onChange,
}: {
  label: string;
  value: string;
  children: ReactNode;
  onChange: (value: string) => void;
}) {
  return (
    <label className="nh-paint-select-control">
      <span>{label}</span>
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
    </label>
  );
}

function MaskEditor({
  mask,
  onChange,
  elevationRange,
  worldSize,
  scope,
}: {
  mask?: PaintMask;
  onChange: (mask: PaintMask | undefined) => void;
  elevationRange: [number, number];
  worldSize: number;
  scope: string;
}) {
  const update = (patch: Partial<PaintMask>) => onChange({ ...mask, ...patch });
  const ranges: {
    key: 'elevation' | 'slope' | 'flow' | 'curvature' | 'aspect';
    label: string;
    defaults: [number, number];
    min: number;
    max: number;
    step: number;
    unit?: string;
    hint: string;
  }[] = [
    {
      key: 'elevation',
      label: 'Elevation',
      defaults: elevationRange,
      min: -1e6,
      max: 1e6,
      step: 1,
      unit: 'm',
      hint: 'Use physical terrain height in meters.',
    },
    {
      key: 'slope',
      label: 'Slope',
      defaults: [0, 45],
      min: 0,
      max: 90,
      step: 1,
      unit: '°',
      hint: '0° is flat ground; 90° is a vertical face.',
    },
    {
      key: 'flow',
      label: 'Water flow',
      defaults: [0.2, 1],
      min: 0,
      max: 1,
      step: 0.01,
      hint: 'Restrict paint to the terrain’s runoff field.',
    },
    {
      key: 'curvature',
      label: 'Curvature',
      defaults: [-1, 0],
      min: -1,
      max: 1,
      step: 0.01,
      hint: 'Negative values select ridges; positive values select valleys.',
    },
    {
      key: 'aspect',
      label: 'Facing direction',
      defaults: [315, 45],
      min: 0,
      max: 360,
      step: 1,
      unit: '°',
      hint: 'Compass degrees. 315°–45° wraps across north.',
    },
  ];
  return (
    <div className="nh-paint-mask-editor">
      <p className="nh-paint-help">
        Enabled rules combine. Paint reaches only the terrain that matches every rule.
      </p>
      {ranges.map(({ key, label, defaults, min, max, step, unit, hint }) => {
        const range = mask?.[key];
        const setRange = (index: 0 | 1, next: number) => {
          const values: [number, number] = [...(range ?? defaults)];
          values[index] = next;
          if (key !== 'aspect' && values[0] > values[1]) values[index === 0 ? 1 : 0] = next;
          update({ [key]: values });
        };
        return (
          <div className="nh-paint-mask-rule" key={key}>
            <label className="nh-paint-check">
              <input
                type="checkbox"
                checked={!!range}
                aria-label={`${scope} ${label.toLowerCase()} constraint`}
                onChange={(e) => {
                  if (e.target.checked) update({ [key]: defaults });
                  else {
                    const next = { ...mask };
                    delete next[key];
                    onChange(Object.keys(next).length ? next : undefined);
                  }
                }}
              />
              <span>{label}</span>
            </label>
            {range && (
              <>
                <div className="nh-paint-range-pair">
                  <NumberField
                    label={`${scope} ${label.toLowerCase()} minimum`}
                    value={range[0]}
                    min={min}
                    max={max}
                    step={step}
                    unit={unit}
                    onChange={(next) => setRange(0, next)}
                  />
                  <span aria-hidden="true">to</span>
                  <NumberField
                    label={`${scope} ${label.toLowerCase()} maximum`}
                    value={range[1]}
                    min={min}
                    max={max}
                    step={step}
                    unit={unit}
                    onChange={(next) => setRange(1, next)}
                  />
                </div>
                <p className="nh-paint-help">{hint}</p>
              </>
            )}
          </div>
        );
      })}
      <PaintNumberControl
        label="Mask feather"
        sliderLabel={`${scope} feather`}
        value={Math.round((mask?.feather ?? 0.1) * 100)}
        unit="%"
        onChange={(value) => update({ feather: value / 100 })}
      />
      <PaintNumberControl
        label="Natural breakup"
        sliderLabel={`${scope} breakup`}
        value={Math.round((mask?.breakup ?? 0) * 100)}
        unit="%"
        onChange={(value) => update({ breakup: value / 100 })}
      />
      {!!mask?.breakup && (
        <PaintNumberControl
          label="Breakup scale"
          sliderLabel={`${scope} breakup scale`}
          value={mask.scale ?? Math.max(1, worldSize * 0.015)}
          min={0.1}
          max={Math.max(1, worldSize)}
          step={1}
          unit="m"
          logarithmic
          onChange={(value) => update({ scale: value })}
        />
      )}
      {mask && (
        <button type="button" className="nh-paint-text-button" onClick={() => onChange(undefined)}>
          <RotateCcw size={14} />
          Clear {scope.toLowerCase()} rules
        </button>
      )}
    </div>
  );
}

function BrushPreview({ settings, color }: { settings: BrushInputSettings; color: string }) {
  return (
    <div
      className="nh-paint-brush-preview"
      aria-label={`Brush falloff: ${Math.round(settings.hardness * 100)} percent hardness, ${Math.round(settings.strength * 100)} percent strength`}
      role="img"
    >
      <div
        style={
          {
            '--brush-pigment': color,
            '--brush-hardness': `${Math.min(98, settings.hardness * 100)}%`,
            opacity: settings.strength,
            transform: `rotate(${settings.angle ?? 0}deg) scaleY(${settings.aspect ?? 1})`,
          } as CSSProperties
        }
        className={`nh-paint-brush-footprint nh-paint-tip-${settings.texture ?? 'smooth'}`}
      />
      <span>
        {settings.layer === 'erase' ? (
          <Eraser size={15} />
        ) : settings.mode === 'blend' ? (
          <Blend size={15} />
        ) : (
          <Paintbrush size={15} />
        )}
      </span>
    </div>
  );
}

function LayerName({ layer, onChange }: { layer: PaintLayer; onChange: (name: string) => void }) {
  const [value, setValue] = useState(layer.name);
  const cancel = useRef(false);
  useEffect(() => setValue(layer.name), [layer.name, layer.id]);
  return (
    <input
      className="nh-paint-layer-name"
      aria-label="Paint layer name"
      value={value}
      maxLength={80}
      disabled={layer.locked}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        if (cancel.current) {
          cancel.current = false;
          return;
        }
        const name = value.trim() || layer.name;
        setValue(name);
        if (name !== layer.name) onChange(name);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          cancel.current = true;
          setValue(layer.name);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

export function PaintWorkspace(props: PaintWorkspaceProps) {
  const {
    children,
    active: studioActive = true,
    settings,
    previousLayer,
    worldSize,
    resolution,
    surface,
    project,
    layers,
    activeLayerId,
    onSelectLayer,
    onLayersChange,
    onSettingsChange,
    onLayerColor,
    before,
    onBeforeChange,
    picking,
    onPickingChange,
    selecting,
    onSelectingChange,
    selection,
    onSelectionChange,
    onFill,
    disabledReason,
    status,
    screenRadiusScale,
    elevationRange = [0, 10000],
    onUndo,
    onRedo,
    canUndo,
    canRedo,
  } = props;
  const host = useRef<HTMLElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const inspectorTrigger = useRef<HTMLButtonElement>(null);
  const [compact, setCompact] = useState(window.innerWidth < 1100);
  const [inspectorOpen, setInspectorOpen] = useState(window.innerWidth >= 1100);
  const [tab, setTab] = useState<InspectorTab>('brush');
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [maskScope, setMaskScope] = useState<'brush' | 'layer'>('brush');
  const [savedBrushes, setSavedBrushes] = useState<SavedBrush[]>(readSavedBrushes);
  const [savedBrushName, setSavedBrushName] = useState('');
  const [savedBrushMessage, setSavedBrushMessage] = useState('');
  const persistBrushes = (next: SavedBrush[], message: string) => {
    setSavedBrushes(next);
    try {
      localStorage.setItem(SAVED_BRUSHES_KEY, JSON.stringify(next));
      setSavedBrushMessage(message);
    } catch {
      setSavedBrushMessage('Available for this session. Browser storage is unavailable.');
    }
  };
  const active = layers.find((layer) => layer.id === activeLayerId) ?? layers.at(-1);
  const budget = paintCapacity(project);
  const { strokes, points } = budget;
  const capacity = Math.min(1, budget.ratio);
  const duplicateFits = !!active && layers.length < MAX_PAINT_LAYERS &&
    paintCapacity({ ...project, materialPaint: undefined, paintLayers: [...layers, {
      ...active, id: 'paint-00000000-0000-0000-0000-000000000000',
      name: `${active.name} copy`.slice(0, 80), locked: false,
    }] }).ratio <= 1;
  const effectiveDisabled = before
    ? 'Original surface preview. Return to Painted to continue.'
    : disabledReason;
  const layerDisabled = active?.locked || !active?.visible;
  const color = settings.layer === 'erase' ? '#729d9c' : layerColorHex(surface, settings.layer);
  const selectionReady = !!selection && (selection.points.length >= 3 || !!selection.region);
  const updateActive = (patch: Partial<PaintLayer>) => {
    if (active)
      onLayersChange(
        layers.map((layer) => (layer.id === active.id ? { ...layer, ...patch } : layer)),
      );
  };
  const addLayer = () => {
    const next = createPaintLayer(`Paint ${layers.length + 1}`);
    if (onLayersChange([...layers, next])) onSelectLayer(next.id);
  };
  const duplicateLayer = () => {
    if (!active || !duplicateFits) return;
    const next = {
      ...active,
      id: createPaintLayer().id,
      name: `${active.name} copy`.slice(0, 80),
      locked: false,
      strokes: [...active.strokes],
    };
    const index = layers.indexOf(active);
    if (onLayersChange([...layers.slice(0, index + 1), next, ...layers.slice(index + 1)]))
      onSelectLayer(next.id);
  };
  const moveLayer = (direction: -1 | 1) => {
    if (!active) return;
    const index = layers.indexOf(active),
      target = index + direction;
    if (target < 0 || target >= layers.length) return;
    const next = [...layers];
    [next[index], next[target]] = [next[target], next[index]];
    onLayersChange(next);
  };
  useEffect(() => {
    if (!studioActive || !host.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = entry.contentRect.width < 900;
      setCompact((current) => {
        if (current !== next) setInspectorOpen(!next);
        return next;
      });
    });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, [studioActive]);
  useEffect(() => {
    if (!studioActive || !compact || !inspectorOpen) return;
    const trigger = inspectorTrigger.current;
    const inspector = inspectorRef.current;
    inspector
      ?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
      ?.focus({ preventScroll: true });
    return () => {
      if (inspector?.contains(document.activeElement) || document.activeElement === document.body)
        trigger?.focus({ preventScroll: true });
    };
  }, [studioActive, compact, inspectorOpen]);

  const selectTab = (next: InspectorTab) => {
    setTab(next);
    setInspectorOpen(true);
  };
  return (
    <section
      className={`nh-paint-workspace ${!studioActive ? 'nh-paint-workspace-inactive' : ''} ${compact ? 'nh-paint-compact' : ''} ${inspectorOpen ? 'nh-paint-inspector-open' : ''}`}
      ref={host}
      aria-label={studioActive ? 'Painting studio' : undefined}
    >
      {studioActive && (
        <header className="nh-paint-studio-heading">
          <div className="nh-paint-studio-title">
            <Paintbrush size={16} />
            <strong>Paint studio</strong>
            <span className="nh-paint-active-layer">
              <span aria-hidden="true">/</span>
              {active?.name ?? 'New layer'}
            </span>
          </div>
          <div className="nh-paint-studio-actions">
            {onUndo && (
              <button
                type="button"
                aria-label="Undo painting change"
                title="Undo (Ctrl/⌘ Z)"
                disabled={!canUndo}
                onClick={onUndo}
              >
                <Undo2 size={16} />
              </button>
            )}
            {onRedo && (
              <button
                type="button"
                aria-label="Redo painting change"
                title="Redo (Ctrl/⌘ Shift Z)"
                disabled={!canRedo}
                onClick={onRedo}
              >
                <Redo2 size={16} />
              </button>
            )}
            <button
              type="button"
              className={`nh-paint-before ${before ? 'active' : ''}`}
              aria-pressed={before}
              aria-label="Show original material"
              title="Compare the procedural surface with all authored paint"
              onClick={() => onBeforeChange(!before)}
            >
              {before ? <EyeOff size={15} /> : <Eye size={15} />}
              <span>{before ? 'Original' : 'Painted'}</span>
            </button>
            <button
              type="button"
              ref={inspectorTrigger}
              aria-label={inspectorOpen ? 'Close paint inspector' : 'Open paint inspector'}
              aria-expanded={inspectorOpen}
              aria-controls="nh-paint-inspector"
              title="Brush settings, terrain masks and paint layers"
              className={inspectorOpen ? 'active' : ''}
              onClick={() => setInspectorOpen(!inspectorOpen)}
            >
              {inspectorOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
              <span className="nh-paint-inspector-button-text">Tools</span>
            </button>
          </div>
        </header>
      )}
      {studioActive && (
        <MaterialBrushControls
          value={settings}
          previousLayer={previousLayer}
          worldSize={worldSize}
          resolution={resolution}
          screenRadiusScale={screenRadiusScale}
          surface={surface}
          onChange={onSettingsChange}
          onLayerColor={onLayerColor}
          picking={picking}
          onPickingChange={onPickingChange}
        />
      )}
      <div className="nh-paint-workspace-body" key="paint-workspace-body">
        <div className="nh-paint-canvas nh-paint-canvas-shell">
          {children}
          {studioActive && (effectiveDisabled || picking || selecting) && (
            <div
              className={`nh-paint-canvas-notice ${effectiveDisabled ? 'nh-paint-notice-warning' : ''}`}
              role="status"
            >
              {effectiveDisabled ? (
                <LockKeyhole size={14} />
              ) : picking ? (
                <Pipette size={14} />
              ) : (
                <SquareDashedMousePointer size={14} />
              )}
              <span>
                {effectiveDisabled ||
                  (picking
                    ? 'Click the terrain to sample its material. Esc cancels.'
                    : `Polygon selection · ${selection?.points.length ?? 0} points · Enter to close · Esc to cancel`)}
              </span>
              {selecting && (selection?.points.length ?? 0) >= 3 && (
                <button type="button" onClick={() => onSelectingChange(false)}>
                  Apply
                </button>
              )}
            </div>
          )}
          {studioActive && compact && inspectorOpen && (
            <button
              type="button"
              className="nh-paint-drawer-scrim"
              aria-label="Close paint tools drawer"
              onClick={() => setInspectorOpen(false)}
            />
          )}
        </div>
        {studioActive && inspectorOpen && (
          <aside
            ref={inspectorRef}
            id="nh-paint-inspector"
            className="nh-paint-inspector"
            aria-label="Paint inspector"
            onKeyDown={(e) => {
              if (!compact) return;
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setInspectorOpen(false);
              }
              if (e.key === 'Tab') {
                const items = Array.from(
                  e.currentTarget.querySelectorAll<HTMLElement>(
                    'button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]',
                  ),
                ).filter((item) => item.offsetParent !== null && item.tabIndex >= 0);
                const first = items[0],
                  last = items.at(-1);
                if (e.shiftKey && document.activeElement === first) {
                  e.preventDefault();
                  last?.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                  e.preventDefault();
                  first?.focus();
                }
              }
            }}
          >
            {compact && (
              <div className="nh-paint-drawer-heading">
                <strong>Painting tools</strong>
                <button
                  type="button"
                  aria-label="Close painting tools"
                  onClick={() => setInspectorOpen(false)}
                >
                  <X size={16} />
                </button>
              </div>
            )}
            <div className="nh-paint-inspector-tabs" role="tablist" aria-label="Painting panels">
              {(
                [
                  { id: 'materials', title: 'Materials', Icon: Sparkles },
                  { id: 'brush', title: 'Brush', Icon: SlidersHorizontal },
                  { id: 'layers', title: 'Layers', Icon: Layers },
                ] as const
              ).map(({ id, title, Icon }) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`nh-paint-tab-${id}`}
                  aria-selected={tab === id}
                  aria-controls={`nh-paint-panel-${id}`}
                  tabIndex={tab === id ? 0 : -1}
                  onClick={() => setTab(id)}
                  onKeyDown={(e) => {
                    const names: InspectorTab[] = ['materials', 'brush', 'layers'];
                    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                      e.preventDefault();
                      const next =
                        names[(names.indexOf(id) + (e.key === 'ArrowRight' ? 1 : 2)) % 3];
                      setTab(next);
                      document.getElementById(`nh-paint-tab-${next}`)?.focus();
                    }
                  }}
                >
                  <Icon size={14} />
                  {title}
                  {id === 'layers' && <small>{layers.length}</small>}
                </button>
              ))}
            </div>
            <div
              className="nh-paint-inspector-scroll"
              role="tabpanel"
              id={`nh-paint-panel-${tab}`}
              aria-labelledby={`nh-paint-tab-${tab}`}
              tabIndex={0}
            >
              {tab === 'materials' && (
                <>
                  <div className="nh-paint-section-heading">
                    <span>Surface library</span>
                    <small>4 substrates</small>
                  </div>
                  <div className="nh-paint-material-library">
                    {SPLAT_LAYERS.map((layer) => (
                      <button
                        type="button"
                        key={layer}
                        aria-label={`Choose ${MATERIAL_NAMES[layer]} material`}
                        aria-pressed={settings.layer === layer}
                        onClick={() => onSettingsChange({ ...settings, layer, mode: 'paint' })}
                      >
                        <MaterialSwatch layer={layer} color={layerColorHex(surface, layer)} />
                        <span>
                          <strong>{MATERIAL_NAMES[layer]}</strong>
                          <small>{MATERIAL_DESCRIPTIONS[layer]}</small>
                        </span>
                        {settings.layer === layer && <Check size={14} />}
                      </button>
                    ))}
                  </div>
                  <p className="nh-paint-help">
                    Each substrate carries color, roughness and surface relief. <b>Global color</b>{' '}
                    changes that material everywhere, including earlier strokes.
                  </p>
                  <button
                    type="button"
                    className={`nh-paint-wide-button ${picking ? 'active' : ''}`}
                    aria-pressed={picking}
                    onClick={() => onPickingChange(!picking)}
                  >
                    <Pipette size={15} />
                    Sample from terrain<kbd>Alt</kbd>
                  </button>
                  <details className="nh-paint-disclosure" open>
                    <summary>
                      Area tools
                      <ChevronDown size={14} />
                    </summary>
                    <div className="nh-paint-tool-grid">
                      <button
                        type="button"
                        aria-pressed={selecting}
                        onClick={() => onSelectingChange(!selecting)}
                        disabled={!!effectiveDisabled}
                      >
                        <SquareDashedMousePointer size={16} />
                        {selecting ? 'Finish polygon' : 'Polygon select'}
                      </button>
                      <button
                        type="button"
                        disabled={!!effectiveDisabled || layerDisabled}
                        onClick={() => onFill('connected')}
                      >
                        <PaintBucket size={16} />
                        Connected fill
                      </button>
                    </div>
                    <p className="nh-paint-help">
                      A connected fill starts at your next terrain click. Polygon selections limit
                      the next strokes and fills.
                    </p>
                    {selection && (
                      <div className="nh-paint-selection-state">
                        <span>
                          {selection.region
                            ? 'Connected region'
                            : `${selection.points.length} polygon points`}
                          {selection.invert ? ' · inverted' : ''}
                        </span>
                        <div>
                          <button
                            type="button"
                            aria-pressed={!!selection.invert}
                            disabled={!selectionReady}
                            onClick={() =>
                              onSelectionChange({ ...selection, invert: !selection.invert })
                            }
                          >
                            Invert
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              onSelectionChange(null);
                              onSelectingChange(false);
                            }}
                          >
                            Clear
                          </button>
                        </div>
                      </div>
                    )}
                    <button
                      type="button"
                      className="nh-paint-wide-button"
                      disabled={selecting || !selectionReady || !!effectiveDisabled || layerDisabled}
                      onClick={() => onFill('selection')}
                    >
                      <PaintBucket size={15} />
                      Fill selection
                    </button>
                    {selecting && (
                      <button
                        type="button"
                        className="nh-paint-wide-button"
                        disabled={(selection?.points.length ?? 0) < 3}
                        onClick={() => onSelectingChange(false)}
                      >
                        <Check size={15} />
                        Apply polygon
                      </button>
                    )}
                    <SelectControl
                      label="Replace source material"
                      value={settings.source ?? 'rock'}
                      onChange={(source) =>
                        onSettingsChange({ ...settings, source: source as MaterialLayer })
                      }
                    >
                      {SPLAT_LAYERS.map((layer) => (
                        <option value={layer} key={layer}>
                          {MATERIAL_NAMES[layer]}
                        </option>
                      ))}
                    </SelectControl>
                    <button
                      type="button"
                      className="nh-paint-wide-button"
                      disabled={selecting || !!effectiveDisabled || layerDisabled || settings.layer === 'erase'}
                      onClick={() => onFill('replace')}
                    >
                      <Blend size={15} />
                      Replace with{' '}
                      {settings.layer === 'erase' ? 'material' : MATERIAL_NAMES[settings.layer]}
                    </button>
                    <p className="nh-paint-help">
                      Replacement respects the current selection and terrain rules. One action
                      creates one undo step.
                    </p>
                  </details>
                </>
              )}
              {tab === 'brush' && (
                <>
                  <div className="nh-paint-brush-intro">
                    <BrushPreview settings={settings} color={color} />
                    <div>
                      <strong>
                        {settings.layer === 'erase'
                          ? 'Layer eraser'
                          : settings.mode === 'blend'
                            ? 'Blend brush'
                            : `${MATERIAL_NAMES[settings.layer]} brush`}
                      </strong>
                      <span>
                        {Math.round(settings.strength * 100)}% strength ·{' '}
                        {Math.round(settings.hardness * 100)}% hardness
                      </span>
                      <small>
                        {settings.layer === 'erase'
                          ? 'Reveal the material underneath'
                          : 'Paint the complete material response'}
                      </small>
                    </div>
                  </div>
                  <div className="nh-paint-section-heading">
                    <span>Brush presets</span>
                  </div>
                  <div className="nh-paint-presets">
                    {BRUSH_PRESETS.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        title={preset.description}
                        aria-pressed={
                          settings.presetId === preset.id &&
                          Object.entries(preset.settings).every(
                            ([key, value]) =>
                              JSON.stringify(settings[key as keyof BrushInputSettings]) ===
                              JSON.stringify(value),
                          )
                        }
                        onClick={() => onSettingsChange(applyBrushPreset(settings, preset.id))}
                      >
                        <span
                          className={`nh-paint-preset-tip nh-paint-preset-${preset.id}`}
                          aria-hidden="true"
                        />
                        {preset.name}
                      </button>
                    ))}
                  </div>
                  <details className="nh-paint-disclosure nh-paint-saved-brushes">
                    <summary>
                      My brushes<small>{savedBrushes.length}</small>
                      <ChevronDown size={14} />
                    </summary>
                    {savedBrushes.length > 0 && (
                      <ul>
                        {savedBrushes.map((brush) => (
                          <li key={brush.id}>
                            <button
                              type="button"
                              aria-label={`Use saved brush ${brush.name}`}
                              title={`Use ${brush.name}`}
                              onClick={() => {
                                onSettingsChange({ ...brush.settings });
                                setSavedBrushMessage(`Using ${brush.name}.`);
                              }}
                            >
                              <Paintbrush size={13} />
                              <span>{brush.name}</span>
                            </button>
                            <button
                              type="button"
                              aria-label={`Delete saved brush ${brush.name}`}
                              title="Delete saved brush"
                              onClick={() =>
                                persistBrushes(
                                  savedBrushes.filter((item) => item.id !== brush.id),
                                  `Deleted ${brush.name}.`,
                                )
                              }
                            >
                              <X size={13} />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const name = savedBrushName.trim();
                        if (!name) return;
                        const existing = savedBrushes.find(
                          (brush) => brush.name.toLowerCase() === name.toLowerCase(),
                        );
                        if (!existing && savedBrushes.length >= MAX_SAVED_BRUSHES) return;
                        const saved: SavedBrush = {
                          id: existing?.id ?? `brush-${crypto.randomUUID()}`,
                          name,
                          settings: normalizeBrushSettings(settings),
                        };
                        persistBrushes(
                          existing
                            ? savedBrushes.map((brush) =>
                                brush.id === existing.id ? saved : brush,
                              )
                            : [...savedBrushes, saved],
                          `${existing ? 'Updated' : 'Saved'} ${name}.`,
                        );
                        setSavedBrushName('');
                      }}
                    >
                      <label htmlFor="nh-saved-brush-name">Save the current brush</label>
                      <div>
                        <input
                          id="nh-saved-brush-name"
                          type="text"
                          aria-label="Saved brush name"
                          maxLength={48}
                          placeholder="Name this brush…"
                          value={savedBrushName}
                          onChange={(e) => setSavedBrushName(e.target.value)}
                        />
                        <button
                          type="submit"
                          aria-label="Save current brush preset"
                          disabled={
                            !savedBrushName.trim() ||
                            (savedBrushes.length >= MAX_SAVED_BRUSHES &&
                              !savedBrushes.some(
                                (brush) =>
                                  brush.name.toLowerCase() === savedBrushName.trim().toLowerCase(),
                              ))
                          }
                        >
                          Save
                        </button>
                      </div>
                    </form>
                    <p className="nh-paint-help">
                      Saved in this browser, including brush dynamics and terrain rules. Selections
                      stay with your working session.
                    </p>
                    {savedBrushMessage && (
                      <p className="nh-paint-preset-message" role="status">
                        {savedBrushMessage}
                      </p>
                    )}
                  </details>
                  <div className="nh-paint-rule" />
                  <SelectControl
                    label="Brush behavior"
                    value={settings.mode ?? 'paint'}
                    onChange={(mode) =>
                      onSettingsChange({ ...settings, mode: mode as BrushInputSettings['mode'] })
                    }
                  >
                    <option value="paint">Paint material</option>
                    <option value="blend">Blend nearby materials</option>
                    <option value="replace">Replace source material</option>
                  </SelectControl>
                  {settings.mode === 'replace' && (
                    <SelectControl
                      label="Replace source material"
                      value={settings.source ?? 'rock'}
                      onChange={(source) =>
                        onSettingsChange({ ...settings, source: source as MaterialLayer })
                      }
                    >
                      {SPLAT_LAYERS.map((layer) => (
                        <option value={layer} key={layer}>
                          {MATERIAL_NAMES[layer]}
                        </option>
                      ))}
                    </SelectControl>
                  )}
                  <SelectControl
                    label="Pen pressure"
                    value={settings.pressure ?? 'none'}
                    onChange={(pressure) =>
                      onSettingsChange({
                        ...settings,
                        pressure: pressure as BrushInputSettings['pressure'],
                      })
                    }
                  >
                    <option value="none">Off</option>
                    <option value="radius">Radius</option>
                    <option value="strength">Strength</option>
                    <option value="both">Radius & strength</option>
                  </SelectControl>
                  <PaintNumberControl
                    label="Stroke smoothing"
                    value={Math.round((settings.smoothing ?? 0.2) * 100)}
                    unit="%"
                    onChange={(value) => onSettingsChange({ ...settings, smoothing: value / 100 })}
                  />
                  <SelectControl
                    label="Brush texture"
                    value={settings.texture ?? 'smooth'}
                    onChange={(texture) =>
                      onSettingsChange({
                        ...settings,
                        texture: texture as BrushInputSettings['texture'],
                      })
                    }
                  >
                    <option value="smooth">Smooth coverage</option>
                    <option value="grain">Natural grain</option>
                    <option value="scatter">Scattered patches</option>
                  </SelectControl>
                  <details className="nh-paint-disclosure">
                    <summary>
                      Tip shape & dynamics
                      <ChevronDown size={14} />
                    </summary>
                    <PaintNumberControl
                      label="Brush spacing"
                      value={Math.round((settings.spacing ?? 0.08) * 100)}
                      min={1}
                      max={100}
                      unit="%"
                      onChange={(value) => onSettingsChange({ ...settings, spacing: value / 100 })}
                    />
                    <PaintNumberControl
                      label="Tip aspect"
                      value={Math.round((settings.aspect ?? 1) * 100)}
                      min={10}
                      max={100}
                      unit="%"
                      onChange={(value) => onSettingsChange({ ...settings, aspect: value / 100 })}
                    />
                    <PaintNumberControl
                      label="Tip angle"
                      value={settings.angle ?? 0}
                      min={0}
                      max={360}
                      unit="°"
                      onChange={(value) => onSettingsChange({ ...settings, angle: value })}
                    />
                    <PaintNumberControl
                      label="Position jitter"
                      value={Math.round((settings.jitter ?? 0) * 100)}
                      unit="%"
                      onChange={(value) => onSettingsChange({ ...settings, jitter: value / 100 })}
                    />
                    <SelectControl
                      label="Mirror painting"
                      value={settings.symmetry ?? 'none'}
                      onChange={(symmetry) =>
                        onSettingsChange({
                          ...settings,
                          symmetry: symmetry as BrushInputSettings['symmetry'],
                        })
                      }
                    >
                      <option value="none">Off</option>
                      <option value="x">East / west</option>
                      <option value="y">North / south</option>
                      <option value="both">Both axes</option>
                    </SelectControl>
                  </details>
                  <details className="nh-paint-disclosure" open>
                    <summary>
                      Terrain rules
                      <Sparkles size={14} />
                    </summary>
                    <div
                      className="nh-paint-segmented"
                      role="group"
                      aria-label="Terrain rule scope"
                    >
                      <button
                        type="button"
                        aria-pressed={maskScope === 'brush'}
                        onClick={() => setMaskScope('brush')}
                      >
                        Next strokes
                      </button>
                      <button
                        type="button"
                        aria-pressed={maskScope === 'layer'}
                        disabled={!active}
                        onClick={() => setMaskScope('layer')}
                      >
                        Entire layer
                      </button>
                    </div>
                    <fieldset
                      className="nh-paint-fieldset"
                      disabled={maskScope === 'layer' && active?.locked}
                    >
                      <MaskEditor
                        mask={maskScope === 'brush' ? settings.mask : active?.mask}
                        onChange={(mask) =>
                          maskScope === 'brush'
                            ? onSettingsChange({ ...settings, mask })
                            : updateActive({ mask })
                        }
                        worldSize={worldSize}
                        elevationRange={elevationRange}
                        scope={maskScope === 'brush' ? 'Brush mask' : 'Layer mask'}
                      />
                    </fieldset>
                    <label className="nh-paint-check">
                      <input
                        type="checkbox"
                        checked={settings.showMask !== false}
                        onChange={(e) =>
                          onSettingsChange({ ...settings, showMask: e.target.checked })
                        }
                      />
                      <span>Show terrain rule overlay</span>
                    </label>
                  </details>
                  <details className="nh-paint-disclosure">
                    <summary>
                      Cursor & preview
                      <ChevronDown size={14} />
                    </summary>
                    <PaintNumberControl
                      label="Stroke overlay opacity"
                      value={Math.round((settings.overlayOpacity ?? 0.5) * 100)}
                      unit="%"
                      onChange={(value) =>
                        onSettingsChange({ ...settings, overlayOpacity: value / 100 })
                      }
                    />
                    <label className="nh-paint-check">
                      <input
                        type="checkbox"
                        checked={settings.showFalloff !== false}
                        onChange={(e) =>
                          onSettingsChange({ ...settings, showFalloff: e.target.checked })
                        }
                      />
                      <span>Show hardness ring</span>
                    </label>
                    <p className="nh-paint-help">
                      The outer ring marks the brush footprint. The inner ring marks full-strength
                      coverage.
                    </p>
                  </details>
                  <button
                    type="button"
                    className="nh-paint-text-button"
                    onClick={() =>
                      onSettingsChange({ ...DEFAULT_BRUSH_SETTINGS, layer: settings.layer })
                    }
                  >
                    <RotateCcw size={14} />
                    Reset brush settings
                  </button>
                </>
              )}
              {tab === 'layers' && (
                <>
                  <div className="nh-paint-section-heading">
                    <span>Paint layers</span>
                    <button
                      type="button"
                      aria-label="Add paint layer"
                      title="Add an empty paint layer"
                      disabled={layers.length >= MAX_PAINT_LAYERS}
                      onClick={addLayer}
                    >
                      <Plus size={16} />
                    </button>
                  </div>
                  <p className="nh-paint-help">
                    Top layers cover those below. Erasing reveals the lower layers and procedural
                    surface.
                  </p>
                  <div className="nh-paint-layer-stack" role="list" aria-label="Paint layer stack">
                    {[...layers].reverse().map((layer) => (
                      <div
                        className={`nh-paint-layer-item ${layer.id === active?.id ? 'active' : ''} ${!layer.visible ? 'hidden' : ''}`}
                        role="listitem"
                        key={layer.id}
                      >
                        <button
                          type="button"
                          className="nh-paint-layer-visible"
                          aria-label={`${layer.visible ? 'Hide' : 'Show'} ${layer.name}`}
                          aria-pressed={layer.visible}
                          onClick={() =>
                            onLayersChange(
                              layers.map((item) =>
                                item.id === layer.id ? { ...item, visible: !item.visible } : item,
                              ),
                            )
                          }
                        >
                          {layer.visible ? <Eye size={15} /> : <EyeOff size={15} />}
                        </button>
                        <button
                          type="button"
                          className="nh-paint-layer-select"
                          aria-label={`Select paint layer ${layer.name}`}
                          aria-pressed={layer.id === active?.id}
                          onClick={() => onSelectLayer(layer.id)}
                        >
                          <span className="nh-paint-layer-symbol">
                            <Layers size={16} />
                          </span>
                          <span>
                            <strong>{layer.name}</strong>
                            <small>
                              {layer.strokes.length} strokes · {Math.round(layer.opacity * 100)}%
                              {layer.mask ? ' · mask' : ''}
                            </small>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="nh-paint-layer-lock"
                          aria-label={`${layer.locked ? 'Unlock' : 'Lock'} ${layer.name}`}
                          aria-pressed={layer.locked}
                          onClick={() =>
                            onLayersChange(
                              layers.map((item) =>
                                item.id === layer.id ? { ...item, locked: !item.locked } : item,
                              ),
                            )
                          }
                        >
                          {layer.locked ? <LockKeyhole size={14} /> : <UnlockKeyhole size={14} />}
                        </button>
                      </div>
                    ))}
                    {!layers.length && (
                      <div className="nh-paint-empty">
                        <Layers size={24} />
                        <p>Create a layer to start painting.</p>
                        <button type="button" className="nh-paint-wide-button" onClick={addLayer}>
                          <Plus size={15} />
                          Create paint layer
                        </button>
                      </div>
                    )}
                    <div className="nh-paint-procedural-layer">
                      <LockKeyhole size={13} />
                      <span>Procedural surface</span>
                      <small>Base</small>
                    </div>
                  </div>
                  {active && (
                    <>
                      <div className="nh-paint-section-heading">
                        <span>Selected layer</span>
                        {active.locked && <small>Locked</small>}
                      </div>
                      <LayerName layer={active} onChange={(name) => updateActive({ name })} />
                      <fieldset className="nh-paint-fieldset" disabled={active.locked}>
                        <PaintNumberControl
                          label="Layer opacity"
                          value={Math.round(active.opacity * 100)}
                          unit="%"
                          onChange={(value) => updateActive({ opacity: value / 100 })}
                        />
                        <div
                          className="nh-paint-layer-actions"
                          role="group"
                          aria-label="Layer actions"
                        >
                          <button
                            type="button"
                            aria-label="Move layer up"
                            title="Move layer up"
                            disabled={layers.indexOf(active) === layers.length - 1}
                            onClick={() => moveLayer(1)}
                          >
                            <ArrowUp size={16} />
                          </button>
                          <button
                            type="button"
                            aria-label="Move layer down"
                            title="Move layer down"
                            disabled={layers.indexOf(active) === 0}
                            onClick={() => moveLayer(-1)}
                          >
                            <ArrowDown size={16} />
                          </button>
                          <button
                            type="button"
                            aria-label="Duplicate paint layer"
                            title={
                              duplicateFits
                                ? 'Duplicate layer'
                                : 'Duplicating this layer would exceed paint storage capacity'
                            }
                            disabled={!duplicateFits}
                            onClick={duplicateLayer}
                          >
                            <Copy size={16} />
                          </button>
                          <button
                            type="button"
                            aria-label="Delete paint layer"
                            title="Delete layer · Undo to restore"
                            onClick={() => {
                              const index = layers.indexOf(active),
                                next = layers.filter((layer) => layer.id !== active.id);
                              if (!next.length) next.push(createPaintLayer('Paint 1'));
                              onLayersChange(next);
                              onSelectLayer(next[Math.min(index, next.length - 1)].id);
                            }}
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </fieldset>
                      <button
                        type="button"
                        className="nh-paint-wide-button"
                        onClick={() => {
                          setMaskScope('layer');
                          selectTab('brush');
                        }}
                      >
                        <Sparkles size={15} />
                        {active.mask ? 'Edit layer terrain rules' : 'Add layer terrain rules'}
                      </button>
                      <details className="nh-paint-disclosure">
                        <summary>
                          Stroke history<small>{active.strokes.length}</small>
                          <ChevronDown size={14} />
                        </summary>
                        {!active.strokes.length ? (
                          <p className="nh-paint-help">Your next stroke will appear here.</p>
                        ) : (
                          <ol className="nh-paint-stroke-history">
                            {active.strokes
                              .map((stroke, index) => ({ stroke, index }))
                              .slice(-20)
                              .reverse()
                              .map(({ stroke, index }) => (
                                <li key={index}>
                                  <span>
                                    <b>{index + 1}</b>
                                    {stroke.layer === 'erase'
                                      ? 'Erase'
                                      : stroke.mode === 'blend'
                                        ? 'Blend'
                                        : MATERIAL_NAMES[stroke.layer]}
                                    <small>
                                      {Math.round(stroke.strength * 100)}% · {stroke.points.length}{' '}
                                      points
                                    </small>
                                  </span>
                                  <button
                                    type="button"
                                    aria-label={`Delete stroke ${index + 1}`}
                                    disabled={active.locked}
                                    title="Delete this stroke · Undo to restore"
                                    onClick={() =>
                                      updateActive({
                                        strokes: active.strokes.filter((_, i) => i !== index),
                                      })
                                    }
                                  >
                                    <X size={13} />
                                  </button>
                                </li>
                              ))}
                          </ol>
                        )}
                        {active.strokes.length > 20 && (
                          <p className="nh-paint-help">Showing the latest 20 strokes.</p>
                        )}
                      </details>
                    </>
                  )}
                  <div
                    className={`nh-paint-capacity ${capacity >= 0.8 ? 'nh-paint-capacity-warning' : ''}`}
                  >
                    <div>
                      <span>Project capacity</span>
                      <output>{Math.round(capacity * 100)}%</output>
                    </div>
                    <meter
                      min={0}
                      max={1}
                      value={capacity}
                      low={0.7}
                      high={0.9}
                      optimum={0}
                      aria-label="Paint storage capacity"
                    />
                    <small>
                      {strokes.toLocaleString()} / {MAX_PAINT_STROKES.toLocaleString()} strokes ·{' '}
                      {points.toLocaleString()} / {MAX_PAINT_POINTS.toLocaleString()} points
                    </small>
                    <small>
                      {(budget.bytes / 1048576).toFixed(2)} / {(budget.maxBytes / 1048576).toFixed(0)} MiB project JSON
                    </small>
                    {capacity >= 0.8 && (
                      <p>
                        Approaching the paint limit. Remove unused strokes or layers to make room.
                      </p>
                    )}
                  </div>
                </>
              )}
            </div>
          </aside>
        )}
      </div>
      {studioActive && (
        <footer className="nh-paint-statusbar">
          <div className="nh-paint-status" role="status" aria-live="polite">
            <span className={`nh-paint-status-dot ${effectiveDisabled ? 'paused' : ''}`} />
            <span>
              {effectiveDisabled ||
                status ||
                (settings.layer === 'erase'
                  ? 'Erase on active layer'
                  : settings.mode === 'blend'
                    ? 'Blend materials'
                    : 'Ready to paint')}
            </span>
          </div>
          <div className="nh-paint-footer-actions">
            <button type="button" title="Open paint layers" onClick={() => selectTab('layers')}>
              <Layers size={13} />
              <span>{layers.length} {layers.length === 1 ? 'layer' : 'layers'}</span>
            </button>
            <button
              type="button"
              aria-label="Painting shortcuts"
              aria-expanded={showShortcuts}
              onClick={() => setShowShortcuts(!showShortcuts)}
            >
              <Keyboard size={14} />
              <span>Shortcuts</span>
            </button>
          </div>
          {showShortcuts && (
            <div
              className="nh-paint-shortcuts"
              role="region"
              aria-label="Painting keyboard shortcuts"
            >
              <div>
                <strong>Stay on the canvas</strong>
                <button
                  type="button"
                  aria-label="Close painting shortcuts"
                  onClick={() => setShowShortcuts(false)}
                >
                  <X size={15} />
                </button>
              </div>
              <dl>
                <dt>
                  <kbd>B</kbd>
                </dt>
                <dd>Paint tool</dd>
                <dt>
                  <kbd>E</kbd>
                </dt>
                <dd>Toggle eraser</dd>
                <dt>
                  <kbd>1</kbd>–<kbd>4</kbd>
                </dt>
                <dd>Pick a material</dd>
                <dt>
                  <kbd>[</kbd> <kbd>]</kbd>
                </dt>
                <dd>Change radius</dd>
                <dt>
                  <kbd>Shift</kbd> + <kbd>[ ]</kbd>
                </dt>
                <dd>Change hardness</dd>
                <dt>
                  <kbd>Space</kbd> + drag
                </dt>
                <dd>Navigate temporarily</dd>
                <dt>
                  <kbd>Alt</kbd> + click
                </dt>
                <dd>Sample material</dd>
                <dt>
                  <kbd>Shift</kbd> + drag
                </dt>
                <dd>Blend materials</dd>
                <dt>
                  <kbd>Esc</kbd>
                </dt>
                <dd>Cancel the current stroke</dd>
                <dt>
                  <kbd>Ctrl/⌘ Z</kbd>
                </dt>
                <dd>Undo</dd>
                <dt>
                  <kbd>Arrows</kbd> / <kbd>Enter</kbd>
                </dt>
                <dd>Move / dab in the 2D map</dd>
              </dl>
              <p>
                <Hand size={13} />
                Two fingers navigate. One finger or a pen paints.
              </p>
            </div>
          )}
        </footer>
      )}
    </section>
  );
}
