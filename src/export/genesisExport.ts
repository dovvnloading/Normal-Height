import type { FieldDescriptor } from '../engine/fields';

/** Physical Genesis fields are never range-normalized during delivery. */
export const WORLD_GENESIS_MAPS = [
  'hardness',
  'lithology',
  'uplift',
  'incision',
  'drainageArea',
  'channel',
] as const;

export type WorldGenesisMap = (typeof WORLD_GENESIS_MAPS)[number];

export interface GenesisMapDescriptor extends FieldDescriptor {
  storage: 'raw32' | 'raw8';
  byteOrder: 'little-endian' | 'not-applicable';
  range: [number, number];
  description: string;
  sampling: 'native-physical-geology' | 'reference-bilinear';
}

export function isWorldGenesisMap(map: string): map is WorldGenesisMap {
  return (WORLD_GENESIS_MAPS as readonly string[]).includes(map);
}

/** The ranges are measured metadata, not parameters for decoding the bytes. */
export function genesisMapDescriptor(
  map: WorldGenesisMap,
  algorithm: string,
  range: [number, number],
): GenesisMapDescriptor {
  const descriptions: Record<WorldGenesisMap, string> = {
    hardness: 'Relative resistance to incision, 0–1. Higher values reduce bedrock erodibility.',
    lithology:
      'Unsigned categorical rock-layer ID. No interpolation or normalization of IDs; consult the Genesis lithology legend.',
    uplift: 'Cumulative tectonic uplift in metres, before optional World transport.',
    incision:
      'Cumulative stream-power incision depth in metres. Removed rock is not a sediment-deposition or delivered-sediment field.',
    drainageArea:
      'Weighted upstream contributing area in square metres from the whole-domain drainage graph. This is not discharge or rainfall volume.',
    channel:
      'Channel selection weight, 0–1, from the Genesis drainage analysis; not a water surface or river mesh.',
  };
  return {
    semantic: map === 'drainageArea' ? 'contributing-area' : map,
    units:
      map === 'lithology'
        ? 'category-id'
        : map === 'uplift' || map === 'incision'
          ? 'meters'
          : map === 'drainageArea'
            ? 'square-meters'
            : 'unitless',
    components: 1,
    algorithm,
    storage: map === 'lithology' ? 'raw8' : 'raw32',
    byteOrder: map === 'lithology' ? 'not-applicable' : 'little-endian',
    range: [...range],
    sampling:
      map === 'hardness' || map === 'lithology' ? 'native-physical-geology' : 'reference-bilinear',
    description: descriptions[map],
  };
}
