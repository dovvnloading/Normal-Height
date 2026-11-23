import type { ViewSettings } from './types';

/**
 * Presentation preferences are independent of the generated terrain graph.
 * Keep storage versioned, constrained and recoverable when old or manually
 * edited browser data is encountered.
 */
export const VIEW_STORAGE_KEY = 'normal-height.view.v1';

export const DEFAULT_VIEW_SETTINGS: ViewSettings = {
  material: 'pbr',
  nearFieldDetail: true,
  meshQuality: 'high',
  sunAzimuth: 315,
  sunElevation: 38,
  exaggeration: 1,
  contours: false,
  wireframe: false,
  autoRotate: false,
  skyEnabled: false,
  skyTurbidity: 4.5,
  skyRayleigh: 2.2,
  skyExposure: 1,
  cloudCoverage: 0.42,
  cloudSpeed: 0.35,
  cloudShadowStrength: 0.72,
  expandGround: false,
  groundReach: 5,
  waterEnabled: false,
  waterHorizon: true,
  waterLevelMode: 'coast',
  waterLevel: 0,
  waterPalette: 'lagoon',
  waterWaveHeight: 1.3,
  waterSpeed: 0.75,
  waterClarity: 0.74,
  waterFoam: 0.78,
};

const ranges: Partial<Record<keyof ViewSettings, [number, number]>> = {
  sunAzimuth: [0, 360],
  sunElevation: [2, 85],
  exaggeration: [0.5, 3],
  skyTurbidity: [1, 16],
  skyRayleigh: [0.2, 4],
  skyExposure: [0.6, 1.5],
  cloudCoverage: [0, 1],
  cloudSpeed: [0, 2],
  cloudShadowStrength: [0, 1],
  groundReach: [3, 8],
  waterLevel: [-12000, 12000],
  waterWaveHeight: [0, 5],
  waterSpeed: [0, 2],
  waterClarity: [0, 1],
  waterFoam: [0, 1],
};

const switches: (keyof ViewSettings)[] = [
  'contours', 'wireframe', 'autoRotate', 'skyEnabled', 'expandGround',
  'nearFieldDetail', 'waterEnabled', 'waterHorizon',
];

export function parseViewSettings(value: unknown): ViewSettings {
  const result = { ...DEFAULT_VIEW_SETTINGS };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  const input = value as Record<string, unknown>;
  if (['pbr', 'alpine', 'clay', 'height'].includes(String(input.material))) {
    result.material = input.material as ViewSettings['material'];
  }
  if (['coast', 'manual'].includes(String(input.waterLevelMode))) {
    result.waterLevelMode = input.waterLevelMode as ViewSettings['waterLevelMode'];
  }
  if (['lagoon', 'alpine', 'ocean', 'dusk'].includes(String(input.waterPalette))) {
    result.waterPalette = input.waterPalette as ViewSettings['waterPalette'];
  }
  if (['balanced', 'high', 'ultra'].includes(String(input.meshQuality))) {
    result.meshQuality = input.meshQuality as ViewSettings['meshQuality'];
  }
  for (const [key, [minimum, maximum]] of Object.entries(ranges)) {
    const setting = input[key];
    if (typeof setting === 'number' && Number.isFinite(setting)) {
      (result as unknown as Record<string, unknown>)[key] =
        Math.max(minimum, Math.min(maximum, setting));
    }
  }
  for (const key of switches) {
    if (typeof input[key] === 'boolean') {
      (result as unknown as Record<string, unknown>)[key] = input[key];
    }
  }
  return result;
}

export function loadViewSettings(): ViewSettings {
  try {
    const stored = localStorage.getItem(VIEW_STORAGE_KEY);
    return stored ? parseViewSettings(JSON.parse(stored)) : { ...DEFAULT_VIEW_SETTINGS };
  } catch {
    return { ...DEFAULT_VIEW_SETTINGS };
  }
}

export function saveViewSettings(settings: ViewSettings): void {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(parseViewSettings(settings)));
  } catch {
    // Private browsing, disabled storage and quota errors must not break the editor.
  }
}
