import { useEffect, useRef, type CSSProperties } from 'react';
import { Eraser, Pipette } from 'lucide-react';
import type { MaterialLayer } from '../materials/materialPaint';
import { layerColorHex, SPLAT_LAYERS, type SurfaceSettings } from '../materials/pbr';
import type { BrushFeedback } from '../render/brushFeedback';
import type { BrushInputSettings } from '../materials/brushPresets';
import { NumberField } from './Controls';
import './PaintWorkspace.css';

export const MATERIAL_NAMES: Record<MaterialLayer, string> = {
  rock: 'Rock',
  soil: 'Soil',
  vegetation: 'Vegetation',
  snow: 'Snow',
};

/** Deterministic CSS swatches convey a substrate, rather than only its pigment. */
export function MaterialSwatch({
  layer,
  color,
  className = '',
}: {
  layer: MaterialLayer;
  color: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`nh-paint-swatch nh-paint-swatch-${layer} ${className}`}
      style={{ '--swatch-color': color } as CSSProperties}
    />
  );
}

export function PaintNumberControl({
  label,
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  unit,
  sliderLabel,
  numberLabel,
  logarithmic = false,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  sliderLabel?: string;
  numberLabel?: string;
  logarithmic?: boolean;
}) {
  const logarithm = logarithmic && min > 0;
  const progress = logarithm
    ? (Math.log(Math.max(min, value) / min) / Math.log(max / min)) * 100
    : value;
  return (
    <div className="nh-paint-number-control">
      <div className="nh-paint-number-heading">
        <span>{label}</span>
        <NumberField
          value={value}
          min={min}
          max={max}
          step={step}
          unit={unit}
          label={numberLabel ?? `${label} value`}
          onChange={onChange}
        />
      </div>
      <input
        type="range"
        aria-label={sliderLabel ?? label}
        min={logarithm ? 0 : min}
        max={logarithm ? 100 : max}
        step={logarithm ? 1 : step}
        value={progress}
        onChange={(e) =>
          onChange(
            logarithm
              ? min * (max / min) ** (Number(e.target.value) / 100)
              : Number(e.target.value),
          )
        }
      />
    </div>
  );
}

export function MaterialBrushControls({
  value,
  previousLayer,
  worldSize,
  resolution = 512,
  screenRadiusScale,
  surface,
  onChange,
  onLayerColor,
  picking = false,
  onPickingChange,
}: {
  value: BrushInputSettings;
  previousLayer: MaterialLayer;
  worldSize: number;
  resolution?: number;
  screenRadiusScale?: number;
  surface: SurfaceSettings;
  onLayerColor: (layer: MaterialLayer, color: string) => void;
  onChange: (value: BrushInputSettings) => void;
  picking?: boolean;
  onPickingChange?: (value: boolean) => void;
}) {
  const units = value.radiusUnit ?? 'meters';
  const scale =
    units === 'meters' ? worldSize : units === 'texels' ? resolution - 1 : (screenRadiusScale ?? 1);
  const radiusValue = units === 'screen' ? (value.radiusPixels ?? 48) : value.radius * scale;
  const radiusChange = (next: number) =>
    onChange(
      units === 'screen'
        ? { ...value, radiusPixels: next }
        : { ...value, radius: Math.max(0.0001, Math.min(0.5, next / scale)) },
    );
  return (
    <div className="nh-material-brush nh-paint-essentials" role="region" aria-label="Surface brush">
      <div className="nh-paint-material-tools">
        <div className="nh-brush-layer-list" role="group" aria-label="Brush material">
          {SPLAT_LAYERS.map((layer, index) => (
            <button
              type="button"
              key={layer}
              aria-label={MATERIAL_NAMES[layer]}
              aria-pressed={layer === value.layer}
              title={`${MATERIAL_NAMES[layer]} (${index + 1})`}
              onClick={() => onChange({ ...value, layer, mode: 'paint', presetId: 'custom' })}
            >
              <MaterialSwatch layer={layer} color={layerColorHex(surface, layer)} />
              <span>{MATERIAL_NAMES[layer]}</span>
              <kbd>{index + 1}</kbd>
            </button>
          ))}
          <button
            type="button"
            className="nh-paint-erase"
            aria-label="Erase"
            aria-pressed={value.layer === 'erase'}
            title="Erase paint from the active layer (E)"
            onClick={() =>
              onChange({
                ...value,
                layer: value.layer === 'erase' ? previousLayer : 'erase',
                mode: 'paint',
                presetId: 'custom',
              })
            }
          >
            <Eraser size={17} />
            <span>Erase</span>
            <kbd>E</kbd>
          </button>
          {onPickingChange && (
            <button
              type="button"
              className="nh-paint-eyedropper"
              aria-label="Sample material"
              aria-pressed={picking}
              title="Sample a material from the terrain (Alt-click)"
              onClick={() => onPickingChange(!picking)}
            >
              <Pipette size={17} />
            </button>
          )}
        </div>
        {value.layer !== 'erase' && (
          <label
            className="nh-brush-albedo"
            title="Global material color: changes this substrate everywhere, including existing paint and procedural coverage."
          >
            <span>Global color</span>
            <input
              type="color"
              aria-label={'Edit ' + value.layer + ' layer color'}
              value={layerColorHex(surface, value.layer)}
              onChange={(e) => {
                if (value.layer !== 'erase') onLayerColor(value.layer, e.target.value);
              }}
            />
          </label>
        )}
      </div>
      <div className="nh-brush-properties">
        <div className="nh-paint-radius-control">
          <PaintNumberControl
            label="Radius"
            value={radiusValue}
            onChange={radiusChange}
            min={units === 'screen' ? 1 : scale * 0.0001}
            max={units === 'screen' ? 512 : scale * 0.5}
            step={units === 'meters' ? 0.1 : 1}
            unit={units === 'meters' ? 'm' : units === 'texels' ? 'tx' : 'px'}
            sliderLabel="Brush radius"
            numberLabel="Brush radius value"
            logarithmic
          />
          <select
            className="nh-paint-radius-unit"
            aria-label="Brush radius unit"
            value={units}
            onChange={(e) => {
              const radiusUnit = e.target.value as NonNullable<BrushInputSettings['radiusUnit']>;
              onChange({
                ...value,
                radiusUnit,
                ...(radiusUnit === 'screen' ? { radiusPixels: value.radiusPixels ?? 48 } : {}),
              });
            }}
          >
            <option value="meters">Meters</option>
            <option value="texels">Texels</option>
            <option value="screen">Screen px</option>
          </select>
        </div>
        <PaintNumberControl
          label="Strength"
          value={Math.round(value.strength * 100)}
          min={1}
          max={100}
          unit="%"
          sliderLabel="Brush strength"
          numberLabel="Brush strength value"
          onChange={(next) => onChange({ ...value, strength: next / 100 })}
        />
        <PaintNumberControl
          label="Hardness"
          value={Math.round(value.hardness * 100)}
          unit="%"
          sliderLabel="Brush hardness"
          numberLabel="Brush hardness value"
          onChange={(next) => onChange({ ...value, hardness: next / 100 })}
        />
      </div>
    </div>
  );
}

export function MapBrushPreview({
  feedback,
  size,
  left,
  top,
}: {
  feedback: BrushFeedback;
  size: number;
  left: number;
  top: number;
}) {
  const mask = useRef<HTMLCanvasElement>(null);
  const guide = useRef<HTMLCanvasElement>(null);
  const outer = useRef<SVGEllipseElement>(null),
    inner = useRef<SVGEllipseElement>(null);
  const caption = useRef<SVGTextElement>(null);
  useEffect(() => {
    let revision = -1;
    let guideRevision = -1;
    return feedback.subscribe(() => {
      if (guideRevision !== feedback.guideRevision && guide.current) {
        guide.current.width = feedback.guideCanvas.width;
        guide.current.height = feedback.guideCanvas.height;
        const ctx = guide.current.getContext('2d');
        ctx?.clearRect(0, 0, guide.current.width, guide.current.height);
        ctx?.drawImage(feedback.guideCanvas, 0, 0);
        guideRevision = feedback.guideRevision;
      }
      if (revision !== feedback.revision && mask.current) {
        if (mask.current.width !== feedback.canvas.width) {
          mask.current.width = mask.current.height = feedback.canvas.width;
        }
        const ctx = mask.current.getContext('2d');
        ctx?.clearRect(0, 0, mask.current.width, mask.current.height);
        ctx?.drawImage(feedback.canvas, 0, 0);
        revision = feedback.revision;
      }
      if (mask.current) {
        mask.current.style.display =
          feedback.hasMarksFor('map') && !feedback.liveFor('map') ? '' : 'none';
      }
      const settings = feedback.settings as BrushInputSettings;
      const x = 1000 * (feedback.cursor?.u ?? -5),
        y = 1000 * (feedback.cursor?.v ?? -5);
      for (const ellipse of [outer.current, inner.current]) {
        if (!ellipse) continue;
        const radius = 1000 * settings.radius * (ellipse === inner.current ? settings.hardness : 1);
        ellipse.setAttribute('cx', String(x));
        ellipse.setAttribute('cy', String(y));
        ellipse.setAttribute('rx', String(radius));
        ellipse.setAttribute('ry', String(radius * (settings.aspect ?? 1)));
        ellipse.setAttribute('transform', `rotate(${settings.angle ?? 0} ${x} ${y})`);
        if (ellipse === inner.current) ellipse.style.display = feedback.showFalloff ? '' : 'none';
      }
      if (caption.current) {
        caption.current.setAttribute('x', String(x + settings.radius * 1000 + 12));
        caption.current.setAttribute('y', String(y + 4));
        caption.current.textContent =
          settings.layer === 'erase' ? 'Erase' : MATERIAL_NAMES[settings.layer];
        caption.current.style.display = feedback.cursor ? '' : 'none';
      }
    });
  }, [feedback]);
  return (
    <div
      className="nh-map-brush-preview"
      aria-hidden="true"
      style={{ width: size, height: size, left, top }}
    >
      <canvas
        ref={guide}
        className="nh-map-paint-guide"
        width={feedback.guideCanvas.width}
        height={feedback.guideCanvas.height}
      />
      <canvas ref={mask} width={feedback.canvas.width} height={feedback.canvas.height} />
      <svg viewBox="0 0 1000 1000">
        <ellipse
          ref={outer}
          fill="none"
          stroke="white"
          vectorEffect="non-scaling-stroke"
          strokeWidth="1.6"
        />
        <ellipse
          ref={inner}
          fill="none"
          stroke="white"
          vectorEffect="non-scaling-stroke"
          strokeWidth="1"
          opacity=".65"
        />
        <text ref={caption} className="nh-paint-cursor-label" fill="white" fontSize="14" />
      </svg>
    </div>
  );
}
