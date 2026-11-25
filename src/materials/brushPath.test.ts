import { describe, expect, it } from 'vitest';
import { mirrorBrushStrokes, penPressure, pointerSamples, simplifyBrushPath,
  smoothPaintPoint, brushCapacityWarning } from './brushPath';
import type { MaterialStroke, PaintPoint } from './materialPaint';

const stroke: MaterialStroke = { layer: 'snow', radius: 0.035, strength: 0.4, hardness: 0.2,
  angle: 25, points: [{ u: 0.2, v: 0.3, pressure: 0.2 }, { u: 0.4, v: 0.6, pressure: 0.8 }] };

describe('paint input path preservation', () => {
  it('retains a curved coalesced path and the dispatched endpoint', () => {
    const samples = [
      { clientX: 10, clientY: 10, pressure: 0.4 },
      { clientX: 20, clientY: 30, pressure: 0.5 },
      { clientX: 30, clientY: 10, pressure: 0.6 },
    ];
    const event = { clientX: 40, clientY: 10, pressure: 0.7, getCoalescedEvents: () => samples };
    expect(pointerSamples(event)).toEqual([...samples, event]);
    expect(pointerSamples({ ...samples[2], getCoalescedEvents: () => samples })).toEqual(samples);
    expect(pointerSamples({ ...event, getCoalescedEvents: undefined })).toHaveLength(1);
  });
  it('keeps pen pressure extrema and endpoints while removing collinear samples', () => {
    const points: PaintPoint[] = Array.from({ length: 101 }, (_, i) => ({
      u: i / 100, v: 0.5, pressure: i <= 50 ? 0.1 + i / 50 * 0.9 : 1 - (i - 50) / 50 * 0.9,
    }));
    const compacted = simplifyBrushPath(points, 0.0002);
    expect(compacted).toHaveLength(3);
    expect(compacted[0]).toEqual(points[0]);
    expect(compacted.at(-1)).toEqual(points.at(-1));
    expect(compacted[1].pressure).toBe(1);
    expect(compacted[0]).not.toBe(points[0]);
  });
  it('bounds spatial error on a curve and preserves the closed loop', () => {
    const points = Array.from({ length: 401 }, (_, i) => ({
      u: 0.5 + Math.cos(i / 400 * Math.PI * 2) * 0.35,
      v: 0.5 + Math.sin(i / 400 * Math.PI * 2) * 0.35,
    }));
    const tolerance = 0.0005;
    const simplified = simplifyBrushPath(points, tolerance);
    expect(simplified.length).toBeLessThan(points.length / 2);
    for (const point of points) {
      let nearest = Infinity;
      for (let i = 1; i < simplified.length; i++) {
        const a = simplified[i - 1], b = simplified[i];
        const dx = b.u - a.u, dy = b.v - a.v;
        const t = Math.max(0, Math.min(1, ((point.u - a.u) * dx + (point.v - a.v) * dy) /
          Math.max(1e-20, dx * dx + dy * dy)));
        nearest = Math.min(nearest, Math.hypot(point.u - a.u - t * dx, point.v - a.v - t * dy));
      }
      expect(nearest).toBeLessThanOrEqual(tolerance + 1e-8);
    }
  });
  it('does not taper a pen to zero on release or apply synthetic mouse pressure', () => {
    expect(penPressure('pen', 0, true, 0.73)).toBe(0.73);
    expect(penPressure('pen', 0.2, false)).toBe(0.2);
    expect(penPressure('mouse', 0.5, false)).toBeUndefined();
    expect(penPressure('touch', 0.3, false)).toBeUndefined();
    expect(penPressure('pen', NaN, false, 0.6)).toBe(0.6);
  });
  it('stabilizes jitter without moving the first point or overshooting', () => {
    const a = { u: 0.3, v: 0.4, pressure: 0.5 };
    const b = { u: 0.301, v: 0.402, pressure: 0.8 };
    expect(smoothPaintPoint(null, a, 1, 0.035)).toEqual(a);
    expect(smoothPaintPoint(a, b, 0, 0.035)).toEqual(b);
    const smooth = smoothPaintPoint(a, b, 0.9, 0.035);
    expect(smooth.u).toBeGreaterThan(a.u);
    expect(smooth.u).toBeLessThan(b.u);
    expect(smooth.v).toBeGreaterThan(a.v);
    expect(smooth.v).toBeLessThan(b.v);
    expect(smooth.pressure).toBe(0.8);
  });
});

describe('stored symmetry', () => {
  it('creates four correctly oriented paths without changing the original', () => {
    const copies = mirrorBrushStrokes([stroke], 'both');
    expect(copies).toHaveLength(4);
    expect(copies[0]).toBe(stroke);
    expect(copies[1].points[0]).toEqual({ u: 0.8, v: 0.3, pressure: 0.2 });
    expect(copies[2].points[0]).toEqual({ u: 0.2, v: 0.7, pressure: 0.2 });
    expect(copies[3].points[0]).toEqual({ u: 0.8, v: 0.7, pressure: 0.2 });
    expect(copies.map(copy => copy.angle)).toEqual([25, 155, -25, -155]);
    expect(stroke.points[0].u).toBe(0.2);
  });
  it('does not double opacity on the axis or at the center', () => {
    const centerLine = { ...stroke, points: [{ u: 0.5, v: 0.2 }, { u: 0.5, v: 0.4 }] };
    expect(mirrorBrushStrokes([centerLine], 'x')).toHaveLength(1);
    expect(mirrorBrushStrokes([centerLine], 'both')).toHaveLength(2);
    expect(mirrorBrushStrokes([{ ...stroke, points: [{ u: 0.5, v: 0.5 }] }], 'both')).toHaveLength(1);
  });
});

describe('capacity warning before commit', () => {
  it('counts mirrored paths against both remaining budgets without altering them', () => {
    const mirrored = mirrorBrushStrokes([stroke], 'both');
    const snapshot = JSON.stringify(mirrored);
    expect(brushCapacityWarning(mirrored, 10, 100)).toBe(true);
    expect(brushCapacityWarning(mirrored, 100, 5)).toBe(true);
    expect(brushCapacityWarning(mirrored, 100, 100)).toBe(false);
    expect(brushCapacityWarning(mirrored)).toBe(false);
    expect(JSON.stringify(mirrored)).toBe(snapshot);
  });
});
