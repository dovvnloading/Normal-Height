import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPLINE_PATH,
  MAX_SPLINE_POINTS,
  SPLINE_GUIDE_STEPS,
  insertSplinePoint,
  moveSplinePoint,
  sampleSpline,
  splineDirectionMarkers,
  splineFootprint,
  splineLength,
  splitLongestSplineSpan,
  validSplinePoint,
} from '../src/model/splines';

describe('spline path designer geometry', () => {
  it('inserts into the nearest curved span instead of the nearest control polygon edge', () => {
    const points = [
      { x: 0.1, y: 0.1 }, { x: 0.2, y: 0.8 },
      { x: 0.7, y: 0.8 }, { x: 0.85, y: 0.1 },
    ];
    const click = { x: 0.17, y: 0.85 };
    // The straight polygon would insert before point two; the visible
    // Catmull–Rom curve bows below that point and belongs to span two.
    expect(insertSplinePoint(points, click)).toEqual([
      points[0], points[1], click, points[2], points[3],
    ]);
    expect(points).toHaveLength(4);
    expect(insertSplinePoint(points, { x: -2, y: 2 }).every(validSplinePoint)).toBe(true);
    expect(insertSplinePoint(points, { x: NaN, y: 0.2 })).toEqual(points);
  });

  it('splits the longest span at half its curved length without swapping endpoints', () => {
    const points = [
      { x: 0.1, y: 0.2 }, { x: 0.2, y: 0.2 },
      { x: 0.8, y: 0.8 }, { x: 0.85, y: 0.4 },
    ];
    const next = splitLongestSplineSpan(points);
    expect(next).toHaveLength(5);
    expect(next.filter((_, i) => i !== 2)).toEqual(points);
    const curve = sampleSpline(points, SPLINE_GUIDE_STEPS)
      .slice(SPLINE_GUIDE_STEPS, SPLINE_GUIDE_STEPS * 2 + 1);
    // The inserted point lies on the sampled curved span, not its chord.
    const lengths = curve.slice(1).map((p, i) => Math.hypot(p.x - curve[i].x, p.y - curve[i].y));
    let walked = 0;
    const halfway = lengths.reduce((a, b) => a + b, 0) / 2;
    const i = lengths.findIndex((d) => {
      if (walked + d >= halfway) return true;
      walked += d;
      return false;
    });
    expect(i).toBeGreaterThanOrEqual(0);
    const t = (halfway - walked) / lengths[i];
    expect(next[2].x).toBeCloseTo(curve[i].x + t * (curve[i + 1].x - curve[i].x), 10);
    expect(next[2].y).toBeCloseTo(curve[i].y + t * (curve[i + 1].y - curve[i].y), 10);
  });

  it('handles coincident points, capacity, invalid moves and edge clamping', () => {
    const same = [{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }];
    expect(splineLength(same)).toBeCloseTo(0, 10);
    expect(splitLongestSplineSpan(same)).toEqual(same);
    expect(splineDirectionMarkers(sampleSpline(same))).toEqual([]);
    const full = Array.from({ length: MAX_SPLINE_POINTS }, (_, i) => ({ x: i / (MAX_SPLINE_POINTS - 1), y: 0.5 }));
    expect(insertSplinePoint(full, { x: 0.5, y: 0.7 })).toEqual(full);
    expect(splitLongestSplineSpan(full)).toEqual(full);
    expect(moveSplinePoint(full, -1, { x: 0, y: 0 })).toEqual(full);
    expect(moveSplinePoint(full, 0, { x: Infinity, y: 0 })).toEqual(full);
    expect(moveSplinePoint(full, 0, { x: -0.1, y: 1.1 })[0]).toEqual({ x: 0, y: 1 });
    expect(full[0]).toEqual({ x: 0, y: 0.5 });
  });

  it('measures centerline distance and evenly spaced direction arrows in map coordinates', () => {
    const path = [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }];
    expect(splineLength(path)).toBeCloseTo(0.8, 10);
    const markers = splineDirectionMarkers(sampleSpline(path, SPLINE_GUIDE_STEPS));
    expect(markers).toHaveLength(3);
    for (const [i, marker] of markers.entries()) {
      expect(marker.x).toBeCloseTo(0.1 + (i + 1) * 0.2, 10);
      expect(marker.y).toBeCloseTo(0.5, 10);
      expect(marker.angle).toBeCloseTo(0, 10);
    }
    const reverse = splineDirectionMarkers(sampleSpline([...path].reverse(), SPLINE_GUIDE_STEPS));
    expect(reverse[0].x).toBeCloseTo(0.7, 10);
    expect(Math.abs(reverse[0].angle)).toBeCloseTo(180, 10);
    expect(splineLength(DEFAULT_SPLINE_PATH)).toBeGreaterThan(0.8);
  });

  it('reports the same authored radius limits as terrain sculpting', () => {
    expect(splineFootprint(0.02, 3)).toEqual({ core: 0.02, outer: 0.06 });
    const max = splineFootprint(5, 8);
    expect(max.core).toBe(0.12);
    expect(max.outer).toBeCloseTo(0.72);
    expect(splineFootprint(0, 0)).toEqual({ core: 0.002, outer: 0.003 });
    expect(splineFootprint(NaN, Infinity)).toEqual({ core: 0.016, outer: 0.048 });
  });
});
