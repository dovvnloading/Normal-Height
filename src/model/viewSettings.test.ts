import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW_SETTINGS, parseViewSettings } from './viewSettings';

describe('versioned preview settings', () => {
  it('restores prior preferences without affecting project data', () => {
    const settings = parseViewSettings({
      skyEnabled: true,
      cloudCoverage: 0.63,
      groundReach: 6,
      expandGround: true,
      material: 'alpine',
      nearFieldDetail: false,
      exaggeration: 1.8,
    });
    expect(settings.skyEnabled).toBe(true);
    expect(settings.cloudCoverage).toBe(0.63);
    expect(settings.expandGround).toBe(true);
    expect(settings.groundReach).toBe(6);
    expect(settings.material).toBe('alpine');
    expect(settings.nearFieldDetail).toBe(false);
    expect(settings.exaggeration).toBe(1.8);
    expect(settings.sunAzimuth).toBe(DEFAULT_VIEW_SETTINGS.sunAzimuth);
  });

  it('clamps malformed numeric settings and drops unknown keys', () => {
    const settings = parseViewSettings({
      skyEnabled: 'true',
      cloudCoverage: 72,
      skyExposure: Number.NaN,
      skyTurbidity: -4,
      groundReach: Infinity,
      grassDensity: 100000,
      nearFieldDetail: 'false',
      material: 'unrecognized',
      __proto__: { pollution: true },
    });
    expect(settings.skyEnabled).toBe(false);
    expect(settings.cloudCoverage).toBe(1);
    expect(settings.skyExposure).toBe(1);
    expect(settings.skyTurbidity).toBe(1);
    expect(settings.groundReach).toBe(5);
    // Old saved grass-density preferences are ignored after removing blades.
    expect('grassDensity' in settings).toBe(false);
    expect(settings.material).toBe('pbr');
    expect(settings.nearFieldDetail).toBe(true);
    expect(Object.keys(settings)).toEqual(Object.keys(DEFAULT_VIEW_SETTINGS));
    expect(parseViewSettings(null)).toEqual(DEFAULT_VIEW_SETTINGS);
  });
});
