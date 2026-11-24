import { clamp } from './noise';

/**
 * Simulation transfers already obey local mask opacity. During regridding
 * or smoothing, limit only the excess permission interpolated into a more
 * protected cell. Never multiply by the full mask again or amplify a delta.
 */
export function reconstructionWeight(requested: number, interpolated: number): number {
  const permission = clamp(requested);
  if (permission === 0) return 0;
  return interpolated > permission ? permission / interpolated : 1;
}

/** Apply the same reconstructed permission to a solid layer's change, not its
 * original cover. This keeps protected bedrock and soil partitions aligned
 * with the reconstructed surface, without inventing or amplifying transfers.
 */
export function reconstructMobileCover(initial: number, change: number, weight: number): number {
  return Math.max(0, initial + change * weight);
}
