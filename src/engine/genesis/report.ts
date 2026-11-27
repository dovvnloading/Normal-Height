import { GENESIS_ALGORITHM_VERSION } from '../../model/genesis';
import type { GenesisReport } from './types';

const keys = [
  'algorithmVersion',
  'mode',
  'width',
  'height',
  'spacingX',
  'spacingZ',
  'levels',
  'durationYears',
  'upliftVolumeM3',
  'incisedVolumeM3',
  'hillslopeRedistributedVolumeM3',
  'hillslopeResidualM3',
  'reconstructionVolumeM3',
  'finalVolumeChangeM3',
  'outletCount',
  'maxDrainageAreaM2',
  'drainageAreaResidualM2',
  'durationMs',
  'limitations',
] as const;
const levelKeys = ['width', 'height', 'spacingX', 'spacingZ', 'iterations', 'durationYears'];
const metrics = [
  'upliftVolumeM3',
  'incisedVolumeM3',
  'hillslopeRedistributedVolumeM3',
  'hillslopeResidualM3',
  'reconstructionVolumeM3',
  'finalVolumeChangeM3',
  'maxDrainageAreaM2',
  'drainageAreaResidualM2',
  'durationMs',
] as const;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const dimension = (value: unknown): value is number =>
  finite(value) && Number.isSafeInteger(value) && value >= 2 && value <= 1024;
const positive = (value: unknown): value is number => finite(value) && value > 0;
const duration = (value: unknown): value is number =>
  finite(value) && value >= 0 && value <= 2000000;
const shape = (value: Record<string, unknown>, expected: readonly string[]) => {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
};

/** Strict bounded wire/cache validator for the version-one numerical report. */
export function isGenesisReport(value: unknown): value is GenesisReport {
  if (
    !record(value) ||
    !shape(value, keys) ||
    value.algorithmVersion !== GENESIS_ALGORITHM_VERSION ||
    value.mode !== 'multiscale-stream-power' ||
    !dimension(value.width) ||
    !dimension(value.height) ||
    !positive(value.spacingX) ||
    !positive(value.spacingZ) ||
    !duration(value.durationYears) ||
    !Array.isArray(value.levels) ||
    value.levels.length < 1 ||
    value.levels.length > 3 ||
    !finite(value.outletCount) ||
    !Number.isSafeInteger(value.outletCount) ||
    value.outletCount < 1 ||
    value.outletCount > value.width * value.height ||
    !metrics.every((key) => finite(value[key])) ||
    !Array.isArray(value.limitations) ||
    value.limitations.length > 16 ||
    !value.limitations.every((item) => typeof item === 'string' && item.length <= 2048)
  )
    return false;
  if (
    (value.incisedVolumeM3 as number) < 0 ||
    (value.hillslopeRedistributedVolumeM3 as number) < 0 ||
    (value.maxDrainageAreaM2 as number) <= 0 ||
    (value.durationMs as number) < 0
  )
    return false;
  let years = 0,
    previousWidth = 0,
    previousHeight = 0;
  for (const level of value.levels) {
    if (
      !record(level) ||
      !shape(level, levelKeys) ||
      !dimension(level.width) ||
      !dimension(level.height) ||
      !positive(level.spacingX) ||
      !positive(level.spacingZ) ||
      !duration(level.durationYears) ||
      !finite(level.iterations) ||
      !Number.isSafeInteger(level.iterations) ||
      level.iterations < 0 ||
      level.iterations > 64 ||
      (level.durationYears > 0 && level.iterations === 0) ||
      level.width < previousWidth ||
      level.height < previousHeight
    )
      return false;
    years += level.durationYears;
    previousWidth = level.width;
    previousHeight = level.height;
  }
  const last = value.levels[value.levels.length - 1];
  return (
    last.width === value.width &&
    last.height === value.height &&
    last.spacingX === value.spacingX &&
    last.spacingZ === value.spacingZ &&
    Math.abs(years - value.durationYears) <= 1e-10 * Math.max(1, value.durationYears)
  );
}
