import { clamp, smoothstep } from './math';

/**
 * Exact 1D box convolution of 1-smoothstep(0,width,abs(distance)). Applied to a
 * Voronoi edge this is a local straight-border footprint approximation; corners
 * and a rotated square pixel's projected footprint still benefit from supersampling.
 */
export function filteredEdgeMask(distance: number, width: number, footprint: number): number {
  if (footprint <= 1e-8) return 1 - smoothstep(0, width, distance);
  const primitive = (x: number): number => {
    const t = Math.min(1, Math.abs(x) / width);
    return Math.sign(x) * width * (t - t * t * t + 0.5 * t * t * t * t);
  };
  const h = footprint * 0.5;
  return clamp((primitive(distance + h) - primitive(distance - h)) / footprint);
}

/**
 * Moment-matched approximation to box-filtering (1-r²/R²)^power.
 * The broadened profile preserves its integral and adds pixel variance fp²/12
 * per axis. It is an approximation to the convolution, not a new noise scale.
 */
export function broadenSpot(
  radius: number,
  power: number,
  footprint: number,
): { radius: number; amplitude: number } {
  const original = radius * radius,
    broadened = original + ((power + 2) * footprint * footprint) / 6;
  return { radius: Math.sqrt(broadened), amplitude: original / broadened };
}
