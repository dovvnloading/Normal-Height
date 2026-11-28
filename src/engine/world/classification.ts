import type { TerrainNode } from '../../model/types';

/** Shared by capability reports and allocation preflight; bypasses schedule no solver. */
export function isWorldGlobalNode(node: TerrainNode, hasInput: boolean): boolean {
  if (node.bypassed && hasInput) return false;
  return (
    node.kind === 'mountain' ||
    (node.kind === 'noise' && node.params.noiseModel !== 'v3') ||
    node.kind === 'hydraulic' ||
    node.kind === 'thermal' ||
    node.kind === 'spline' ||
    node.kind === 'coast'
  );
}
