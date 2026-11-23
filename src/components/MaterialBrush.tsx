import { useEffect, useRef } from 'react';
import { Eraser, Paintbrush } from 'lucide-react';
import type { MaterialStroke } from '../materials/materialPaint';
import { SPLAT_LAYERS } from '../materials/pbr';
import { BRUSH_COLORS, type BrushFeedback, type BrushSettings } from '../render/brushFeedback';

export function MaterialBrushControls({ value, worldSize, onChange }: {
  value: BrushSettings;
  worldSize: number;
  onChange: (value: BrushSettings) => void;
}) {
  const previous = useRef<MaterialStroke['layer']>('rock');
  return (
    <div className="nh-material-brush" role="region" aria-label="Surface brush">
      <div className="nh-brush-layer-list" role="group" aria-label="Brush material">
        <Paintbrush size={15} aria-hidden="true"/>
        {SPLAT_LAYERS.map(layer => (
          <button type="button" key={layer} aria-pressed={layer === value.layer}
            onClick={() => { previous.current = layer; onChange({ ...value, layer }); }}>
            <i style={{ backgroundColor: BRUSH_COLORS[layer] }}/>
            {layer[0].toUpperCase() + layer.slice(1)}
          </button>
        ))}
        <button type="button" aria-pressed={value.layer === 'erase'} title="Restore procedural material"
          onClick={() => onChange({ ...value, layer: value.layer === 'erase' ? previous.current : 'erase' })}>
          <Eraser size={13}/> Erase
        </button>
      </div>
      <div className="nh-brush-properties">
        <label>Radius <output>{(value.radius * worldSize).toLocaleString(undefined, { maximumFractionDigits: 1 })} m</output>
          <input aria-label="Brush radius" type="range" min="0" max="100" step="1"
            value={Math.round(Math.log(value.radius / 0.001) / Math.log(250) * 100)}
            onChange={e => onChange({ ...value, radius: 0.001 * 250 ** (Number(e.target.value) / 100) })}/>
        </label>
        {(['strength', 'hardness'] as const).map(key => (
          <label key={key}>{key === 'strength' ? 'Strength' : 'Hardness'} <output>{Math.round(100 * value[key])}%</output>
            <input aria-label={'Brush ' + key} type="range" min={key === 'strength' ? 1 : 0}
              max="100" step="1" value={Math.round(100 * value[key])}
              onChange={e => onChange({ ...value, [key]: Number(e.target.value) / 100 })}/>
          </label>
        ))}
      </div>
    </div>
  );
}

export function MapBrushPreview({ feedback, size, left, top }: {
  feedback: BrushFeedback; size: number; left: number; top: number;
}) {
  const mask = useRef<HTMLCanvasElement>(null);
  const outer = useRef<SVGCircleElement>(null), inner = useRef<SVGCircleElement>(null);
  useEffect(() => {
    let revision = -1;
    return feedback.subscribe(() => {
      if (revision !== feedback.revision && mask.current) {
        const ctx = mask.current.getContext('2d');
        ctx?.clearRect(0, 0, mask.current.width, mask.current.height);
        ctx?.drawImage(feedback.canvas, 0, 0);
        revision = feedback.revision;
      }
      for (const circle of [outer.current, inner.current]) {
        if (!circle) continue;
        circle.setAttribute('cx', String(1000 * (feedback.cursor?.u ?? -5)));
        circle.setAttribute('cy', String(1000 * (feedback.cursor?.v ?? -5)));
        circle.setAttribute('r', String(1000 * feedback.settings.radius *
          (circle === inner.current ? feedback.settings.hardness : 1)));
      }
    });
  }, [feedback]);
  return (
    <div className="nh-map-brush-preview" aria-hidden="true"
      style={{ width: size, height: size, left, top }}>
      <canvas ref={mask} width={feedback.canvas.width} height={feedback.canvas.height}/>
      <svg viewBox="0 0 1000 1000">
        <circle ref={outer} fill="none" stroke="white" vectorEffect="non-scaling-stroke" strokeWidth="1.6"/>
        <circle ref={inner} fill="none" stroke="white" vectorEffect="non-scaling-stroke" strokeWidth="1" opacity=".65"/>
      </svg>
    </div>
  );
}
