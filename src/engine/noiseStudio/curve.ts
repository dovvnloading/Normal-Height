import type { CurvePoint, StudioSettings } from '../../model/noiseStudio';
import { parseStudioCurve } from '../../model/noiseStudio';
import { clamp, mix } from './math';

/** Piecewise linear remap, with endpoint-slope extrapolation when unclamped. */
export function evaluateCurve(points: readonly CurvePoint[], value: number): number {
  let i = 0;
  while (i < points.length - 2 && value > points[i + 1].x) i++;
  const a = points[i],
    b = points[i + 1];
  return mix(a.y, b.y, (value - a.x) / (b.x - a.x));
}

export function createOutputShaper(s: StudioSettings): (value: number) => number {
  const points = parseStudioCurve(s.curve),
    range = s.whitePoint - s.blackPoint;
  const identityCurve = points.length === 2 && points[0].y === 0 && points[1].y === 1;
  const gamma = 1 / s.gamma;
  return (value) => {
    let n = (value - s.blackPoint) / range;
    // A signed power keeps unclamped levels finite and meaningful below zero.
    if (s.clampOutput) n = clamp(n);
    if (s.gamma !== 1) n = Math.sign(n) * Math.pow(Math.abs(n), gamma);
    n = (n - 0.5) * s.contrast + 0.5 + s.bias;
    if (s.invert) n = 1 - n;
    if (!identityCurve) n = evaluateCurve(points, n);
    if (s.clampOutput) n = clamp(n);
    // Preserve finite Float32 storage even for deliberately unclamped extreme
    // imported levels/curves. This numerical guard is separate from the artist's
    // optional 0–1 clamp and never changes ordinary terrain values.
    return clamp(n * s.amplitude + s.offset, -3.4028234663852886e38, 3.4028234663852886e38);
  };
}
