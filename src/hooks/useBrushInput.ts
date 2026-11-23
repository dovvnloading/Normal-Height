import { useEffect, useRef } from 'react';
import type { MaterialStroke, PaintPoint } from '../materials/materialPaint';
import { MAX_STROKE_POINTS } from '../materials/materialPaint';
import type { HeightField, TerrainProject } from '../model/types';
import type { BrushSettings, BrushFeedback } from '../render/brushFeedback';

interface BrushBinding {
  feedback: BrushFeedback;
  settings: BrushSettings;
  pick: (x: number, y: number) => PaintPoint | null;
  commit: (strokes: MaterialStroke[]) => boolean;
}
export function useBrushInput(
  canvas: () => HTMLCanvasElement | null,
  binding: BrushBinding | null,
  field: HeightField | null,
  project: TerrainProject,
  canvasGeneration = 0,
) {
  const current = useRef({ canvas, binding });
  current.current = { canvas, binding };
  const feedback = binding?.feedback;
  const cancelDrawing = useRef<(() => void) | null>(null);
  // A second pointer can activate a history button or load a project while a
  // stylus is still down. Never append its old draft to the restored project.
  useEffect(() => { cancelDrawing.current?.(); }, [project]);
  useEffect(() => {
    const element = current.current.canvas();
    if (!element || !feedback) return;
    let pointer: number | null = null;
    let strokes: MaterialStroke[] = [];
    let segment: MaterialStroke | null = null;
    let settings: BrushSettings;
    let queued: PointerEvent | null = null;
    let frame = 0;
    const sample = (e: PointerEvent, force = false) => {
      const active = current.current.binding;
      if (!active) return;
      const rect = element.getBoundingClientRect();
      const inside = e.clientX >= rect.left && e.clientX < rect.right &&
        e.clientY >= rect.top && e.clientY < rect.bottom;
      const point = inside ? active.pick(e.clientX, e.clientY) : null;
      feedback.hover(point, pointer === null ? active.settings : settings);
      if (pointer === null) return;
      if (!point) { segment = null; return; }
      if (segment) {
        const last = segment.points[segment.points.length - 1];
        const distance = Math.hypot(point.u - last.u, point.v - last.v);
        if (distance < (force ? 0.000001 : settings.radius * 0.08)) return;
        if (segment.points.length === MAX_STROKE_POINTS) {
          segment = { ...settings, points: [last] };
          strokes.push(segment);
        }
      } else {
        segment = { ...settings, points: [] };
        strokes.push(segment);
      }
      segment.points.push({
        u: Math.round(point.u * 1e6) / 1e6, v: Math.round(point.v * 1e6) / 1e6,
      });
      feedback.preview(strokes);
    };
    const flush = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (queued) sample(queued);
      queued = null;
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0 && e.isPrimary) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      if (pointer !== null || !e.isPrimary || !current.current.binding || !feedback.begin()) return;
      pointer = e.pointerId;
      settings = { ...current.current.binding.settings };
      strokes = [];
      segment = null;
      element.focus({ preventScroll: true });
      element.setPointerCapture(pointer);
      queued = null;
      sample(e);
    };
    const move = (e: PointerEvent) => {
      if (!e.isPrimary || (pointer !== null && pointer !== e.pointerId) ||
          (pointer === null && feedback.drawing)) return;
      if (pointer === null && e.buttons !== 0) {
        feedback.hover(null, feedback.settings);
        return;
      }
      e.stopImmediatePropagation();
      queued = e;
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const reset = () => {
      const id = pointer;
      pointer = null;
      segment = null;
      strokes = [];
      if (id !== null && element.hasPointerCapture(id)) element.releasePointerCapture(id);
    };
    const up = (e: PointerEvent) => {
      if (pointer !== e.pointerId || e.button !== 0) return;
      e.stopImmediatePropagation();
      flush();
      sample(e, true);
      const committed = strokes.length > 0 && !!current.current.binding?.commit(strokes);
      feedback.finish(committed);
      if (e.pointerType === 'touch') feedback.hover(null, settings);
      reset();
    };
    const cancel = (e?: PointerEvent) => {
      if (e && e.pointerId !== pointer) return;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      queued = null;
      if (pointer !== null) feedback.finish(false);
      if (!feedback.drawing) feedback.hover(null, feedback.settings);
      reset();
    };
    cancelDrawing.current = () => { if (pointer !== null) cancel(); };
    const leave = () => {
      if (pointer === null && feedback.drawing) return;
      flush();
      segment = null;
      feedback.hover(null, feedback.settings);
    };
    const key = (e: KeyboardEvent) => {
      if (pointer === null) return;
      const history = (e.ctrlKey || e.metaKey) && ['z', 'y'].includes(e.key.toLowerCase());
      if (e.key === 'Escape' || history) {
        e.preventDefault();
        e.stopImmediatePropagation();
        cancel();
      }
    };
    const wheel = (e: WheelEvent) => {
      // Preserve the picking transform throughout a drag. Between gestures
      // navigation owns the wheel and the next hover repicks the new surface.
      if (pointer !== null) {
        e.preventDefault();
        e.stopImmediatePropagation();
      } else if (!feedback.drawing) leave();
    };
    const blockFocus = (e: MouseEvent) => { e.stopImmediatePropagation(); };
    element.addEventListener('pointerdown', down, true);
    element.addEventListener('pointermove', move, true);
    element.addEventListener('pointerup', up, true);
    element.addEventListener('pointercancel', cancel, true);
    element.addEventListener('lostpointercapture', cancel, true);
    element.addEventListener('pointerleave', leave, true);
    element.addEventListener('dblclick', blockFocus, true);
    element.addEventListener('wheel', wheel, { capture: true, passive: false });
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', leaveWindow);
    function leaveWindow() { cancel(); }
    return () => {
      element.removeEventListener('pointerdown', down, true);
      element.removeEventListener('pointermove', move, true);
      element.removeEventListener('pointerup', up, true);
      element.removeEventListener('pointercancel', cancel, true);
      element.removeEventListener('lostpointercapture', cancel, true);
      element.removeEventListener('pointerleave', leave, true);
      element.removeEventListener('dblclick', blockFocus, true);
      element.removeEventListener('wheel', wheel, true);
      window.removeEventListener('keydown', key, true);
      cancelDrawing.current = null;
      window.removeEventListener('blur', leaveWindow);
      cancel();
    };
  }, [feedback, field, canvasGeneration]);
}
