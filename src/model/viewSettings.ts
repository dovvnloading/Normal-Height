import type { ViewSettings } from './types';

/**
 * Presentation preferences are independent of the generated terrain graph.
 * Keep storage versioned, constrained and recoverable when old or manually
 * edited browser data is encountered.
 */
export const VIEW_STORAGE_KEY = 'normal-height.view.v1';

export const DEFAULT_VIEW_SETTINGS: ViewSettings = {
  material: 'pbr',
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
  expandGround: false,
  groundReach: 5,
  grassDensity: 0.75,
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
  groundReach: [3, 8],
  grassDensity: [0.2, 1.5],
};

const switches: (keyof ViewSettings)[] = [
  'contours', 'wireframe', 'autoRotate', 'skyEnabled', 'expandGround',
];

export function parseViewSettings(value: unknown): ViewSettings {
  const result = { ...DEFAULT_VIEW_SETTINGS };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  const input = value as Record<string, unknown>;
  if (['pbr', 'alpine', 'clay', 'height'].includes(String(input.material))) {
    result.material = input.material as ViewSettings['material'];
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
