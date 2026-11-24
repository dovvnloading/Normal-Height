import { useEffect, useRef, useState } from 'react';
import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import { parseStudioCurve } from '../model/noiseStudio';
import type { CurvePoint } from '../model/noiseStudio';
import { NumberField } from './Controls';

const WIDTH = 240;
const HEIGHT = 150;
const PAD = 12;
const clamp = (n: number, min = 0, max = 1) => Math.min(max, Math.max(min, n));
const encode = (points: CurvePoint[]) =>
  JSON.stringify(points.map((p) => [Number(p.x.toFixed(4)), Number(p.y.toFixed(4))]));
const decode = (value: string): CurvePoint[] => {
  try {
    return parseStudioCurve(value);
  } catch {
    return [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
  }
};

export function NoiseCurveEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [points, setPoints] = useState(() => decode(value));
  const [selected, setSelected] = useState(0);
  const draft = useRef(points);
  const dragging = useRef(false);
  useEffect(() => {
    const next = decode(value);
    setPoints(next);
    draft.current = next;
    setSelected((before) => Math.min(before, next.length - 1));
  }, [value]);

  const changePoint = (index: number, x: number, y: number, commit: boolean) => {
    const current = draft.current;
    const next = current.map((p, i) =>
      i !== index
        ? p
        : {
            x:
              index === 0
                ? 0
                : index === current.length - 1
                  ? 1
                  : clamp(x, current[index - 1].x + 0.001, current[index + 1].x - 0.001),
            y: clamp(y),
          },
    );
    draft.current = next;
    setPoints(next);
    if (commit) onChange(encode(next));
  };
  const addPoint = (at?: CurvePoint) => {
    if (points.length >= 16) return;
    let index = 0;
    if (at) {
      const interval = points.findIndex(
        (p, i) => i < points.length - 1 && at.x > p.x + 0.001 && at.x < points[i + 1].x - 0.001,
      );
      if (interval < 0) return;
      index = interval;
    } else {
      for (let i = 1; i < points.length - 1; i++)
        if (points[i + 1].x - points[i].x > points[index + 1].x - points[index].x) index = i;
    }
    const point = at ?? {
      x: (points[index].x + points[index + 1].x) / 2,
      y: (points[index].y + points[index + 1].y) / 2,
    };
    const next = [...points.slice(0, index + 1), point, ...points.slice(index + 1)];
    draft.current = next;
    setPoints(next);
    setSelected(index + 1);
    onChange(encode(next));
  };
  const removePoint = (index: number) => {
    if (index === 0 || index === points.length - 1) return;
    const next = points.filter((_, i) => i !== index);
    draft.current = next;
    setPoints(next);
    setSelected(Math.max(0, index - 1));
    onChange(encode(next));
  };
  const fromPointer = (
    event: React.PointerEvent<SVGCircleElement> | React.MouseEvent<SVGSVGElement>,
  ) => {
    const svg =
      event.currentTarget instanceof SVGSVGElement
        ? event.currentTarget
        : event.currentTarget.ownerSVGElement!;
    const rect = svg.getBoundingClientRect();
    return {
      x: clamp(((WIDTH * (event.clientX - rect.left)) / rect.width - PAD) / (WIDTH - 2 * PAD)),
      y: clamp(
        1 - ((HEIGHT * (event.clientY - rect.top)) / rect.height - PAD) / (HEIGHT - 2 * PAD),
      ),
    };
  };
  const point = points[selected] ?? points[0];
  return (
    <div className="studio-curve-editor">
      <div className="studio-control-heading">
        <label>Remap curve</label>
        <span>{points.length} / 16 points</span>
      </div>
      <svg
        className="studio-curve"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="group"
        aria-label="Noise remap curve"
        onDoubleClick={(event) => addPoint(fromPointer(event))}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <g key={t} className="studio-curve-grid">
            <line
              x1={PAD + t * (WIDTH - 2 * PAD)}
              x2={PAD + t * (WIDTH - 2 * PAD)}
              y1={PAD}
              y2={HEIGHT - PAD}
            />
            <line
              x1={PAD}
              x2={WIDTH - PAD}
              y1={PAD + t * (HEIGHT - 2 * PAD)}
              y2={PAD + t * (HEIGHT - 2 * PAD)}
            />
          </g>
        ))}
        <line className="studio-curve-guide" x1={PAD} y1={HEIGHT - PAD} x2={WIDTH - PAD} y2={PAD} />
        <polyline
          className="studio-curve-line"
          points={points
            .map(
              (p) => `${PAD + p.x * (WIDTH - 2 * PAD)},${HEIGHT - PAD - p.y * (HEIGHT - 2 * PAD)}`,
            )
            .join(' ')}
        />
        {points.map((p, i) => (
          <circle
            key={i}
            className={selected === i ? 'selected' : ''}
            cx={PAD + p.x * (WIDTH - 2 * PAD)}
            cy={HEIGHT - PAD - p.y * (HEIGHT - 2 * PAD)}
            r={5}
            tabIndex={0}
            role="slider"
            aria-label={`Curve point ${i + 1}`}
            aria-valuemin={0}
            aria-valuemax={1}
            aria-valuenow={p.y}
            aria-valuetext={`Input ${p.x.toFixed(3)}, output ${p.y.toFixed(3)}`}
            onFocus={() => setSelected(i)}
            onDoubleClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              dragging.current = true;
              setSelected(i);
            }}
            onPointerMove={(event) => {
              if (!dragging.current || !event.currentTarget.hasPointerCapture(event.pointerId))
                return;
              const next = fromPointer(event);
              changePoint(i, next.x, next.y, false);
            }}
            onPointerUp={(event) => {
              if (!dragging.current) return;
              dragging.current = false;
              event.currentTarget.releasePointerCapture(event.pointerId);
              onChange(encode(draft.current));
            }}
            onPointerCancel={() => {
              dragging.current = false;
              const next = decode(value);
              draft.current = next;
              setPoints(next);
            }}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 0.1 : 0.01;
              const deltas: Record<string, [number, number]> = {
                ArrowLeft: [-step, 0],
                ArrowRight: [step, 0],
                ArrowUp: [0, step],
                ArrowDown: [0, -step],
              };
              if (deltas[event.key]) {
                event.preventDefault();
                event.stopPropagation();
                changePoint(i, p.x + deltas[event.key][0], p.y + deltas[event.key][1], true);
              } else if (event.key === 'Delete' || event.key === 'Backspace') {
                event.preventDefault();
                event.stopPropagation();
                removePoint(i);
              } else if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault();
                event.stopPropagation();
                changePoint(i, p.x, event.key === 'Home' ? 0 : 1, true);
              } else if (event.key === 'Escape' && dragging.current) {
                event.preventDefault();
                event.stopPropagation();
                dragging.current = false;
                const next = decode(value);
                draft.current = next;
                setPoints(next);
              }
            }}
          />
        ))}
      </svg>
      <div className="studio-curve-coordinates">
        <span>Point {selected + 1}</span>
        <label>
          In{' '}
          <NumberField
            value={point.x}
            min={
              selected === 0
                ? 0
                : selected === points.length - 1
                  ? 1
                  : points[selected - 1].x + 0.001
            }
            max={
              selected === 0
                ? 0
                : selected === points.length - 1
                  ? 1
                  : points[selected + 1].x - 0.001
            }
            step={0.01}
            label="Curve input"
            onChange={(x) => changePoint(selected, x, point.y, true)}
          />
        </label>
        <label>
          Out{' '}
          <NumberField
            value={point.y}
            min={0}
            max={1}
            step={0.01}
            label="Curve output"
            onChange={(y) => changePoint(selected, point.x, y, true)}
          />
        </label>
      </div>
      <div className="studio-curve-actions">
        <button type="button" onClick={() => addPoint()} disabled={points.length >= 16}>
          <Plus size={12} /> Point
        </button>
        <button
          type="button"
          onClick={() => removePoint(selected)}
          disabled={selected === 0 || selected === points.length - 1}
        >
          <Trash2 size={12} /> Remove
        </button>
        <button type="button" onClick={() => onChange('[[0,0],[1,1]]')}>
          <RotateCcw size={12} /> Reset
        </button>
      </div>
      <p className="studio-help">
        Drag points or use arrow keys. Shift moves farther. Double-click the graph to add a point.
      </p>
    </div>
  );
}
