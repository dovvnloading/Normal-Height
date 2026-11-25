import { describe, expect, it } from 'vitest';
import { applyBrushPreset, BRUSH_PRESETS, BRUSH_SETTINGS_KEY, DEFAULT_BRUSH_SETTINGS,
  normalizeBrushSettings, readBrushSettings, strokeSettings, writeBrushSettings } from './brushPresets';
import { parseMaterialPaint } from './materialPaint';

describe('paint workspace preferences', () => {
  it('roundtrips supported settings and never carries project selection to another project', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); } };
    const settings = { ...DEFAULT_BRUSH_SETTINGS, layer: 'snow' as const, pressure: 'both' as const,
      smoothing: 0.7, symmetry: 'x' as const, radiusUnit: 'screen' as const, radiusPixels: 72,
      selection: { points: [{ u: 0, v: 0 }, { u: 1, v: 0 }, { u: 1, v: 1 }] },
      mask: { slope: [0, 35] as [number, number], feather: 0.15 } };
    writeBrushSettings(settings, storage);
    const restored = readBrushSettings(storage);
    expect(restored).toMatchObject({ layer: 'snow', pressure: 'both', smoothing: 0.7,
      symmetry: 'x', radiusUnit: 'screen', radiusPixels: 72, mask: settings.mask });
    expect(restored.selection).toBeUndefined();
    const authored = strokeSettings(restored);
    expect(authored).not.toHaveProperty('smoothing');
    expect(authored).not.toHaveProperty('overlayOpacity');
    expect(authored).not.toHaveProperty('radiusUnit');
    expect(authored).not.toHaveProperty('symmetry');
    expect(values.has(BRUSH_SETTINGS_KEY)).toBe(true);
  });
  it('uses bounded defaults with malformed or unavailable storage', () => {
    expect(readBrushSettings({ getItem: () => '{broken' })).toEqual(DEFAULT_BRUSH_SETTINGS);
    expect(readBrushSettings({ getItem: () => { throw new Error('disabled'); } })).toEqual(DEFAULT_BRUSH_SETTINGS);
    expect(() => writeBrushSettings(DEFAULT_BRUSH_SETTINGS,
      { setItem: () => { throw new Error('quota'); } })).not.toThrow();
    const cleaned = normalizeBrushSettings({ layer: '__proto__', radius: Infinity,
      strength: -3, smoothing: 90, aspect: 0, radiusUnit: 'bad',
      mask: { slope: ['bad', 3] } });
    expect(cleaned.layer).toBe('rock');
    expect(cleaned.radius).toBe(DEFAULT_BRUSH_SETTINGS.radius);
    expect(cleaned.strength).toBe(0.01);
    expect(cleaned.smoothing).toBe(1);
    expect(cleaned.aspect).toBe(0.1);
    expect(cleaned.radiusUnit).toBe('meters');
    expect(cleaned.mask).toBeUndefined();
  });
  it('all presets are valid authored brushes and preserve the radius preference', () => {
    for (const preset of BRUSH_PRESETS) {
      const value = applyBrushPreset({ ...DEFAULT_BRUSH_SETTINGS, radius: 0.06 }, preset.id);
      expect(value.radius).toBe(0.06);
      expect(value.presetId).toBe(preset.id);
      expect(() => parseMaterialPaint([{ ...strokeSettings(value), points: [{ u: 0.5, v: 0.5 }] }])).not.toThrow();
    }
    const current = { ...DEFAULT_BRUSH_SETTINGS };
    expect(applyBrushPreset(current, 'missing')).toBe(current);
  });
});
