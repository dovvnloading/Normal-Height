import type { ParamValue } from '../../model/types';
import { resolveNoiseSeed, resolveStudioSettings } from '../../model/noiseStudio';
import { createFractal } from './fractal';
import { createDomainWarper } from './warp';
import { createOutputShaper } from './curve';
import { mix, positiveModulo, quintic } from './math';

export interface StudioSampler {
  /**
   * u/v are normalized tile coordinates; footprint is the normalized pixel
   * spacing (usually 1/(resolution-1)). This method includes selected quality,
   * seamless blending and output shaping, identically for preview and export.
   */
  sample(u: number, v: number, footprint?: number): number;
}

export function createStudioSampler(
  params: Record<string, ParamValue>,
  projectSeed: number,
  worldSize: number,
): StudioSampler {
  const s = resolveStudioSettings(params),
    seed = resolveNoiseSeed(s, projectSeed);
  const fractal = createFractal(s, seed),
    warper = createDomainWarper(s, seed),
    shape = createOutputShaper(s);
  const tileSize = Number.isFinite(worldSize) && worldSize > 0 ? worldSize : 1;
  const frequency = s.scaleMode === 'world' ? tileSize / s.featureSize : s.scale;
  const sx = frequency * s.scaleX,
    sy = frequency * s.scaleY;
  const angle = (s.rotation * Math.PI) / 180,
    cos = Math.cos(angle),
    sin = Math.sin(angle);
  const frequencyBound = Math.max(sx, sy);
  const seamless = s.tiling === 'blend';
  const samples = s.sampling === 'supersample4' ? 4 : s.sampling === 'supersample2' ? 2 : 1;
  const field = (u: number, v: number, footprint: number): number => {
    const ax = (u - 0.5) * sx,
      ay = (v - 0.5) * sy;
    const x = ax * cos - ay * sin + s.offsetX,
      y = ax * sin + ay * cos + s.offsetY;
    let localFootprint = footprint * frequencyBound;
    if (!warper) return fractal.sample(x, y, localFootprint);
    const p = warper.warp(x, y, localFootprint);
    if (localFootprint > 0) localFootprint *= warper.stretch(x, y, localFootprint, p);
    return fractal.sample(p.x, p.y, localFootprint);
  };
  const periodicField = seamless
    ? (u: number, v: number, footprint: number): number => {
        const x = positiveModulo(u, 1),
          y = positiveModulo(v, 1),
          wx = quintic(x),
          wy = quintic(y);
        // Periodize the complete transformed/warped field, not lattice indexes.
        // Quintic weights make both values and first derivatives match at borders.
        const a = field(x, y, footprint),
          b = field(x - 1, y, footprint);
        const c = field(x, y - 1, footprint),
          d = field(x - 1, y - 1, footprint);
        return mix(mix(a, b, wx), mix(c, d, wx), wy);
      }
    : field;
  return {
    sample(u, v, footprint = 0) {
      if (!Number.isFinite(u) || !Number.isFinite(v))
        throw new Error('Noise coordinates must be finite.');
      footprint = Number.isFinite(footprint) ? Math.max(0, footprint) : 0;
      if (seamless) {
        u = positiveModulo(u, 1);
        v = positiveModulo(v, 1);
      }
      if (s.sampling === 'point') return shape(periodicField(u, v, 0));
      if (samples === 1 || footprint === 0) return shape(periodicField(u, v, footprint));
      let sum = 0;
      // Integrate shaped samples, so nonlinear levels/curves and narrow features
      // benefit too. Each subpixel uses its own smaller reconstruction footprint.
      const subpixel = footprint / samples;
      for (let j = 0; j < samples; j++)
        for (let i = 0; i < samples; i++) {
          const ox = ((i + 0.5) / samples - 0.5) * footprint;
          const oy = ((j + 0.5) / samples - 0.5) * footprint;
          sum += shape(periodicField(u + ox, v + oy, subpixel));
        }
      return sum / (samples * samples);
    },
  };
}

export function generateStudioNoise(
  params: Record<string, ParamValue>,
  projectSeed: number,
  resolution: number,
  worldSize: number,
  onProgress?: (fraction: number) => void,
): Float32Array {
  if (!Number.isSafeInteger(resolution) || resolution < 1 || resolution > 8192)
    throw new Error('Noise resolution must be an integer from 1 to 8192.');
  const data = new Float32Array(resolution * resolution),
    sampler = createStudioSampler(params, projectSeed, worldSize);
  const spacing = resolution > 1 ? 1 / (resolution - 1) : 1;
  onProgress?.(0);
  for (let y = 0; y < resolution; y++) {
    const v = resolution > 1 ? (y === resolution - 1 ? 1 : y * spacing) : 0.5;
    for (let x = 0; x < resolution; x++)
      data[y * resolution + x] = sampler.sample(
        resolution > 1 ? (x === resolution - 1 ? 1 : x * spacing) : 0.5,
        v,
        spacing,
      );
    if ((y & 15) === 15 || y === resolution - 1) onProgress?.((y + 1) / resolution);
  }
  return data;
}
