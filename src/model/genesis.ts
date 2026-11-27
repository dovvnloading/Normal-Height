/** Saved, opt-in geological evolution settings. Version changes are explicit. */
export const GENESIS_ALGORITHM_VERSION = 'world-genesis-1' as const;

export interface GenesisSettings {
  version: 1;
  enabled: boolean;
  /** Total model time, shared across refinement levels, in years. */
  durationYears: number;
  /** Peak tectonic uplift over the entire run, in metres. */
  upliftMeters: number;
  upliftAngleDegrees: number;
  upliftWidthMeters: number;
  /** Stream-power K, in 1/year for the fixed m=1/2, n=1 exponents. */
  erosionRate: number;
  /** Dimensionless relative rainfall. Zero disables fluvial incision. */
  rainfall: number;
  rockHardness: number;
  hardnessContrast: number;
  strataThicknessMeters: number;
  strataDipDegrees: number;
  strataStrikeDegrees: number;
  foldAmplitudeMeters: number;
  foldWavelengthMeters: number;
  faultThrowMeters: number;
  faultAngleDegrees: number;
  /** Hillslope diffusion coefficient in m²/year. */
  hillslopeRate: number;
  /** Iterations per refinement level; total duration is independent of this. */
  iterations: number;
}

export const DEFAULT_GENESIS: Readonly<GenesisSettings> = Object.freeze({
  version: 1,
  enabled: false,
  durationYears: 120000,
  upliftMeters: 420,
  upliftAngleDegrees: 32,
  upliftWidthMeters: 1500,
  erosionRate: 0.000018,
  rainfall: 1,
  rockHardness: 0.58,
  hardnessContrast: 0.65,
  strataThicknessMeters: 90,
  strataDipDegrees: 12,
  strataStrikeDegrees: 32,
  foldAmplitudeMeters: 85,
  foldWavelengthMeters: 1700,
  faultThrowMeters: 40,
  faultAngleDegrees: 64,
  hillslopeRate: 0.035,
  iterations: 12,
});

/** Competence is an artistic ordering, not measured lithological data. */
export const GENESIS_LITHOLOGIES = Object.freeze([
  { id: 0, label: 'Mudstone', color: '#7e7160', competence: 0.15 },
  { id: 1, label: 'Siltstone', color: '#9b8265', competence: 0.35 },
  { id: 2, label: 'Sandstone', color: '#c69e69', competence: 0.65 },
  { id: 3, label: 'Limestone', color: '#c6c4ad', competence: 0.9 },
] as const);

export interface GenesisPreset {
  id: string;
  label: string;
  description: string;
  settings: GenesisSettings;
}

export const GENESIS_PRESETS: readonly GenesisPreset[] = [
  {
    id: 'alpine-uplift',
    label: 'Alpine uplift',
    description: 'Folded resistant beds, a broad uplift belt and branching incision.',
    settings: { ...DEFAULT_GENESIS, enabled: true },
  },
  {
    id: 'layered-badlands',
    label: 'Layered badlands',
    description: 'Thin, gently dipping beds with strong competence contrasts and fine drainage.',
    settings: {
      ...DEFAULT_GENESIS,
      enabled: true,
      durationYears: 80000,
      upliftMeters: 90,
      upliftWidthMeters: 3000,
      erosionRate: 0.000032,
      rockHardness: 0.32,
      hardnessContrast: 0.85,
      strataThicknessMeters: 24,
      strataDipDegrees: 4,
      foldAmplitudeMeters: 12,
      foldWavelengthMeters: 2200,
      faultThrowMeters: 0,
      hillslopeRate: 0.012,
    },
  },
  {
    id: 'tectonic-plateau',
    label: 'Tectonic plateau',
    description: 'A broad uplifted surface, displaced beds and deeply incised trunk channels.',
    settings: {
      ...DEFAULT_GENESIS,
      enabled: true,
      durationYears: 220000,
      upliftMeters: 650,
      upliftWidthMeters: 5000,
      erosionRate: 0.000014,
      rockHardness: 0.72,
      hardnessContrast: 0.8,
      strataThicknessMeters: 130,
      strataDipDegrees: 3,
      foldAmplitudeMeters: 30,
      foldWavelengthMeters: 3500,
      faultThrowMeters: 180,
      hillslopeRate: 0.018,
    },
  },
];

export const GENESIS_SETTING_RANGES = Object.freeze({
  durationYears: [0, 2000000],
  upliftMeters: [0, 10000],
  upliftAngleDegrees: [-180, 180],
  upliftWidthMeters: [1, 1000000000],
  erosionRate: [0, 0.01],
  rainfall: [0, 10],
  rockHardness: [0, 1],
  hardnessContrast: [0, 1],
  strataThicknessMeters: [1, 100000],
  strataDipDegrees: [-80, 80],
  strataStrikeDegrees: [-180, 180],
  foldAmplitudeMeters: [0, 10000],
  foldWavelengthMeters: [1, 1000000000],
  faultThrowMeters: [-10000, 10000],
  faultAngleDegrees: [-180, 180],
  hillslopeRate: [0, 100],
  iterations: [1, 64],
} as const);

export function validateGenesisSettings(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'Genesis settings must be an object.';
  const settings = value as GenesisSettings;
  if (settings.version !== 1) return 'This Genesis algorithm version is not supported.';
  if (typeof settings.enabled !== 'boolean') return 'Genesis enabled must be a boolean.';
  for (const [key, [min, max]] of Object.entries(GENESIS_SETTING_RANGES)) {
    const number = settings[key as keyof typeof GENESIS_SETTING_RANGES];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max)
      return `Genesis ${key} must be between ${min} and ${max}.`;
  }
  if (!Number.isSafeInteger(settings.iterations)) return 'Genesis iterations must be an integer.';
  return null;
}

export function normalizeGenesisSettings(value: unknown): GenesisSettings {
  if (value === undefined || value === null) return { ...DEFAULT_GENESIS };
  const error = validateGenesisSettings(value);
  if (error) throw new Error(error);
  const settings = value as GenesisSettings;
  const result: GenesisSettings = { ...DEFAULT_GENESIS, enabled: settings.enabled };
  for (const key of Object.keys(GENESIS_SETTING_RANGES) as (keyof typeof GENESIS_SETTING_RANGES)[])
    result[key] = settings[key];
  return result;
}
