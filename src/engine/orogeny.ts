import { carveConnectedValleys } from './streamCarving';

/** River-network and uplift-derived terrain, routed through the Mountain node. */
export interface OrogenicRelief {
  height: Float32Array;
  drainage: Float32Array;
}

/**
 * Preserve regional uplift and actual source height while sculpting a
 * continuous, outlet-connected dendritic valley network into it.
 *
 * This is the river-feature/landform reconstruction stage. Its stream-power
 * transport diagnostics belong to the separate hydraulic/landscape stages.
 * It never treats accumulated runoff or an integrated stream elevation as a
 * raised ridge, and never paints visual-only noise into the DEM.
 *
 * strength=0 returns a bitwise-identical copy of the classic mountain field.
 */
export function generateOrogenicRelief(
  source: Float32Array,
  resolution: number,
  seed: number,
  strength = 0.82,
): OrogenicRelief {
  const result = carveConnectedValleys(source, resolution, seed, strength);
  return { height: result.height, drainage: result.drainage };
}
