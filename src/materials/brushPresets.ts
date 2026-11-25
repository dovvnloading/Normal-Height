import type { MaterialStroke } from './materialPaint';
import { parseMaterialPaint } from './materialPaint';
import type { BrushSettings } from '../render/brushFeedback';

export type BrushSymmetry = 'none' | 'x' | 'y' | 'both';
/** Workspace preferences do not become part of an authored stroke. */
export interface BrushInputSettings extends BrushSettings {
  smoothing?: number;
  symmetry?: BrushSymmetry;
  radiusUnit?: 'meters' | 'texels' | 'screen';
  radiusPixels?: number;
  overlayOpacity?: number;
  showFalloff?: boolean;
  showMask?: boolean;
  presetId?: string;
}
export interface BrushPreset {
  id: string;
  name: string;
  description: string;
  settings: Partial<BrushInputSettings>;
}

export const BRUSH_SETTINGS_KEY = 'normal-height.paint-brush.v1';
export const DEFAULT_BRUSH_SETTINGS: BrushInputSettings = {
  layer: 'rock',
  radius: 0.035,
  hardness: 0.55,
  strength: 0.9,
  mode: 'paint',
  pressure: 'none',
  texture: 'smooth',
  spacing: 0.15,
  angle: 0,
  aspect: 1,
  jitter: 0,
  smoothing: 0.2,
  symmetry: 'none',
  radiusUnit: 'meters',
  radiusPixels: 48,
  overlayOpacity: 0.5,
  showFalloff: true,
  showMask: true,
  presetId: 'custom',
};

export const BRUSH_PRESETS: readonly BrushPreset[] = [
  {
    id: 'soft', name: 'Soft wash',
    description: 'A feathered, low-opacity brush for gradual material transitions.',
    settings: { hardness: 0.08, strength: 0.35, texture: 'smooth', mode: 'paint', spacing: 0.1,
      aspect: 1, jitter: 0, smoothing: 0.35, mask: undefined },
  },
  {
    id: 'hard', name: 'Hard round',
    description: 'Precise, opaque coverage with a crisp edge.',
    settings: { hardness: 1, strength: 1, texture: 'smooth', mode: 'paint', spacing: 0.08,
      aspect: 1, jitter: 0, smoothing: 0.15, mask: undefined },
  },
  {
    id: 'rock', name: 'Rock outcrop',
    description: 'Broken mineral coverage on slopes above 28°.',
    settings: { layer: 'rock', hardness: 0.5, strength: 0.85, texture: 'grain', mode: 'paint',
      spacing: 0.15, aspect: 0.75, angle: 30, jitter: 0.15, smoothing: 0.2,
      mask: { slope: [28, 90], feather: 0.12, breakup: 0.25, scale: 24 } },
  },
  {
    id: 'soil', name: 'Earth & sediment',
    description: 'Soft soil deposits with a gently broken edge.',
    settings: { layer: 'soil', hardness: 0.18, strength: 0.65, texture: 'grain', mode: 'paint',
      spacing: 0.12, aspect: 1, jitter: 0.08, smoothing: 0.3, mask: undefined },
  },
  {
    id: 'vegetation', name: 'Meadow scatter',
    description: 'Organic vegetation patches on gentler terrain.',
    settings: { layer: 'vegetation', hardness: 0.25, strength: 0.7, texture: 'scatter', mode: 'paint',
      spacing: 0.22, aspect: 1, jitter: 0.35, smoothing: 0.15,
      mask: { slope: [0, 38], feather: 0.15, breakup: 0.18, scale: 34 } },
  },
  {
    id: 'snow', name: 'Snow drift',
    description: 'A soft snow brush that leaves steep faces exposed.',
    settings: { layer: 'snow', hardness: 0.18, strength: 0.8, texture: 'smooth', mode: 'paint',
      spacing: 0.1, aspect: 0.65, angle: 0, jitter: 0.08, smoothing: 0.35,
      mask: { slope: [0, 42], feather: 0.18 } },
  },
  {
    id: 'blend', name: 'Blend edges',
    description: 'Soften local transitions between authored materials.',
    settings: { hardness: 0.05, strength: 0.4, texture: 'smooth', mode: 'blend', spacing: 0.1,
      aspect: 1, jitter: 0, smoothing: 0.4, mask: undefined },
  },
  {
    id: 'restore', name: 'Restore terrain',
    description: 'Erase paint on the active layer to reveal what lies below.',
    settings: { layer: 'erase', hardness: 0.2, strength: 0.6, texture: 'smooth', mode: 'paint',
      spacing: 0.1, aspect: 1, jitter: 0, smoothing: 0.25, mask: undefined },
  },
];

export function applyBrushPreset(current: BrushInputSettings, id: string): BrushInputSettings {
  const preset = BRUSH_PRESETS.find(item => item.id === id);
  return preset ? { ...current, ...preset.settings, presetId: preset.id } : current;
}

const number = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
const option = <const T extends string>(value: unknown, values: readonly T[], fallback: T): T =>
  typeof value === 'string' && values.includes(value as T) ? value as T : fallback;

/** Only known, bounded controls are restored. Selection geometry belongs to a
 * project session and must never leak into a different project via storage. */
export function normalizeBrushSettings(input: unknown): BrushInputSettings {
  const v = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown> : {};
  const next: BrushInputSettings = {
    ...DEFAULT_BRUSH_SETTINGS,
    layer: option(v.layer, ['rock', 'soil', 'vegetation', 'snow', 'erase'], 'rock'),
    radius: number(v.radius, DEFAULT_BRUSH_SETTINGS.radius, 0.0001, 0.5),
    hardness: number(v.hardness, DEFAULT_BRUSH_SETTINGS.hardness, 0, 1),
    strength: number(v.strength, DEFAULT_BRUSH_SETTINGS.strength, 0.01, 1),
    mode: option(v.mode, ['paint', 'blend', 'replace'], 'paint'),
    pressure: option(v.pressure, ['none', 'radius', 'strength', 'both'], 'none'),
    texture: option(v.texture, ['smooth', 'grain', 'scatter'], 'smooth'),
    spacing: number(v.spacing, 0.15, 0.01, 2),
    angle: number(v.angle, 0, -360, 360),
    aspect: number(v.aspect, 1, 0.1, 1),
    jitter: number(v.jitter, 0, 0, 1),
    smoothing: number(v.smoothing, 0.2, 0, 1),
    symmetry: option(v.symmetry, ['none', 'x', 'y', 'both'], 'none'),
    radiusUnit: option(v.radiusUnit, ['meters', 'texels', 'screen'], 'meters'),
    radiusPixels: number(v.radiusPixels, 48, 1, 512),
    overlayOpacity: number(v.overlayOpacity, 0.5, 0, 1),
    showFalloff: typeof v.showFalloff === 'boolean' ? v.showFalloff : true,
    showMask: typeof v.showMask === 'boolean' ? v.showMask : true,
    presetId: typeof v.presetId === 'string' && BRUSH_PRESETS.some(preset => preset.id === v.presetId)
      ? v.presetId : 'custom',
  };
  if (typeof v.source === 'string' && ['rock', 'soil', 'vegetation', 'snow'].includes(v.source))
    next.source = v.source as MaterialStroke['source'];
  if (v.mask !== undefined) {
    try {
      next.mask = parseMaterialPaint([{ ...strokeSettings(next), mask: v.mask,
        points: [{ u: 0.5, v: 0.5 }] }])[0].mask;
    } catch { /* Invalid saved masks are discarded without losing usable controls. */ }
  }
  return next;
}

export function readBrushSettings(storage?: Pick<Storage, 'getItem'>): BrushInputSettings {
  try {
    const target = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
    return normalizeBrushSettings(JSON.parse(target?.getItem(BRUSH_SETTINGS_KEY) ?? 'null'));
  } catch { return { ...DEFAULT_BRUSH_SETTINGS }; }
}

export function writeBrushSettings(settings: BrushInputSettings, storage?: Pick<Storage, 'setItem'>) {
  try {
    const target = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
    target?.setItem(BRUSH_SETTINGS_KEY, JSON.stringify(normalizeBrushSettings(settings)));
  } catch { /* Private browsing and quota limits do not interrupt painting. */ }
}

/** Strip non-authoring preferences before a stroke is saved/exported. */
export function strokeSettings(settings: BrushInputSettings): BrushSettings {
  const {
    smoothing: _smoothing, symmetry: _symmetry, radiusUnit: _radiusUnit,
    radiusPixels: _radiusPixels, overlayOpacity: _overlayOpacity,
    showFalloff: _showFalloff, showMask: _showMask, presetId: _presetId, ...stroke
  } = settings;
  return stroke;
}
