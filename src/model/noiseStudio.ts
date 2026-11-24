import type { ParamDefinition, ParamValue, TerrainNode } from './types';

/** Saved Studio v3 recipes are independent of graph IDs, evaluation order and UI state. */
export const STUDIO_VERSION = 3;
export const MAX_SEED = 2147483647;
export type StudioKernel =
  | 'opensimplex2s'
  | 'opensimplex2'
  | 'perlin'
  | 'value'
  | 'value-cubic'
  | 'cellular'
  | 'gabor'
  | 'sparse'
  | 'crater'
  | 'wave'
  | 'dunes'
  | 'strata'
  | 'white'
  | 'gaussian';
export type StudioFractal =
  | 'none'
  | 'fbm'
  | 'ridged'
  | 'billow'
  | 'turbulence'
  | 'pingpong'
  | 'hybrid'
  | 'hetero'
  | 'swiss'
  | 'jordan';
export interface StudioSettings {
  kernel: StudioKernel;
  fractal: StudioFractal;
  seed: number;
  seedMode: 'linked' | 'fixed';
  seedText: string;
  seedLocked: boolean;
  lockedSeed: number;
  scaleMode: 'tile' | 'world';
  scale: number;
  featureSize: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  offsetX: number;
  offsetY: number;
  octaves: number;
  persistence: number;
  lacunarity: number;
  octaveRotation: number;
  weightedStrength: number;
  ridgeSharpness: number;
  ridgeSoftness: number;
  ridgeGain: number;
  pingPongStrength: number;
  fractalOffset: number;
  derivativeWarp: number;
  derivativeDamping: number;
  cellularMetric: 'euclidean' | 'manhattan' | 'chebyshev';
  cellularReturn: 'f1' | 'f2' | 'gap' | 'ratio' | 'cell' | 'smooth' | 'edge';
  cellularJitter: number;
  cellularSmoothness: number;
  cellularEdgeWidth: number;
  gaborFrequency: number;
  gaborBandwidth: number;
  gaborOrientation: number;
  gaborSpread: number;
  gaborDensity: number;
  spotDensity: number;
  spotRadius: number;
  spotSoftness: number;
  craterRim: number;
  waveProfile: 'sine' | 'triangle' | 'saw';
  wavePhase: number;
  waveAsymmetry: number;
  phaseNoise: number;
  warpType: 'none' | 'independent' | 'progressive' | 'curl';
  warpKernel: 'opensimplex2s' | 'perlin' | 'value';
  warpAmplitude: number;
  warpFrequency: number;
  warpOctaves: number;
  warpPersistence: number;
  warpLacunarity: number;
  warpSeed: number;
  warpSeedMode: 'derived' | 'fixed';
  blackPoint: number;
  whitePoint: number;
  gamma: number;
  contrast: number;
  bias: number;
  invert: boolean;
  curve: string;
  amplitude: number;
  offset: number;
  clampOutput: boolean;
  tiling: 'off' | 'blend';
  sampling: 'filtered' | 'supersample2' | 'supersample4' | 'point';
}

const select = (
  key: keyof StudioSettings,
  label: string,
  value: string,
  entries: readonly (readonly [string, string])[],
  section: string,
  description?: string,
): ParamDefinition => ({
  key,
  label,
  type: 'select',
  default: value,
  options: entries.map(([value, label]) => ({ value, label })),
  section,
  description,
});
const range = (
  key: keyof StudioSettings,
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  section: string,
  description: string,
  unit?: string,
): ParamDefinition => ({
  key,
  label,
  type: 'range',
  default: value,
  min,
  max,
  step,
  section,
  description,
  unit,
});
const toggle = (
  key: keyof StudioSettings,
  label: string,
  value: boolean,
  section: string,
  description: string,
): ParamDefinition => ({ key, label, type: 'toggle', default: value, section, description });

export const STUDIO_KERNELS = [
  ['opensimplex2s', 'OpenSimplex2S'],
  ['opensimplex2', 'OpenSimplex2'],
  ['perlin', 'Perlin'],
  ['value', 'Value'],
  ['value-cubic', 'Cubic value'],
  ['cellular', 'Worley / cellular'],
  ['gabor', 'Gabor'],
  ['sparse', 'Sparse spots'],
  ['crater', 'Craters'],
  ['wave', 'Wave'],
  ['dunes', 'Dunes'],
  ['strata', 'Folded strata'],
  ['white', 'White noise'],
  ['gaussian', 'Gaussian noise'],
] as const;
export const STUDIO_FRACTALS = [
  ['none', 'Single layer'],
  ['fbm', 'Fractal Brownian'],
  ['ridged', 'Ridged multifractal'],
  ['billow', 'Billow'],
  ['turbulence', 'Turbulence'],
  ['pingpong', 'Ping-pong'],
  ['hybrid', 'Hybrid multifractal'],
  ['hetero', 'Heterogeneous terrain'],
  ['swiss', 'Swiss turbulence'],
  ['jordan', 'Jordan turbulence'],
] as const;

export const STUDIO_PARAMS: ParamDefinition[] = [
  select(
    'kernel',
    'Base noise',
    'opensimplex2s',
    STUDIO_KERNELS,
    'Generator',
    'The spatial pattern before layers, distortion and output shaping.',
  ),
  select(
    'fractal',
    'Fractal structure',
    'ridged',
    STUDIO_FRACTALS,
    'Generator',
    'How progressively smaller layers interact.',
  ),
  select(
    'seedMode',
    'Seed mode',
    'linked',
    [
      ['linked', 'Follow world seed'],
      ['fixed', 'Independent of world seed'],
    ],
    'Randomness',
  ),
  {
    key: 'seed',
    label: 'Node seed',
    type: 'number',
    default: 0,
    min: 0,
    max: MAX_SEED,
    step: 1,
    section: 'Randomness',
  },
  {
    key: 'seedText',
    label: 'Seed name',
    type: 'text',
    default: '',
    section: 'Randomness',
    description:
      'An optional, case-sensitive name mixed with the numeric seed. Identical seed inputs share a random stream.',
  },
  toggle(
    'seedLocked',
    'Lock seed',
    false,
    'Randomness',
    'Freeze this resolved seed, including when the world seed changes. Unlock to resume the selected seed mode.',
  ),
  {
    key: 'lockedSeed',
    label: 'Locked seed',
    type: 'number',
    default: 0,
    min: 0,
    max: 4294967295,
    step: 1,
    section: 'Randomness',
  },
  select(
    'scaleMode',
    'Scale units',
    'tile',
    [
      ['tile', 'Features across tile'],
      ['world', 'Feature size in meters'],
    ],
    'Coordinates',
  ),
  range(
    'scale',
    'Frequency',
    3.4,
    0.25,
    64,
    0.05,
    'Coordinates',
    'Approximate number of base lattice intervals across the terrain.',
  ),
  range(
    'featureSize',
    'Feature size',
    1000,
    1,
    100000,
    1,
    'Coordinates',
    'Base lattice spacing in world meters. Resizing the tile reveals more or fewer features.',
    'm',
  ),
  range(
    'scaleX',
    'X frequency',
    1,
    0.125,
    8,
    0.025,
    'Coordinates',
    'Independent horizontal frequency multiplier.',
    '×',
  ),
  range(
    'scaleY',
    'Y frequency',
    1,
    0.125,
    8,
    0.025,
    'Coordinates',
    'Independent vertical frequency multiplier.',
    '×',
  ),
  range(
    'rotation',
    'Rotation',
    0,
    -180,
    180,
    1,
    'Coordinates',
    'Rotate the field about the center of the tile.',
    '°',
  ),
  range(
    'offsetX',
    'X offset',
    0,
    -100,
    100,
    0.01,
    'Coordinates',
    'Translate in base noise coordinates, independent of output resolution.',
  ),
  range(
    'offsetY',
    'Y offset',
    0,
    -100,
    100,
    0.01,
    'Coordinates',
    'Translate in base noise coordinates, independent of output resolution.',
  ),
  range(
    'octaves',
    'Octaves',
    6,
    1,
    12,
    0.1,
    'Fractal',
    'Fractional values smoothly blend the last layer.',
  ),
  range(
    'persistence',
    'Persistence',
    0.5,
    0,
    1,
    0.01,
    'Fractal',
    'Amplitude retained by each smaller layer.',
  ),
  range(
    'lacunarity',
    'Lacunarity',
    2.05,
    1,
    4,
    0.05,
    'Fractal',
    'Frequency multiplier between layers.',
  ),
  range(
    'octaveRotation',
    'Octave rotation',
    36.87,
    -180,
    180,
    0.1,
    'Fractal',
    'Rotate successive layers to control directionality.',
    '°',
  ),
  range(
    'weightedStrength',
    'Detail weighting',
    0,
    0,
    1,
    0.01,
    'Fractal',
    'Suppress fine detail according to the preceding layer.',
  ),
  range(
    'ridgeSharpness',
    'Ridge sharpness',
    2,
    0.5,
    6,
    0.05,
    'Fractal',
    'Concentrate folded values into narrower crests.',
  ),
  range(
    'ridgeSoftness',
    'Crest rounding',
    0.05,
    0,
    0.5,
    0.01,
    'Fractal',
    'Round the absolute-value cusp before shaping ridges.',
  ),
  range(
    'ridgeGain',
    'Ridge feedback',
    2,
    0,
    4,
    0.05,
    'Fractal',
    'Control how ridges gate detail in the next layer.',
  ),
  range(
    'pingPongStrength',
    'Ping-pong folds',
    2,
    0.5,
    6,
    0.05,
    'Fractal',
    'Number of repeated folds through the noise range.',
  ),
  range(
    'fractalOffset',
    'Terrain offset',
    0.7,
    0.1,
    2,
    0.025,
    'Fractal',
    'Shift the source used by hybrid and heterogeneous terrain.',
  ),
  range(
    'derivativeWarp',
    'Derivative distortion',
    0.25,
    0,
    1,
    0.01,
    'Fractal',
    'Bend later octaves using preceding noise gradients.',
  ),
  range(
    'derivativeDamping',
    'Detail damping',
    0.8,
    0,
    2,
    0.025,
    'Fractal',
    'Jordan turbulence suppresses more fine detail in flat regions and retains it on steep slopes.',
  ),
  select(
    'cellularMetric',
    'Distance metric',
    'euclidean',
    [
      ['euclidean', 'Euclidean'],
      ['manhattan', 'Manhattan'],
      ['chebyshev', 'Chebyshev'],
    ],
    'Cellular',
  ),
  select(
    'cellularReturn',
    'Cell output',
    'f1',
    [
      ['f1', 'Nearest distance · F1'],
      ['f2', 'Second distance · F2'],
      ['gap', 'Distance gap · F2 − F1'],
      ['ratio', 'Distance ratio · F1 / F2'],
      ['cell', 'Cell value'],
      ['smooth', 'Smooth F1'],
      ['edge', 'Distance to edge'],
    ],
    'Cellular',
  ),
  range(
    'cellularJitter',
    'Cell randomness',
    1,
    0,
    1,
    0.01,
    'Cellular',
    'Zero gives a regular lattice; one places sites throughout each cell.',
  ),
  range(
    'cellularSmoothness',
    'Cell blending',
    0.25,
    0.01,
    1,
    0.01,
    'Cellular',
    'Width of the smooth minimum between neighboring sites.',
  ),
  range(
    'cellularEdgeWidth',
    'Edge width',
    0.15,
    0.01,
    0.75,
    0.01,
    'Cellular',
    'Thickness of the cell border in base noise coordinates.',
  ),
  range(
    'gaborFrequency',
    'Carrier frequency',
    2,
    0.25,
    8,
    0.05,
    'Gabor',
    'Oscillations inside each localized kernel.',
  ),
  range(
    'gaborBandwidth',
    'Kernel bandwidth',
    1,
    0.25,
    2,
    0.025,
    'Gabor',
    'Spatial concentration of each Gaussian envelope.',
  ),
  range(
    'gaborOrientation',
    'Orientation',
    0,
    -180,
    180,
    1,
    'Gabor',
    'Mean direction of the carrier waves.',
    '°',
  ),
  range(
    'gaborSpread',
    'Orientation spread',
    15,
    0,
    180,
    1,
    'Gabor',
    'Random angular spread about the chosen direction.',
    '°',
  ),
  range(
    'gaborDensity',
    'Impulse density',
    4,
    1,
    8,
    1,
    'Gabor',
    'Number of deterministic impulses per lattice cell.',
  ),
  range(
    'spotDensity',
    'Feature density',
    0.7,
    0.05,
    1,
    0.01,
    'Features',
    'Fraction of lattice cells containing a localized feature.',
  ),
  range(
    'spotRadius',
    'Feature radius',
    0.45,
    0.05,
    0.95,
    0.01,
    'Features',
    'Radius in base lattice units.',
  ),
  range(
    'spotSoftness',
    'Feature softness',
    0.5,
    0.05,
    1,
    0.01,
    'Features',
    'Profile softness of each spot or crater.',
  ),
  range(
    'craterRim',
    'Crater rim width',
    0.15,
    0.03,
    0.4,
    0.01,
    'Features',
    'Width of the raised ring around each crater.',
  ),
  select(
    'waveProfile',
    'Wave profile',
    'sine',
    [
      ['sine', 'Sine'],
      ['triangle', 'Triangle'],
      ['saw', 'Sawtooth'],
    ],
    'Pattern',
  ),
  range(
    'wavePhase',
    'Phase',
    0,
    0,
    1,
    0.005,
    'Pattern',
    'Move the pattern through one complete cycle.',
  ),
  range(
    'waveAsymmetry',
    'Slope asymmetry',
    0.7,
    0.05,
    0.95,
    0.01,
    'Pattern',
    'Position of the crest within the period; controls windward and leeward slopes.',
  ),
  range(
    'phaseNoise',
    'Pattern irregularity',
    0.35,
    0,
    2,
    0.01,
    'Pattern',
    'Seeded variation of the wave phase or stratum folds.',
  ),
  select(
    'warpType',
    'Domain distortion',
    'none',
    [
      ['none', 'None'],
      ['independent', 'Independent fractal'],
      ['progressive', 'Progressive fractal'],
      ['curl', 'Curl field'],
    ],
    'Distortion',
  ),
  select(
    'warpKernel',
    'Warp noise',
    'opensimplex2s',
    [
      ['opensimplex2s', 'OpenSimplex2S'],
      ['perlin', 'Perlin'],
      ['value', 'Value'],
    ],
    'Distortion',
  ),
  range(
    'warpAmplitude',
    'Warp amplitude',
    0.5,
    0,
    2,
    0.01,
    'Distortion',
    'Displacement in base noise coordinates. Zero disables warping exactly.',
  ),
  range(
    'warpFrequency',
    'Warp frequency',
    0.7,
    0.1,
    8,
    0.025,
    'Distortion',
    'Frequency relative to the base field.',
  ),
  range(
    'warpOctaves',
    'Warp octaves',
    3,
    1,
    6,
    1,
    'Distortion',
    'Number of progressively smaller displacement layers.',
  ),
  range(
    'warpPersistence',
    'Warp persistence',
    0.5,
    0,
    1,
    0.01,
    'Distortion',
    'Amplitude retained by successive warp layers.',
  ),
  range(
    'warpLacunarity',
    'Warp lacunarity',
    2,
    1,
    4,
    0.05,
    'Distortion',
    'Warp frequency multiplier between layers.',
  ),
  select(
    'warpSeedMode',
    'Warp seed mode',
    'derived',
    [
      ['derived', 'Derive from node seed'],
      ['fixed', 'Independent warp seed'],
    ],
    'Distortion',
  ),
  {
    key: 'warpSeed',
    label: 'Warp seed / offset',
    type: 'number',
    default: 0,
    min: 0,
    max: MAX_SEED,
    step: 1,
    section: 'Distortion',
    description: 'A stream offset when derived from the node; an independent seed when fixed.',
  },
  range(
    'blackPoint',
    'Black point',
    0,
    0,
    0.99,
    0.01,
    'Output',
    'Input value mapped to zero. Keep at least 0.01 below white point.',
  ),
  range(
    'whitePoint',
    'White point',
    1,
    0.01,
    1,
    0.01,
    'Output',
    'Input value mapped to one. Keep at least 0.01 above black point.',
  ),
  range(
    'gamma',
    'Gamma',
    1,
    0.1,
    5,
    0.025,
    'Output',
    'Lift or lower the midtones before the custom curve.',
  ),
  range(
    'contrast',
    'Contrast',
    1,
    0,
    4,
    0.025,
    'Output',
    'Expand or compress values around the midpoint.',
  ),
  range('bias', 'Bias', 0, -0.5, 0.5, 0.005, 'Output', 'Shift values before the curve.'),
  toggle('invert', 'Invert field', false, 'Output', 'Exchange low and high values.'),
  { key: 'curve', label: 'Remap curve', type: 'text', default: '[[0,0],[1,1]]', section: 'Output' },
  range(
    'amplitude',
    'Amplitude',
    0.75,
    0,
    1.5,
    0.01,
    'Output',
    'Vertical contribution relative to project elevation scale.',
  ),
  range(
    'offset',
    'Elevation offset',
    0.1,
    -0.5,
    0.75,
    0.01,
    'Output',
    'Shift the generated terrain vertically.',
  ),
  toggle(
    'clampOutput',
    'Clamp shaped field',
    true,
    'Output',
    'Limit shaped values to 0–1 before amplitude and elevation offset.',
  ),
  select(
    'tiling',
    'Seamless tile',
    'off',
    [
      ['off', 'Off'],
      ['blend', 'Seamless blend'],
    ],
    'Sampling',
    'Blend four translated evaluations with smooth weights. Matches opposite borders and, for smooth sources, slopes. Changes the interior distribution; downstream erosion is not periodic.',
  ),
  select(
    'sampling',
    'Sampling quality',
    'filtered',
    [
      ['filtered', 'Filtered'],
      ['supersample2', 'Filtered + 4 samples'],
      ['supersample4', 'Filtered + 16 samples'],
      ['point', 'Unfiltered reference'],
    ],
    'Sampling',
    'Extra samples reduce subpixel edges and nonlinear detail at additional CPU cost.',
  ),
];

export const STUDIO_DEFAULTS = Object.fromEntries(
  STUDIO_PARAMS.map((p) => [p.key, p.default]),
) as unknown as StudioSettings;
export type CurvePoint = { x: number; y: number };
export function parseStudioCurve(value: unknown): CurvePoint[] {
  if (typeof value !== 'string' || value.length > 2000)
    throw new Error('Invalid noise remap curve.');
  const points: unknown = JSON.parse(value);
  if (!Array.isArray(points) || points.length < 2 || points.length > 16)
    throw new Error('A noise curve needs 2–16 points.');
  const clean = points.map((p: unknown) => {
    if (
      !Array.isArray(p) ||
      p.length !== 2 ||
      !p.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)
    )
      throw new Error('Noise curve coordinates must be between zero and one.');
    return { x: p[0] as number, y: p[1] as number };
  });
  if (
    clean[0].x !== 0 ||
    clean.at(-1)!.x !== 1 ||
    clean.some((p, i) => i > 0 && p.x - clean[i - 1].x < 0.001 - 1e-10)
  )
    throw new Error('Noise curve points must increase from x = 0 to x = 1.');
  return clean;
}

/** UI, project loading, recipes and engine use the same limits. */
export function resolveStudioSettings(params: Record<string, ParamValue>): StudioSettings {
  const clean: Record<string, ParamValue> = {};
  for (const d of STUDIO_PARAMS) {
    const v = params[d.key];
    if (d.type === 'range' || d.type === 'number') {
      const n = typeof v === 'number' && Number.isFinite(v) ? v : Number(d.default);
      clean[d.key] = Math.max(d.min!, Math.min(d.max!, n));
    } else if (d.type === 'select')
      clean[d.key] = d.options!.some((o) => o.value === v) ? v : d.default;
    else if (d.type === 'toggle') clean[d.key] = typeof v === 'boolean' ? v : d.default;
    else clean[d.key] = typeof v === 'string' ? v : d.default;
  }
  for (const key of ['seed', 'lockedSeed', 'warpSeed', 'warpOctaves', 'gaborDensity'])
    clean[key] = Math.round(Number(clean[key]));
  clean.seedText = String(clean.seedText).slice(0, 128);
  try {
    parseStudioCurve(clean.curve);
  } catch {
    clean.curve = STUDIO_DEFAULTS.curve;
  }
  if (Number(clean.whitePoint) - Number(clean.blackPoint) < 0.01 - 1e-10)
    clean.whitePoint = Number(clean.blackPoint) + 0.01;
  return clean as unknown as StudioSettings;
}

/** FNV-1a over UTF-16 code units; deriveSeed applies the final avalanche. */
export function hashSeedText(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return h >>> 0;
}
export function deriveSeed(seed: number, stream: number, offset = 0): number {
  let h =
    (seed >>> 0) ^ Math.imul((stream | 0) + 1, 0x9e3779b9) ^ Math.imul(offset | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}
export function resolveNoiseSeed(
  params: Record<string, ParamValue> | StudioSettings,
  projectSeed: number,
): number {
  if (params.seedLocked === true) return Number(params.lockedSeed ?? 0) >>> 0;
  const local = Number(params.seed ?? 0) >>> 0;
  const root = params.seedMode === 'fixed' ? 0 : projectSeed >>> 0;
  const name = String(params.seedText ?? '');
  return deriveSeed(root, local, name ? hashSeedText(name) : 0);
}

export function studioParamVisible(params: Record<string, ParamValue>, key: string): boolean {
  const s = resolveStudioSettings(params);
  if (['lockedSeed', 'curve', 'seedText', 'seedLocked'].includes(key)) return false; // custom editors
  if (key === 'scale') return s.scaleMode === 'tile';
  if (key === 'featureSize') return s.scaleMode === 'world';
  if (key.startsWith('cellular'))
    return (
      s.kernel === 'cellular' &&
      (key !== 'cellularMetric' || s.cellularReturn !== 'edge') &&
      (key !== 'cellularSmoothness' || s.cellularReturn === 'smooth') &&
      (key !== 'cellularEdgeWidth' || s.cellularReturn === 'edge')
    );
  if (key.startsWith('gabor')) return s.kernel === 'gabor';
  if (key.startsWith('spot')) return ['sparse', 'crater'].includes(s.kernel);
  if (key === 'craterRim') return s.kernel === 'crater';
  if (['waveProfile', 'wavePhase', 'waveAsymmetry', 'phaseNoise'].includes(key))
    return (
      ['wave', 'dunes', 'strata'].includes(s.kernel) &&
      (key !== 'waveProfile' || s.kernel === 'wave') &&
      (key !== 'waveAsymmetry' ||
        s.kernel === 'dunes' ||
        (s.kernel === 'wave' && s.waveProfile === 'triangle'))
    );
  if (key.startsWith('warp') && key !== 'warpType') return s.warpType !== 'none';
  if (['octaves', 'persistence', 'lacunarity', 'octaveRotation', 'weightedStrength'].includes(key))
    return s.fractal !== 'none';
  if (key.startsWith('ridge')) return s.fractal === 'ridged';
  if (key === 'pingPongStrength') return s.fractal === 'pingpong';
  if (key === 'fractalOffset') return ['hybrid', 'hetero'].includes(s.fractal);
  if (key.startsWith('derivative'))
    return (
      ['swiss', 'jordan'].includes(s.fractal) &&
      studioHasDerivativeGuidance(s) &&
      (key !== 'derivativeDamping' || s.fractal === 'jordan')
    );
  return true;
}

export function studioHasDerivativeGuidance(s: StudioSettings): boolean {
  return (
    !['white', 'gaussian'].includes(s.kernel) &&
    !(s.kernel === 'cellular' && s.cellularReturn === 'cell') &&
    !(s.kernel === 'wave' && s.waveProfile === 'saw')
  );
}

export interface NoisePreset {
  id: string;
  name: string;
  category: string;
  description: string;
  params: Partial<StudioSettings>;
}
export const NOISE_PRESETS: NoisePreset[] = [
  {
    id: 'alpine-ridges',
    name: 'Alpine ridges',
    category: 'Terrain',
    description: 'Rounded crests with fine, gated detail.',
    params: {
      kernel: 'opensimplex2s',
      fractal: 'ridged',
      ridgeSoftness: 0.12,
      ridgeSharpness: 2.3,
      persistence: 0.48,
      scale: 4.2,
    },
  },
  {
    id: 'rolling-highlands',
    name: 'Rolling highlands',
    category: 'Terrain',
    description: 'Broad, soft terrain with elevation-dependent texture.',
    params: {
      kernel: 'opensimplex2s',
      fractal: 'hybrid',
      scale: 3.2,
      persistence: 0.42,
      warpType: 'independent',
      warpAmplitude: 0.2,
    },
  },
  {
    id: 'swiss-range',
    name: 'Swiss range',
    category: 'Terrain',
    description: 'Derivative-guided ridges and warped valleys.',
    params: {
      kernel: 'perlin',
      fractal: 'swiss',
      scale: 4,
      derivativeWarp: 0.2,
      persistence: 0.52,
    },
  },
  {
    id: 'weathered-rock',
    name: 'Weathered rock',
    category: 'Terrain',
    description: 'Jordan turbulence with slope-damped detail.',
    params: {
      kernel: 'perlin',
      fractal: 'jordan',
      scale: 5,
      derivativeWarp: 0.25,
      derivativeDamping: 0.8,
      gamma: 2.2,
      whitePoint: 0.5,
    },
  },
  {
    id: 'billowing-hills',
    name: 'Billowing hills',
    category: 'Terrain',
    description: 'Layered rounded masses with gentle distortion.',
    params: {
      kernel: 'value-cubic',
      fractal: 'billow',
      gamma: 1.5,
      whitePoint: 0.45,
      scale: 5,
      warpType: 'progressive',
      warpAmplitude: 0.35,
    },
  },
  {
    id: 'fractured-plates',
    name: 'Fractured plates',
    category: 'Cellular',
    description: 'Euclidean cell borders, suitable for a fracture mask.',
    params: {
      kernel: 'cellular',
      fractal: 'none',
      cellularReturn: 'edge',
      cellularEdgeWidth: 0.09,
      scale: 12,
      invert: true,
    },
  },
  {
    id: 'cellular-mesas',
    name: 'Cellular mesas',
    category: 'Cellular',
    description: 'Blended cellular masses with a flat-topped remap.',
    params: {
      kernel: 'cellular',
      fractal: 'none',
      cellularReturn: 'smooth',
      cellularSmoothness: 0.3,
      scale: 7,
      invert: true,
      curve: '[[0,0],[0.3,0.05],[0.6,0.85],[1,1]]',
    },
  },
  {
    id: 'mineral-blocks',
    name: 'Mineral blocks',
    category: 'Cellular',
    description: 'Angular Manhattan cells with controllable jitter.',
    params: {
      kernel: 'cellular',
      fractal: 'none',
      cellularMetric: 'manhattan',
      cellularReturn: 'f1',
      cellularJitter: 0.8,
      scale: 12,
    },
  },
  {
    id: 'cell-ids',
    name: 'Cell values',
    category: 'Cellular',
    description: 'A reproducible value per nearest cell for masks.',
    params: { kernel: 'cellular', fractal: 'none', cellularReturn: 'cell', scale: 10 },
  },
  {
    id: 'wind-dunes',
    name: 'Wind dunes',
    category: 'Directional',
    description: 'Asymmetric windward slopes and meandering crests.',
    params: {
      kernel: 'dunes',
      fractal: 'none',
      scale: 10,
      scaleY: 0.45,
      rotation: -20,
      waveAsymmetry: 0.78,
      phaseNoise: 0.6,
    },
  },
  {
    id: 'fold-belt',
    name: 'Fold belt',
    category: 'Directional',
    description: 'Progressively distorted strata with long coherent bands.',
    params: {
      kernel: 'strata',
      fractal: 'none',
      scale: 9,
      scaleY: 0.6,
      warpType: 'progressive',
      warpAmplitude: 0.65,
      warpFrequency: 0.25,
      phaseNoise: 0.4,
    },
  },
  {
    id: 'gabor-ripples',
    name: 'Gabor ripples',
    category: 'Directional',
    description: 'Localized oriented waves for fine surface relief.',
    params: {
      kernel: 'gabor',
      fractal: 'none',
      scale: 8,
      gaborFrequency: 3,
      gaborOrientation: 25,
      gaborSpread: 10,
      gaborDensity: 4,
    },
  },
  {
    id: 'gabor-grain',
    name: 'Gabor grain',
    category: 'Surface',
    description: 'Broad orientation spread for irregular surface grain.',
    params: {
      kernel: 'gabor',
      fractal: 'none',
      scale: 12,
      gaborFrequency: 2.4,
      gaborSpread: 180,
      gaborDensity: 6,
    },
  },
  {
    id: 'scattered-knolls',
    name: 'Scattered knolls',
    category: 'Features',
    description: 'Localized soft hills with controlled density and radius.',
    params: { kernel: 'sparse', fractal: 'none', scale: 12, spotDensity: 0.6, spotRadius: 0.6 },
  },
  {
    id: 'impact-field',
    name: 'Impact field',
    category: 'Features',
    description: 'Seeded depressions and raised rims.',
    params: {
      kernel: 'crater',
      fractal: 'none',
      scale: 10,
      spotDensity: 0.45,
      spotRadius: 0.65,
      craterRim: 0.14,
    },
  },
  {
    id: 'folded-clouds',
    name: 'Folded clouds',
    category: 'Surface',
    description: 'Repeated noise folds with a strong progressive warp.',
    params: {
      kernel: 'opensimplex2s',
      fractal: 'pingpong',
      scale: 4,
      pingPongStrength: 2.2,
      warpType: 'progressive',
      warpAmplitude: 0.6,
    },
  },
  {
    id: 'heterogeneous-land',
    name: 'Heterogeneous land',
    category: 'Terrain',
    description: 'Detail grows with the accumulated terrain height.',
    params: {
      kernel: 'opensimplex2',
      fractal: 'hetero',
      scale: 3.5,
      fractalOffset: 0.65,
      persistence: 0.5,
    },
  },
  {
    id: 'fine-grain',
    name: 'Fine grain',
    category: 'Surface',
    description: 'Seeded Gaussian lattice grain; supersampling softens edges.',
    params: {
      kernel: 'gaussian',
      fractal: 'none',
      scale: 64,
      sampling: 'supersample2',
      amplitude: 0.15,
      offset: 0.4,
    },
  },
];

/** Presets reset artistic controls, preserving deliberate seed choices. */
export function applyNoisePreset(
  params: Record<string, ParamValue>,
  preset: NoisePreset,
): Record<string, ParamValue> {
  const keep = resolveStudioSettings(params);
  return {
    ...params,
    ...STUDIO_DEFAULTS,
    ...preset.params,
    noiseModel: 'v3',
    seed: keep.seed,
    seedMode: keep.seedMode,
    seedText: keep.seedText,
    seedLocked: keep.seedLocked,
    lockedSeed: keep.lockedSeed,
    warpSeed: keep.warpSeed,
    warpSeedMode: keep.warpSeedMode,
  } as Record<string, ParamValue>;
}
export function upgradeNoiseParams(params: Record<string, ParamValue>): Record<string, ParamValue> {
  const mode = String(params.mode ?? 'ridged');
  const kernel: StudioKernel =
    mode === 'perlin'
      ? 'perlin'
      : mode === 'simplex'
        ? 'opensimplex2'
        : ['voronoi', 'voronoi-edge', 'cellular'].includes(mode)
          ? 'cellular'
          : mode === 'wave'
            ? 'wave'
            : 'perlin';
  const fractal: StudioFractal = [
    'perlin',
    'simplex',
    'voronoi',
    'voronoi-edge',
    'cellular',
    'wave',
  ].includes(mode)
    ? 'none'
    : ['ridged', 'billow', 'turbulence'].includes(mode)
      ? (mode as StudioFractal)
      : 'fbm';
  return {
    ...params,
    ...STUDIO_DEFAULTS,
    noiseModel: 'v3',
    kernel,
    fractal,
    ...Object.fromEntries(
      ['scale', 'amplitude', 'offset', 'octaves', 'persistence', 'lacunarity', 'rotation', 'seed']
        .filter((k) => params[k] !== undefined)
        .map((k) => [k, params[k]]),
    ),
    scaleX: 1 / Number(params.stretch ?? 1),
    scaleY: Number(params.stretch ?? 1),
    cellularReturn: mode === 'voronoi-edge' ? 'gap' : mode === 'cellular' ? 'cell' : 'f1',
    warpType: ['warped', 'naki'].includes(mode) ? 'independent' : 'none',
    warpAmplitude: Number(params.warp ?? 0.6),
  };
}

export function encodeNoiseRecipe(params: Record<string, ParamValue>): string {
  return JSON.stringify(
    {
      format: 'normal-height-noise',
      version: 1,
      engine: STUDIO_VERSION,
      params: resolveStudioSettings(params),
    },
    null,
    2,
  );
}
export function decodeNoiseRecipe(value: string): Record<string, ParamValue> {
  if (value.length > 20000) throw new Error('This noise recipe is too large.');
  const parsed = JSON.parse(value);
  if (
    parsed?.format !== 'normal-height-noise' ||
    parsed.version !== 1 ||
    parsed.engine !== STUDIO_VERSION ||
    !parsed.params ||
    typeof parsed.params !== 'object' ||
    Array.isArray(parsed.params)
  )
    throw new Error('Choose a Normal Height Studio v3 noise recipe.');
  validateStudioParams(parsed.params);
  return { ...resolveStudioSettings(parsed.params), noiseModel: 'v3' } as Record<
    string,
    ParamValue
  >;
}
export function validateStudioParams(params: Record<string, unknown>): void {
  for (const d of STUDIO_PARAMS) {
    const v = params[d.key];
    if (v === undefined) continue;
    if (d.type === 'range' || d.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < d.min! || v > d.max!)
        throw new Error(`Invalid ${d.label} in noise settings.`);
    } else if (d.type === 'select' && !d.options!.some((o) => o.value === v))
      throw new Error(`Unknown ${d.label} in noise settings.`);
    else if (d.type === 'toggle' && typeof v !== 'boolean')
      throw new Error(`Invalid ${d.label} in noise settings.`);
    else if (d.type === 'text' && typeof v !== 'string')
      throw new Error(`Invalid ${d.label} in noise settings.`);
  }
  for (const key of ['seed', 'lockedSeed', 'warpSeed', 'warpOctaves', 'gaborDensity'])
    if (params[key] !== undefined && !Number.isInteger(params[key]))
      throw new Error(`Noise ${key} must be an integer.`);
  if (typeof params.seedText === 'string' && params.seedText.length > 128)
    throw new Error('Seed names may contain up to 128 characters.');
  if (params.curve !== undefined) parseStudioCurve(params.curve);
  if (Number(params.whitePoint ?? 1) - Number(params.blackPoint ?? 0) < 0.01 - 1e-10)
    throw new Error('Noise black and white points must be at least 0.01 apart.');
  if (params.seedLocked === true && params.lockedSeed === undefined)
    throw new Error('A locked noise seed must include its resolved value.');
}
export function isStudioNoise(node: TerrainNode): boolean {
  return node.kind === 'noise' && node.params.noiseModel === 'v3';
}
