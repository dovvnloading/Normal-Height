import { useEffect, useRef } from 'react';
import type { MaterialStroke, PaintPoint } from '../materials/materialPaint';
import { MAX_STROKE_POINTS } from '../materials/materialPaint';
import type { HeightField, TerrainProject } from '../model/types';
import type { BrushSettings, BrushFeedback } from '../render/brushFeedback';
import type { BrushInputSettings, BrushSymmetry } from '../materials/brushPresets';
import { strokeSettings } from '../materials/brushPresets';
import { mirrorBrushStrokes, penPressure, pointerSamples, simplifyBrushPath,
  smoothPaintPoint, brushCapacityWarning } from '../materials/brushPath';

export interface BrushBinding {
  feedback: BrushFeedback;
  settings: BrushInputSettings;
  pick: (x: number, y: number) => PaintPoint | null;
  commit: (strokes: MaterialStroke[]) => boolean;
  /** Alt-click samples a substrate without adding an undo step. */
  sample?: (point: PaintPoint) => void;
  /** Return true for selection/fill tools that consume a primary click. */
  pickAction?: (point: PaintPoint, event: PointerEvent) => boolean;
  /** Synchronous: the map's bubbling handler can read a ref set here. */
  navigation?: (active: boolean) => void;
  onCursor?: (point: PaintPoint | null) => void;
  onLimit?: (message: string) => void;
  remainingPoints?: number;
  remainingStrokes?: number;
  /** Converts a screen-space radius into a tile-space radius at the cursor. */
  radiusAt?: (point: PaintPoint, clientX: number, clientY: number) => number;
}

const ignoresSpace = (target: EventTarget | null) => target instanceof Element &&
  ((target instanceof HTMLElement && target.isContentEditable) ||
    !!target.closest('input,textarea,select,button,a,[role="textbox"],[role="slider"],[role="dialog"]'));
const round = (value: number) => Math.round(value * 1e6) / 1e6;

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
  // History/project changes must never append a draft made against old terrain.
  useEffect(() => { cancelDrawing.current?.(); }, [project]);
  useEffect(() => {
    const element = current.current.canvas();
    if (!element || !feedback) return;
    let pointer: number | null = null;
    let pointerType = '';
    let strokes: MaterialStroke[] = [];
    let segment: MaterialStroke | null = null;
    let settings: BrushSettings;
    let smoothing = 0, symmetry: BrushSymmetry = 'none';
    let smoothed: PaintPoint | null = null;
    let lastPressure = 1;
    let warnedForCapacity = false;
    let queued: PointerEvent[] = [];
    let frame = 0;
    let spaceHeld = false;
    let navigating = false;
    let touchNavigation = false;
    let replaying = false;
    let consumedPointer: number | null = null;
    const navigationPointers = new Set<number>();
    const touches = new Map<number, PointerEvent>();
    const palmPointers = new Set<number>();

    const updateNavigation = () => {
      const next = spaceHeld || touchNavigation || navigationPointers.size > 0;
      if (next === navigating) return;
      navigating = next;
      element.dataset.brushNavigating = String(next);
      current.current.binding?.navigation?.(next);
      if (next && pointer === null) feedback.hover(null, feedback.settings);
    };
    const locate = (event: PointerEvent) => {
      const rect = element.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX >= rect.right ||
          event.clientY < rect.top || event.clientY >= rect.bottom) return null;
      return current.current.binding?.pick(event.clientX, event.clientY) ?? null;
    };
    const cursorSettings = (point: PaintPoint | null, event: PointerEvent): BrushSettings => {
      const active = current.current.binding;
      const next = strokeSettings(active?.settings ?? feedback.settings);
      if (event.shiftKey && next.layer !== 'erase') next.mode = 'blend';
      if (point && active?.radiusAt) {
        const radius = active.radiusAt(point, event.clientX, event.clientY);
        if (Number.isFinite(radius)) next.radius = Math.max(0.0001, Math.min(0.5, radius));
      }
      return next;
    };
    const preview = () => {
      const mirrored = mirrorBrushStrokes(strokes, symmetry);
      const active = current.current.binding;
      if (!warnedForCapacity && active && brushCapacityWarning(mirrored,
        active.remainingPoints, active.remainingStrokes)) {
        warnedForCapacity = true;
        active.onLimit?.('This stroke is approaching the remaining paint capacity. Finish the gesture soon, or free space in Layers before continuing.');
      }
      feedback.preview(mirrored);
    };
    const sample = (event: PointerEvent, force = false) => {
      const active = current.current.binding;
      if (!active) return;
      const point = locate(event);
      feedback.hover(point, pointer === null ? cursorSettings(point, event) : settings);
      active.onCursor?.(point);
      if (pointer === null) return;
      if (!point) { segment = null; smoothed = null; return; }
      const pressure = penPressure(event.pointerType, event.pressure, force, lastPressure);
      if (pressure !== undefined) lastPressure = pressure;
      const raw: PaintPoint = { u: point.u, v: point.v,
        ...(pressure === undefined ? {} : { pressure }) };
      const next = force ? raw : smoothPaintPoint(smoothed, raw, smoothing, settings.radius);
      smoothed = next;
      if (segment) {
        const last = segment.points[segment.points.length - 1];
        const distance = Math.hypot(next.u - last.u, next.v - last.v);
        const pressureChange = Math.abs((next.pressure ?? 1) - (last.pressure ?? 1));
        if (distance < (force ? 0.000001 : settings.radius * 0.018) && pressureChange < 0.015) return;
        if (segment.points.length >= MAX_STROKE_POINTS) {
          // Compact a long quiet path before allocating another bounded segment.
          const simplified = simplifyBrushPath(segment.points, settings.radius * 0.006);
          if (simplified.length < MAX_STROKE_POINTS * 0.85) segment.points = simplified;
          else {
            segment = { ...settings, points: [{ ...last }] };
            strokes.push(segment);
          }
        }
      } else {
        segment = { ...settings, points: [] };
        strokes.push(segment);
      }
      segment.points.push({ u: round(next.u), v: round(next.v),
        ...(next.pressure === undefined ? {} : { pressure: round(next.pressure) }) });
    };
    const flush = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      const batch = queued;
      queued = [];
      for (const event of batch) sample(event);
      if (pointer !== null && batch.length) preview();
    };
    const reset = () => {
      const id = pointer;
      pointer = null;
      pointerType = '';
      segment = null;
      smoothed = null;
      strokes = [];
      if (id !== null && element.hasPointerCapture(id)) element.releasePointerCapture(id);
    };
    const cancel = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      queued = [];
      if (pointer !== null) feedback.finish(false);
      if (!feedback.drawing) feedback.hover(null, feedback.settings);
      reset();
    };
    cancelDrawing.current = cancel;
    const swallow = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const replayTouchStart = (event: PointerEvent) => {
      replaying = true;
      try {
        element.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, composed: true,
          pointerId: event.pointerId, pointerType: 'touch', isPrimary: true,
          clientX: event.clientX, clientY: event.clientY,
          screenX: event.screenX, screenY: event.screenY,
          button: 0, buttons: 1, width: event.width, height: event.height,
          pressure: event.pressure,
        }));
      } finally { replaying = false; }
    };
    const down = (event: PointerEvent) => {
      if (replaying) return;
      const active = current.current.binding;
      if (!active) return;
      if (event.pointerType === 'touch') {
        if (pointerType === 'pen' || (feedback.drawing && pointer === null)) {
          palmPointers.add(event.pointerId);
          swallow(event);
          return;
        }
        touches.set(event.pointerId, event);
        if (touches.size >= 2) {
          const first = [...touches.values()].find(touch => touch.pointerId !== event.pointerId);
          // The first touch never reached OrbitControls/React while painting.
          // Start navigation with that touch before forwarding the second one.
          cancel();
          consumedPointer = null;
          touchNavigation = true;
          updateNavigation();
          if (touches.size === 2 && first) replayTouchStart(first);
          return;
        }
      }
      if (event.pointerType === 'pen' && pointerType === 'touch') {
        for (const id of touches.keys()) palmPointers.add(id);
        touches.clear();
        cancel();
      }
      if (spaceHeld || touchNavigation || (event.button !== 0 && event.isPrimary)) {
        navigationPointers.add(event.pointerId);
        updateNavigation();
        return;
      }
      if (pointer !== null || !event.isPrimary || feedback.drawing) { swallow(event); return; }
      const point = locate(event);
      if (point && ((event.altKey && active.sample) || active.pickAction?.(point, event))) {
        swallow(event);
        if (event.altKey) active.sample?.(point);
        active.onCursor?.(point);
        consumedPointer = event.pointerId;
        element.focus({ preventScroll: true });
        element.setPointerCapture(event.pointerId);
        return;
      }
      // Do not create an empty gesture when a click misses the terrain.
      if (!point) { swallow(event); return; }
      swallow(event);
      if (!feedback.begin()) return;
      pointer = event.pointerId;
      pointerType = event.pointerType;
      settings = cursorSettings(point, event);
      settings.seed = Math.floor(Math.random() * 0x7fffffff);
      smoothing = active.settings.smoothing ?? 0;
      symmetry = active.settings.symmetry ?? 'none';
      lastPressure = penPressure(event.pointerType, event.pressure, false) ?? 1;
      warnedForCapacity = false;
      strokes = [];
      segment = null;
      smoothed = null;
      queued = [];
      element.focus({ preventScroll: true });
      element.setPointerCapture(pointer);
      sample(event);
      preview();
    };
    const move = (event: PointerEvent) => {
      if (replaying) return;
      if (palmPointers.has(event.pointerId)) { swallow(event); return; }
      if (touches.has(event.pointerId)) touches.set(event.pointerId, event);
      if (touchNavigation || navigationPointers.has(event.pointerId) ||
          (spaceHeld && pointer === null)) return;
      if (consumedPointer === event.pointerId) { swallow(event); return; }
      if (!event.isPrimary || (pointer !== null && pointer !== event.pointerId) ||
          (pointer === null && feedback.drawing)) return;
      if (pointer === null && event.buttons !== 0) {
        feedback.hover(null, feedback.settings);
        return;
      }
      event.stopImmediatePropagation();
      // Hover only needs the latest position; a drawn curve needs every sample.
      if (pointer === null) queued = [event];
      else queued.push(...pointerSamples(event));
      // A stalled render frame must not grow an unbounded raw-event queue.
      if (queued.length >= 2048) flush();
      else if (!frame) frame = requestAnimationFrame(flush);
    };
    const endNavigationPointer = (event: PointerEvent) => {
      navigationPointers.delete(event.pointerId);
      touches.delete(event.pointerId);
      if (!touches.size) touchNavigation = false;
      updateNavigation();
    };
    const up = (event: PointerEvent) => {
      if (palmPointers.delete(event.pointerId)) { swallow(event); return; }
      if (touchNavigation || navigationPointers.has(event.pointerId)) {
        endNavigationPointer(event);
        return;
      }
      touches.delete(event.pointerId);
      if (consumedPointer === event.pointerId) {
        swallow(event);
        consumedPointer = null;
        if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
        return;
      }
      if (pointer !== event.pointerId || event.button !== 0) return;
      swallow(event);
      flush();
      sample(event, true);
      const finalized = mirrorBrushStrokes(strokes.map(stroke => ({ ...stroke,
        points: simplifyBrushPath(stroke.points, Math.max(0.000001, stroke.radius * 0.006)),
      })), symmetry);
      // Feedback and committed project share object identities for bake handoff.
      feedback.preview(finalized);
      let committed = false;
      try { committed = finalized.length > 0 && !!current.current.binding?.commit(finalized); }
      catch (error) {
        current.current.binding?.onLimit?.(error instanceof Error ? error.message : 'Could not save this stroke.');
      }
      feedback.finish(committed);
      if (event.pointerType === 'touch') feedback.hover(null, settings);
      reset();
      updateNavigation();
    };
    const cancelPointer = (event: PointerEvent) => {
      if (palmPointers.delete(event.pointerId)) return;
      if (consumedPointer === event.pointerId) consumedPointer = null;
      if (pointer === event.pointerId) cancel();
      if (event.type === 'pointercancel') endNavigationPointer(event);
    };
    const leave = () => {
      if (pointer === null && feedback.drawing) return;
      flush();
      segment = null;
      smoothed = null;
      feedback.hover(null, feedback.settings);
      current.current.binding?.onCursor?.(null);
    };
    const keyDown = (event: KeyboardEvent) => {
      const history = (event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase());
      if (pointer !== null && (event.key === 'Escape' || history)) {
        swallow(event);
        cancel();
        return;
      }
      if ((event.code === 'Space' || event.key === ' ') && !event.ctrlKey && !event.metaKey &&
          !event.altKey && !(event.target instanceof HTMLElement &&
            (event.target.isContentEditable || event.target.matches('input,textarea,select')))) {
        spaceHeld = true;
        if (pointer === null) updateNavigation();
        // Remember the modifier after choosing a toolbar button, while keeping
        // ordinary Space activation available to keyboard users of that button.
        if (ignoresSpace(event.target)) return;
        // Allow the other viewport's capture listener to observe the modifier.
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space' || event.key === ' ') { spaceHeld = false; updateNavigation(); }
    };
    const wheel = (event: WheelEvent) => {
      // Do not change the picking transform during an active stroke.
      if (pointer !== null) swallow(event);
      else if (!feedback.drawing) leave();
    };
    const doubleClick = (event: MouseEvent) => {
      // Space-double-click retains the terrain's existing focus gesture.
      if (!spaceHeld) event.stopImmediatePropagation();
    };
    const leaveWindow = () => {
      cancel();
      spaceHeld = false;
      touchNavigation = false;
      consumedPointer = null;
      navigationPointers.clear(); touches.clear(); palmPointers.clear();
      updateNavigation();
    };
    element.addEventListener('pointerdown', down, true);
    element.addEventListener('pointermove', move, true);
    element.addEventListener('pointerup', up, true);
    element.addEventListener('pointercancel', cancelPointer, true);
    element.addEventListener('lostpointercapture', cancelPointer, true);
    element.addEventListener('pointerleave', leave, true);
    element.addEventListener('dblclick', doubleClick, true);
    element.addEventListener('wheel', wheel, { capture: true, passive: false });
    window.addEventListener('keydown', keyDown, true);
    window.addEventListener('keyup', keyUp, true);
    window.addEventListener('blur', leaveWindow);
    return () => {
      element.removeEventListener('pointerdown', down, true);
      element.removeEventListener('pointermove', move, true);
      element.removeEventListener('pointerup', up, true);
      element.removeEventListener('pointercancel', cancelPointer, true);
      element.removeEventListener('lostpointercapture', cancelPointer, true);
      element.removeEventListener('pointerleave', leave, true);
      element.removeEventListener('dblclick', doubleClick, true);
      element.removeEventListener('wheel', wheel, true);
      window.removeEventListener('keydown', keyDown, true);
      window.removeEventListener('keyup', keyUp, true);
      window.removeEventListener('blur', leaveWindow);
      cancelDrawing.current = null;
      leaveWindow();
      delete element.dataset.brushNavigating;
    };
  }, [feedback, field, canvasGeneration]);
}
