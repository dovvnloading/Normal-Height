import { describe, expect, it } from 'vitest';
import { COAST_DEFAULTS, shapeCoast } from './coast';

const settings = {
  ...COAST_DEFAULTS,
  worldSize: 1000,
  heightScale: 200,
  seaLevel: 0.5,
  beachWidth: 160,
  shelfWidth: 250,
  beachSlope: 6,
  shelfSlope: 3,
  strength: 1,
};
function grid(n: number, sample: (x: number, y: number) => number) {
  return Float32Array.from({ length: n * n }, (_, i) => sample(i % n, Math.floor(i / n)));
}

describe('coastal shelf', () => {
  it('grades a physical beach and shelf around an interpolated waterline at either resolution', () => {
    // Crossing at 502.5 m (between samples at both resolutions).
    const signedHeight = (meters: number) => 0.5 + (meters - 502.5) * 0.001;
    for (const n of [101, 201]) {
      const source = grid(n, (x) => signedHeight((x * 1000) / (n - 1)));
      const before = source.slice();
      const { height, water, shore } = shapeCoast(source, n, settings);
      const sample = (meters: number) => Math.round((meters * (n - 1)) / 1000);
      const beach = sample(550),
        shelf = sample(410);
      expect(height[beach]).toBeCloseTo(0.5 + (Math.tan((6 * Math.PI) / 180) * 47.5) / 200, 6);
      expect(height[shelf]).toBeCloseTo(0.5 - (Math.tan((3 * Math.PI) / 180) * 92.5) / 200, 6);
      expect(water[shelf]).toBe(1);
      expect(water[beach]).toBe(0);
      expect(shore[shelf]).toBe(1);
      expect(shore[beach]).toBe(1);
      expect(shore[sample(620)]).toBeGreaterThan(0);
      expect(shore[sample(620)]).toBeLessThan(1);
      for (const meters of [0, 250, 670, 1000]) {
        const i = sample(meters);
        expect(height[i]).toBe(source[i]);
        expect(shore[i]).toBe(0);
      }
      expect(source).toEqual(before);
      expect(
        height.every((v, i) => Number.isFinite(v) && v <= settings.seaLevel === water[i] > 0),
      ).toBe(true);
    }
  });

  it('preserves enclosed depressions and diagonal barriers, with an option to grade lake shores', () => {
    const n = 33;
    const source = grid(n, (x, y) =>
      x < 6 || (x >= 7 && x <= 12 && y > 6 && y < 24) || (x === 6 && y === 6) ? 0.1 : 0.9,
    );
    // The ocean reaches the notch but only meets the lake corner-to-corner.
    const ocean = shapeCoast(source, n, settings);
    const lake = 10 * n + 7;
    expect(ocean.water[lake]).toBe(0);
    expect(ocean.shore[lake]).toBe(0);
    expect(ocean.height[lake]).toBe(source[lake]);
    const lakes = shapeCoast(source, n, { ...settings, includeLakes: true });
    expect(lakes.water[lake]).toBe(1);
    expect(lakes.shore[lake]).toBe(1);
    expect(lakes.height[lake]).toBeGreaterThan(source[lake]);
    // Cutting one side-connected opening turns the lake into a bay.
    source[7 * n + 6] = 0.1;
    const bay = shapeCoast(source, n, settings);
    expect(bay.water[lake]).toBe(1);
    expect(bay.shore[lake]).toBeGreaterThan(0);
  });

  it('measures radial distance around a point island without axis-aligned facets', () => {
    const n = 65;
    const source = grid(n, (x, y) => (x === 32 && y === 32 ? 1 : 0));
    const { height } = shapeCoast(source, n, { ...settings, worldSize: 640, shelfWidth: 500 });
    for (const [dx, dy] of [
      [11, 2],
      [10, 5],
      [8, 8],
      [-2, 11],
      [5, -10],
    ]) {
      const sites = [
        [0.5, 0],
        [-0.5, 0],
        [0, 0.5],
        [0, -0.5],
      ];
      const meters = 10 * Math.min(...sites.map(([x, y]) => Math.hypot(dx - x, dy - y)));
      expect(height[(32 + dy) * n + 32 + dx]).toBeCloseTo(
        0.5 - (meters * Math.tan((3 * Math.PI) / 180)) / 200,
        6,
      );
    }
  });

  it('retains useful masks at zero strength and supports independent zero-width bands', () => {
    const n = 65;
    const source = grid(n, (x) => x / (n - 1));
    const full = shapeCoast(source, n, settings);
    const masksOnly = shapeCoast(source, n, { ...settings, strength: 0 });
    expect(masksOnly.height).toEqual(source);
    expect(masksOnly.shore).toEqual(full.shore);
    expect(masksOnly.water).toEqual(full.water);
    const shelfOnly = shapeCoast(source, n, { ...settings, beachWidth: 0 });
    expect(
      shelfOnly.height.every(
        (h, i) => shelfOnly.water[i] === 1 || (h === source[i] && shelfOnly.shore[i] === 0),
      ),
    ).toBe(true);
    expect(shelfOnly.height).not.toEqual(source);
    const waterOnly = shapeCoast(source, n, { ...settings, beachWidth: 0, shelfWidth: 0 });
    expect(waterOnly.water).toEqual(full.water);
    expect(waterOnly.height).toEqual(source);
    expect(waterOnly.shore.every((v) => v === 0)).toBe(true);
  });

  it('returns the footprint without inventing a coastline at the tile border', () => {
    for (const level of [0.1, 0.5, 0.8]) {
      const source = new Float32Array(32 * 32).fill(level);
      const { height, shore, water } = shapeCoast(source, 32, settings);
      expect(height).toEqual(source);
      expect(shore.every((v) => v === 0)).toBe(true);
      expect(water.every((v) => v === (level <= settings.seaLevel ? 1 : 0))).toBe(true);
    }
  });

  it('keeps dry samples above sea level when their target grade is smaller than a Float32 increment', () => {
    const n = 32;
    const source = grid(n, (x) => (x < 16 ? 0 : 0.50000006));
    const { height, water } = shapeCoast(source, n, {
      ...settings,
      worldSize: 100,
      heightScale: 20_000,
      beachSlope: 0.1,
    });
    expect(height[16]).toBeGreaterThan(settings.seaLevel);
    expect(water[16]).toBe(0);
  });
});
