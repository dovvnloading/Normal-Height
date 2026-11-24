import type { ParamValue } from '../../model/types';
import type { WorldDomain } from '../../model/world';
import { resolveNoiseSeed, resolveStudioSettings } from '../../model/noiseStudio';
import { createFractal } from '../noiseStudio/fractal';
import { createDomainWarper } from '../noiseStudio/warp';
import { createOutputShaper } from '../noiseStudio/curve';
import { mix, positiveModulo, quintic } from '../noiseStudio/math';

/**
 * Studio algorithms with a World-v1 coordinate contract. Absolute Cartesian
 * coordinates anchor the lattice, while tile frequency refers to the whole
 * authored domain. No per-tile centering, reseeding, or periodization occurs.
 */
export function createWorldNoiseSampler(params: Record<string, ParamValue>, seed: number, domain: WorldDomain) {
  const s = resolveStudioSettings(params), resolvedSeed = resolveNoiseSeed(s, seed);
  const fractal = createFractal(s, resolvedSeed), warp = createDomainWarper(s, resolvedSeed), shape = createOutputShaper(s);
  const fx = s.scaleMode === 'world' ? s.scaleX / s.featureSize : s.scale * s.scaleX / domain.width;
  const fz = s.scaleMode === 'world' ? s.scaleY / s.featureSize : s.scale * s.scaleY / domain.depth;
  const radians = s.rotation * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
  const periodic = domain.boundary === 'periodic' || s.tiling === 'blend';
  const samples = s.sampling === 'supersample4' ? 4 : s.sampling === 'supersample2' ? 2 : 1;
  const field = (worldX: number, worldZ: number, footprint: number): number => {
    const ax = worldX * fx, az = worldZ * fz;
    const x = ax * cos - az * sin + s.offsetX, z = ax * sin + az * cos + s.offsetY;
    if (!warp) return fractal.sample(x, z, footprint);
    const p = warp.warp(x, z, footprint);
    return fractal.sample(p.x, p.y, footprint > 0 ? footprint * warp.stretch(x, z, footprint, p) : 0);
  };
  const evaluate = (x: number, z: number, footprint: number): number => {
    if (!periodic) return field(x, z, footprint);
    const u = positiveModulo((x - domain.originX) / domain.width, 1);
    const v = positiveModulo((z - domain.originZ) / domain.depth, 1);
    const wx = quintic(u), wz = quintic(v);
    const px = domain.originX + u * domain.width, pz = domain.originZ + v * domain.depth;
    return mix(mix(field(px, pz, footprint), field(px - domain.width, pz, footprint), wx),
      mix(field(px, pz - domain.depth, footprint), field(px - domain.width, pz - domain.depth, footprint), wx), wz);
  };
  return (x: number, z: number, dx: number, dz: number): number => {
    const footprint = s.sampling === 'point' ? 0 : Math.max(Math.abs(dx * fx), Math.abs(dz * fz));
    if (samples === 1 || footprint === 0) return shape(evaluate(x, z, footprint));
    let sum = 0;
    for (let j = 0; j < samples; j++) for (let i = 0; i < samples; i++)
      sum += shape(evaluate(x + ((i + 0.5) / samples - 0.5) * dx,
        z + ((j + 0.5) / samples - 0.5) * dz, footprint / samples));
    return sum / (samples * samples);
  };
}
