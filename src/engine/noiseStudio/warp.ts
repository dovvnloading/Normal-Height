import type { StudioSettings } from '../../model/noiseStudio';
import { deriveSeed } from '../../model/noiseStudio';
import { createKernel } from './kernels';
import { octaveVisibility } from './math';

export interface WarpedPoint {
  x: number;
  y: number;
}
export interface DomainWarper {
  warp(x: number, y: number, footprint: number): WarpedPoint;
  /** Estimate the largest local singular value of the complete warp mapping. */
  stretch(x: number, y: number, footprint: number, center: WarpedPoint): number;
}

export function createDomainWarper(s: StudioSettings, nodeSeed: number): DomainWarper | undefined {
  // Exact identity: neither stream construction nor floating-point displacement
  // enters the zero-amplitude path, regardless of the remaining warp controls.
  if (s.warpType === 'none' || s.warpAmplitude === 0) return undefined;
  const seed =
    s.warpSeedMode === 'fixed' ? s.warpSeed >>> 0 : deriveSeed(nodeSeed, 200, s.warpSeed);
  const settings: StudioSettings = { ...s, kernel: s.warpKernel };
  const layers = Array.from({ length: s.warpOctaves }, (_, i) => ({
    x: createKernel(settings, deriveSeed(seed, 201, i)),
    y: s.warpType === 'curl' ? undefined : createKernel(settings, deriveSeed(seed, 202, i)),
    frequency: s.warpFrequency * s.warpLacunarity ** i,
    amplitude: s.warpPersistence ** i,
  }));
  const normalization = layers.reduce((sum, layer) => sum + layer.amplitude, 0);
  const warp = (x: number, y: number, footprint: number): WarpedPoint => {
    let wx = x,
      wy = y;
    for (const layer of layers) {
      if (layer.amplitude === 0) continue;
      const visibility = footprint > 0 ? octaveVisibility(footprint * layer.frequency) : 1;
      if (visibility === 0) continue;
      const px = (s.warpType === 'progressive' ? wx : x) * layer.frequency;
      const py = (s.warpType === 'progressive' ? wy : y) * layer.frequency;
      const amplitude = (s.warpAmplitude * layer.amplitude * visibility) / normalization;
      if (s.warpType === 'curl') {
        const g = layer.x.gradient(px, py);
        // The rotated gradient is a curl field. Scaling each octave by a
        // constant keeps that property; this is displacement, not a fluid solve.
        wx += amplitude * g.dy * 0.4;
        wy -= amplitude * g.dx * 0.4;
      } else {
        wx += amplitude * layer.x.sample(px, py);
        wy += amplitude * layer.y!.sample(px, py);
      }
    }
    return { x: wx, y: wy };
  };
  return {
    warp,
    stretch(x, y, footprint, center) {
      if (footprint <= 0) return 1;
      // Forward differences over a fraction of the pixel estimate how the field
      // is magnified by the actual, possibly progressive mapping. This is a local
      // footprint heuristic; optional multisampling addresses unresolved curvature.
      const h = Math.max(0.0001, Math.min(0.01, footprint * 0.25));
      const px = warp(x + h, y, footprint),
        py = warp(x, y + h, footprint);
      const a = (px.x - center.x) / h,
        b = (py.x - center.x) / h;
      const c = (px.y - center.y) / h,
        d = (py.y - center.y) / h;
      const trace = a * a + b * b + c * c + d * d,
        determinant = a * d - b * c;
      return Math.max(
        1,
        Math.sqrt(
          0.5 * (trace + Math.sqrt(Math.max(0, trace * trace - 4 * determinant * determinant))),
        ),
      );
    },
  };
}
