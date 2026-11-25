import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import {
  insertSplinePoint,
  MAX_SPLINE_POINTS,
  moveSplinePoint,
  sampleSpline,
  splineDirectionMarkers,
  splineFootprint,
  SPLINE_GUIDE_STEPS,
  type SplinePoint,
} from '../model/splines';

type ScreenPoint = { x: number; y: number };
type Frame = { zoom: number; offset: ScreenPoint };
type Capture = { target: Element; position: ScreenPoint; type: string };
type Gesture =
  | { kind: 'point'; pointer: number; index: number; start: ScreenPoint; original: SplinePoint; size: number; moved: boolean }
  | { kind: 'background' | 'pan'; pointer: number; start: ScreenPoint; frame: Frame }
  | { kind: 'pinch'; pointers: [number, number]; distance: number; middle: ScreenPoint; frame: Frame };

interface Props {
  points: readonly SplinePoint[];
  editing: boolean;
  ridge: boolean;
  width: number;
  falloff: number;
  strength: number;
  left: number;
  top: number;
  size: number;
  frame: Frame;
  onFrameChange: (frame: Frame) => void;
  onPathChange: (path: SplinePoint[]) => void;
}

const screenPoint = (event: ReactPointerEvent): ScreenPoint => ({ x: event.clientX, y: event.clientY });
const distance = (a: ScreenPoint, b: ScreenPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: ScreenPoint, b: ScreenPoint) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const CLICK_SLOP = 6;
const HANDLE_SLOP = 3;

/** The overlay owns its gestures, not the canvas underneath. Pointer capture
 * keeps edits local; only a completed click or handle drag changes the project. */
export function SplineMapOverlay({
  points, editing, ridge, width, falloff, strength, left, top, size, frame,
  onFrameChange, onPathChange,
}: Props) {
  const layer = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const captures = useRef(new Map<number, Capture>());
  const lastHandleClick = useRef<number | null>(null);
  const [draft, setDraft] = useState<SplinePoint[] | null>(null);
  const displayed = draft ?? points;
  const curve = useMemo(() => sampleSpline(displayed, SPLINE_GUIDE_STEPS), [displayed]);
  const arrows = useMemo(() => ridge ? [] : splineDirectionMarkers(curve), [curve, ridge]);
  const polyline = curve.map((p) => `${p.x * 1000},${p.y * 1000}`).join(' ');
  const footprint = splineFootprint(width, falloff);
  const markerScale = 1000 / Math.max(1, size);

  const release = (pointer: number) => {
    const capture = captures.current.get(pointer);
    captures.current.delete(pointer);
    if (capture?.target.hasPointerCapture(pointer)) capture.target.releasePointerCapture(pointer);
  };
  const cancel = () => {
    gesture.current = null;
    lastHandleClick.current = null;
    for (const pointer of [...captures.current.keys()]) release(pointer);
    setDraft(null);
  };

  // Undo, inspector changes, node switches and exiting edit mode invalidate a
  // draft. A lost browser gesture must never write over the new path.
  useLayoutEffect(() => {
    cancel();
  }, [points, editing]);
  useEffect(() => {
    const blur = () => cancel();
    const key = (event: KeyboardEvent) => {
      if (!captures.current.size || document.querySelector('dialog[open]')) return;
      const undo = (event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase());
      if (event.key !== 'Escape' && !undo) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancel();
    };
    window.addEventListener('blur', blur);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('blur', blur);
      window.removeEventListener('keydown', key, true);
      gesture.current = null;
      for (const pointer of [...captures.current.keys()]) release(pointer);
    };
  }, []);

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!editing || ![0, 1, 2].includes(event.button)) return;
    const position = screenPoint(event);
    const active = [...captures.current.entries()];
    // A pen or mouse gesture must not be interrupted by a palm or another mouse button.
    if (active.length && (event.pointerType !== 'touch' || active.some(([, c]) => c.type !== 'touch'))) return;
    if (captures.current.has(event.pointerId) || (!active.length && event.pointerType === 'touch' && !event.isPrimary)) return;
    const target = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>('button[data-spline-index]')
      : null;
    const index = target ? Number(target.dataset.splineIndex) : -1;
    const handle = event.button === 0 && target && points[index] ? target : null;
    const captureTarget = handle || event.currentTarget;
    event.preventDefault();
    captureTarget.setPointerCapture(event.pointerId);
    captures.current.set(event.pointerId, { target: captureTarget, position, type: event.pointerType });
    lastHandleClick.current = null;

    if (active.length) {
      // A second finger converts the gesture to navigation without committing
      // the first finger's draft. The remaining finger cannot start an edit.
      setDraft(null);
      if (active.length === 1 && gesture.current && gesture.current.kind !== 'pinch') {
        const [id, first] = active[0];
        gesture.current = {
          kind: 'pinch', pointers: [id, event.pointerId],
          distance: Math.max(1, distance(first.position, position)),
          middle: midpoint(first.position, position), frame,
        };
      }
      return;
    }

    if (handle) {
      handle.focus({ preventScroll: true });
      gesture.current = { kind: 'point', pointer: event.pointerId, index,
        start: position, original: points[index], size: Math.max(1, size), moved: false };
    } else {
      gesture.current = { kind: event.button === 0 ? 'background' : 'pan',
        pointer: event.pointerId, start: position, frame };
    }
  };

  const movedPoint = (g: Extract<Gesture, { kind: 'point' }>, position: ScreenPoint) =>
    moveSplinePoint(points, g.index, {
      x: g.original.x + (position.x - g.start.x) / g.size,
      y: g.original.y + (position.y - g.start.y) / g.size,
    });

  const pan = (g: Extract<Gesture, { kind: 'background' | 'pan' }>, position: ScreenPoint) =>
    onFrameChange({
      zoom: g.frame.zoom,
      offset: {
        x: g.frame.offset.x + position.x - g.start.x,
        y: g.frame.offset.y + position.y - g.start.y,
      },
    });

  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const capture = captures.current.get(event.pointerId);
    if (!capture) return;
    const position = screenPoint(event);
    capture.position = position;
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pinch') {
      const [a, b] = g.pointers.map((id) => captures.current.get(id)?.position);
      const bounds = layer.current?.parentElement?.getBoundingClientRect();
      if (!a || !b || !bounds) return;
      const zoom = Math.max(0.35, Math.min(12, g.frame.zoom * distance(a, b) / g.distance));
      const middle = midpoint(a, b);
      const cx = bounds.left + bounds.width / 2, cy = bounds.top + bounds.height / 2;
      const ratio = zoom / g.frame.zoom;
      onFrameChange({
        zoom,
        offset: {
          x: middle.x - cx - (g.middle.x - cx - g.frame.offset.x) * ratio,
          y: middle.y - cy - (g.middle.y - cy - g.frame.offset.y) * ratio,
        },
      });
      return;
    }
    if (g.pointer !== event.pointerId) return;
    if (g.kind === 'point') {
      if (distance(position, g.start) >= HANDLE_SLOP) g.moved = true;
      if (g.moved) setDraft(movedPoint(g, position));
    } else if (g.kind === 'pan' || distance(position, g.start) >= CLICK_SLOP) {
      gesture.current = { ...g, kind: 'pan' };
      pan(g, position);
    }
  };

  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!captures.current.has(event.pointerId)) return;
    const g = gesture.current;
    const position = screenPoint(event);
    release(event.pointerId);
    if (g?.kind === 'pinch') {
      if (g.pointers.includes(event.pointerId)) gesture.current = null;
      return;
    }
    if (!g || g.pointer !== event.pointerId) return;
    gesture.current = null;
    setDraft(null);
    if (g.kind === 'point') {
      if (distance(position, g.start) >= HANDLE_SLOP) {
        const next = movedPoint(g, position);
        if (next[g.index].x !== g.original.x || next[g.index].y !== g.original.y) onPathChange(next);
      } else if (!g.moved) {
        lastHandleClick.current = g.index;
      }
    } else if (g.kind === 'pan' || distance(position, g.start) >= CLICK_SLOP) {
      pan(g, position);
    } else if (points.length < MAX_SPLINE_POINTS) {
      const bounds = layer.current?.getBoundingClientRect();
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
      const x = (position.x - bounds.left) / bounds.width, y = (position.y - bounds.top) / bounds.height;
      if (x >= 0 && x <= 1 && y >= 0 && y <= 1) onPathChange(insertSplinePoint(points, { x, y }));
    }
  };

  const removePoint = (index: number) => {
    if (points.length <= 2) return;
    // Keep focus in the editor, including when the final handle is removed.
    if (index === points.length - 1)
      layer.current?.querySelector<HTMLButtonElement>(`[data-spline-index="${index - 1}"]`)?.focus({ preventScroll: true });
    onPathChange(points.filter((_, i) => i !== index));
  };

  const handleKey = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.ctrlKey || event.metaKey || event.altKey || captures.current.size) return;
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
    };
    const delta = arrows[event.key];
    if (delta) {
      event.preventDefault();
      event.stopPropagation();
      const step = event.shiftKey ? 0.01 : 0.001;
      const point = points[index];
      const next = moveSplinePoint(points, index, { x: point.x + delta[0] * step, y: point.y + delta[1] * step });
      if (next[index].x !== point.x || next[index].y !== point.y) onPathChange(next);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) removePoint(index);
    }
  };

  return (
    <div
      ref={layer}
      className={`nh-spline-layer ${editing ? 'is-editing' : ''} ${ridge ? 'is-ridge' : 'is-river'}`}
      style={{ left, top, width: size, height: size }}
      aria-label="Spline path overlay"
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={(event) => { if (captures.current.has(event.pointerId)) cancel(); }}
      onLostPointerCapture={(event) => { if (captures.current.has(event.pointerId)) cancel(); }}
      onContextMenu={(event) => event.preventDefault()}
      onWheel={() => { if (captures.current.size) cancel(); }}
    >
      <svg className="nh-spline-drawing" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
        {editing && strength > 0 && (
          <svg className="nh-spline-footprint" viewBox="0 0 1000 1000" width="1000" height="1000">
            <polyline className="nh-spline-outer" points={polyline} strokeWidth={2000 * footprint.outer} />
            <polyline className="nh-spline-core" points={polyline} strokeWidth={2000 * footprint.core} />
          </svg>
        )}
        <polyline className="nh-spline-outline" points={polyline} fill="none" vectorEffect="non-scaling-stroke" strokeWidth={5} />
        <polyline className="nh-spline-centerline" points={polyline} fill="none" vectorEffect="non-scaling-stroke" strokeWidth={2.5} />
        {arrows.map((arrow, index) => (
          <g key={index} transform={`translate(${arrow.x * 1000} ${arrow.y * 1000}) rotate(${arrow.angle}) scale(${markerScale})`}>
            <path className="nh-spline-arrow-shadow" d="M -5 -5 L 2 0 L -5 5" />
            <path className="nh-spline-arrow" d="M -5 -5 L 2 0 L -5 5" />
          </g>
        ))}
      </svg>
      {editing && displayed.map((point, index) => {
        const role = index === 0 ? (ridge ? 'Start' : 'Headwater') : index === displayed.length - 1 ? (ridge ? 'End' : 'Outlet') : 'Control point';
        return (
          <button
            key={index}
            type="button"
            data-spline-index={index}
            className={`nh-spline-handle ${index === displayed.length - 1 ? 'is-end' : ''} ${draft && gesture.current?.kind === 'point' && gesture.current.index === index ? 'is-dragging' : ''}`}
            aria-label={`Move spline point ${index + 1}`}
            aria-description={`${role}. X ${(point.x * 100).toFixed(1)}%, Y ${(point.y * 100).toFixed(1)}%. Arrow keys move by 0.1%, Shift plus arrow by 1%. Delete removes the point when more than two remain.`}
            aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown Delete Backspace"
            title={`${role} ${index + 1} · ${(point.x * 100).toFixed(1)}% E, ${(point.y * 100).toFixed(1)}% S. Double-click to remove.`}
            style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
            onKeyDown={(event) => handleKey(event, index)}
            onDoubleClick={(event) => {
              event.stopPropagation();
              if (lastHandleClick.current === index && !captures.current.size) removePoint(index);
            }}
          ><span>{index + 1}</span></button>
        );
      })}
      {editing && (
        <span className="nh-spline-edit-hint">
          {ridge ? 'RIDGE' : 'RIVER'} · {displayed.length >= MAX_SPLINE_POINTS ? 'Point limit reached' : 'Click to add'} · Drag map to pan · Esc cancels drag
        </span>
      )}
    </div>
  );
}
