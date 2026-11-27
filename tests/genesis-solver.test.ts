import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  DEFAULT_GENESIS,
  GENESIS_PRESETS,
  normalizeGenesisSettings,
  validateGenesisSettings,
} from '../src/model/genesis';
import { createWorldDefinition, type WorldDomain } from '../src/model/world';
import {
  createGeologySampler,
  estimateGenesisPeakBytes,
  genesisGridSize,
  prepareGenesis,
} from '../src/engine/genesis';
import { genesisCellAreas, routeGenesisDrainage } from '../src/engine/genesis/drainage';
import { inciseStreamPower, relaxGenesisHillslopes } from '../src/engine/genesis/solver';
import type { TransportGrid } from '../src/engine/world/hydrology';
import { isGenesisReport } from '../src/engine/genesis/report';

const domain: WorldDomain = {
  ...createWorldDefinition({ worldSize: 1800, heightScale: 1200 }).domain,
  originX: -700,
  originZ: 210,
  width: 1800,
  depth: 1200,
  boundary: 'open',
};
const source = (x: number, z: number) => {
  const xx = (x - domain.originX) / domain.width;
  const zz = (z - domain.originZ) / domain.depth;
  return (
    250 +
    220 * Math.sin(xx * Math.PI) * Math.sin(zz * Math.PI) +
    12 * Math.cos(xx * 17) * Math.sin(zz * 13)
  );
};
const settings = {
  ...DEFAULT_GENESIS,
  enabled: true,
  iterations: 3,
  durationYears: 50000,
  upliftMeters: 120,
  faultThrowMeters: 20,
};

describe('Genesis saved model and physical geometry', () => {
  it('strictly preserves supported fields and rejects malformed or future versions', () => {
    expect(normalizeGenesisSettings(undefined)).toEqual(DEFAULT_GENESIS);
    for (const preset of GENESIS_PRESETS)
      expect(validateGenesisSettings(preset.settings)).toBeNull();
    const normalized = normalizeGenesisSettings(settings);
    expect(normalized).toEqual(settings);
    expect(normalized).not.toBe(settings);
    for (const invalid of [
      { ...settings, version: 2 },
      { ...settings, rainfall: NaN },
      { ...settings, iterations: 1.5 },
      { ...settings, enabled: 1 },
      { ...settings, strataThicknessMeters: 0 },
      { ...settings, rockHardness: -0.1 },
      { ...settings, durationYears: Infinity },
      { ...settings, erosionRate: 10 },
    ])
      expect(() => normalizeGenesisSettings(invalid)).toThrow(/Genesis/);
  });

  it('uses aspect-aware rectangular grids and a bounded conservative memory estimate', () => {
    expect(genesisGridSize(domain, 129)).toEqual({ width: 129, height: 86 });
    expect(genesisGridSize({ width: 1, depth: 10000 }, 65)).toEqual({ width: 2, height: 65 });
    expect(genesisGridSize({ width: 100, depth: 100 }, 1024)).toEqual({
      width: 1024,
      height: 1024,
    });
    expect(estimateGenesisPeakBytes({ width: 100, depth: 100 }, 1024)).toBeGreaterThan(
      128 * 1024 ** 2,
    );
    expect(estimateGenesisPeakBytes(domain, 256)).toBeLessThan(128 * 1024 ** 2);
    expect(() => genesisGridSize(domain, 2048)).toThrow(/1024/);
  });

  it('samples categorical strata deterministically in physical coordinates and moves beds with uplift', () => {
    const geological = createGeologySampler(domain, 17, settings);
    const a = geological.sample(-123.4, 567.8, 450);
    expect(geological.sample(-123.4, 567.8, 450)).toEqual(a);
    expect(geological.sample(-123.4, 567.8, 570, 120)).toEqual(a);
    expect(Number.isInteger(a.lithology)).toBe(true);
    expect(a.lithology).toBeGreaterThanOrEqual(0);
    expect(a.lithology).toBeLessThan(4);
    expect(a.hardness).toBeGreaterThanOrEqual(0);
    expect(a.hardness).toBeLessThanOrEqual(1);
    expect(geological.uplift(domain.originX, 600)).toBe(0);
    expect(geological.uplift(domain.originX + domain.width, 600)).toBe(0);
  });
});

describe('Genesis numerical operators', () => {
  const grid: TransportGrid = {
    width: 17,
    height: 11,
    widthMeters: 320,
    depthMeters: 100,
    boundary: 'closed',
  };
  const terrain = () =>
    Float64Array.from(
      { length: grid.width * grid.height },
      (_, i) => 50 + 15 * Math.sin((i % grid.width) * 0.4) + Math.floor(i / grid.width) * 1.3,
    );

  it('routes every cell without cycles and accounts for physical half-edge areas', () => {
    for (const boundary of ['open', 'closed'] as const) {
      const g = { ...grid, boundary };
      const heights = terrain();
      heights[5 * grid.width + 8] = -25;
      const before = heights.slice();
      const result = routeGenesisDrainage(heights, g);
      const rank = new Int32Array(heights.length);
      result.order.forEach((i, k) => (rank[i] = k));
      let area = 0;
      for (let i = 0; i < heights.length; i++) {
        const next = result.receiver[i];
        if (next >= 0) expect(rank[next]).toBeLessThan(rank[i]);
        else {
          area += result.contributingAreaM2[i];
          if (boundary === 'open')
            expect(
              i % grid.width === 0 ||
                i % grid.width === grid.width - 1 ||
                i < grid.width ||
                i >= heights.length - grid.width,
            ).toBe(true);
        }
      }
      expect(area).toBeCloseTo(grid.widthMeters * grid.depthMeters, 8);
      expect(heights).toEqual(before);
      expect(routeGenesisDrainage(heights, g)).toEqual(result);
      if (boundary === 'closed') expect(result.outletCount).toBe(1);
    }
    const areas = genesisCellAreas(grid);
    expect(areas[grid.width + 1]).toBe(4 * areas[0]);
    expect(areas[1]).toBe(2 * areas[0]);
  });

  it('uses physical receiver distance on anisotropic grids', () => {
    const g = { width: 3, height: 3, widthMeters: 200, depthMeters: 2, boundary: 'open' as const };
    const h = new Float64Array(9).fill(20);
    h[4] = 1;
    h[5] = 0;
    h[7] = 0.5;
    expect(routeGenesisDrainage(h, g).receiver[4]).toBe(7);
  });

  it('partitions downhill runoff analytically, conserves area, and falls back through pits', () => {
    const g = { width: 3, height: 3, widthMeters: 2, depthMeters: 2, boundary: 'open' as const };
    const h = new Float64Array([20, 20, 20, 20, 8, 20, 0, 0, 0]);
    const d = routeGenesisDrainage(h, g);
    const diagonal = (1 / Math.SQRT2) ** 1.1,
      total = 1 + 2 * diagonal;
    expect(d.receiver[4]).toBe(7);
    expect(d.contributingAreaM2[7]).toBeCloseTo(0.5 + 1 / total, 12);
    expect(d.contributingAreaM2[6]).toBeCloseTo(0.25 + diagonal / total, 12);
    expect(d.contributingAreaM2[8]).toBeCloseTo(0.25 + diagonal / total, 12);
    // An uphill neighbor receives none of the center's rain.
    expect(d.contributingAreaM2[1]).toBe(0.5);
    const pit = new Float64Array(9);
    pit[4] = -2;
    const closedPit = routeGenesisDrainage(pit, g),
      outlet = closedPit.receiver[4];
    expect(outlet).toBeGreaterThanOrEqual(0);
    expect(closedPit.contributingAreaM2[outlet]).toBe(closedPit.cellAreaM2[outlet] + 1);
    expect(closedPit.filledHeight[4]).toBe(0);
    expect(pit[4]).toBe(-2);
  });

  it('preserves mirrored downhill area and reduces D8 direction snapping on a noiseless slope', () => {
    const n = 41;
    const g = {
      width: n,
      height: n,
      widthMeters: 400,
      depthMeters: 400,
      boundary: 'open' as const,
    };
    const symmetric = Float64Array.from(
      { length: n * n },
      (_, i) => Math.floor(i / n) * 2 + Math.abs((i % n) - (n - 1) / 2) * 0.3,
    );
    const s = routeGenesisDrainage(symmetric, g);
    for (let z = 0; z < n; z++)
      for (let x = 0; x < n; x++)
        expect(s.contributingAreaM2[z * n + x]).toBeCloseTo(
          s.contributingAreaM2[z * n + n - 1 - x],
          7,
        );
    const plane = Float64Array.from(
      { length: n * n },
      (_, i) => Math.floor(i / n) + (i % n) * 0.48,
    );
    const mfd = routeGenesisDrainage(plane, g);
    const outlets = mfd.order.filter((i) => mfd.receiver[i] < 0);
    const total = outlets.reduce((sum, i) => sum + mfd.contributingAreaM2[i], 0);
    expect(total).toBeCloseTo(g.widthMeters * g.depthMeters, 7);
    // With one donor, recover its actual MFD flux vector from outlet area.
    // A 0.48:1 oblique gradient lies between the D8 grid directions.
    const tiny = { width: 3, height: 3, widthMeters: 2, depthMeters: 2, boundary: 'open' as const };
    const slope = Float64Array.from({ length: 9 }, (_, i) => Math.floor(i / 3) + (i % 3) * 0.48);
    const runoff = routeGenesisDrainage(slope, tiny);
    let east = 0,
      south = 0;
    for (let i = 0; i < 9; i++)
      if (i !== 4) {
        const received = runoff.contributingAreaM2[i] - runoff.cellAreaM2[i];
        east += received * ((i % 3) - 1);
        south += received * (Math.floor(i / 3) - 1);
      }
    const expectedAngle = Math.atan(0.48);
    const mfdError = Math.abs(Math.atan2(-east, -south) - expectedAngle);
    const receiver = runoff.receiver[4];
    const d8Error = Math.abs(
      Math.atan2(1 - (receiver % 3), 1 - Math.floor(receiver / 3)) - expectedAngle,
    );
    expect(mfdError).toBeLessThan(Math.PI / 180);
    expect(d8Error).toBeGreaterThan((15 * Math.PI) / 180);
  });

  it('matches the analytical implicit n=1 update and hardness bounds', () => {
    const g = { width: 3, height: 3, widthMeters: 2, depthMeters: 2, boundary: 'open' as const };
    const height = new Float64Array(9).fill(20);
    height[4] = 8;
    height[7] = 0;
    const drainage = routeGenesisDrainage(height, g);
    const soft = height.slice();
    const incised = inciseStreamPower(soft, g, drainage, new Float32Array(9), 0.2, 1, 3);
    expect(soft[4]).toBeCloseTo(8 / (1 + 0.2 * 3), 12);
    expect(incised).toBeCloseTo(8 - soft[4], 12);
    const resistant = height.slice();
    inciseStreamPower(resistant, g, drainage, new Float32Array(9).fill(0.8), 0.2, 1, 3);
    expect(resistant[4]).toBeGreaterThan(soft[4]);
    const hard = height.slice();
    expect(inciseStreamPower(hard, g, drainage, new Float32Array(9).fill(1), 0.2, 1, 3)).toBe(0);
    expect(hard).toEqual(height);
    expect(soft[4]).toBeGreaterThanOrEqual(soft[7]);
  });

  it('never fills a routed depression and has exact dry identity', () => {
    const input = terrain();
    input[5 * grid.width + 8] = -100;
    const g = { ...grid, boundary: 'open' as const };
    const drainage = routeGenesisDrainage(input, g);
    const eroded = input.slice();
    inciseStreamPower(eroded, g, drainage, new Float32Array(input.length), 0.01, 1, 2000000);
    for (let i = 0; i < input.length; i++) expect(eroded[i]).toBeLessThanOrEqual(input[i]);
    expect(eroded[5 * grid.width + 8]).toBe(-100);
    const dry = input.slice();
    expect(
      inciseStreamPower(dry, g, drainage, new Float32Array(input.length), 0.01, 0, 10000),
    ).toBe(0);
    expect(dry).toEqual(input);
  });

  it('converges to the fixed-channel analytical solution as time steps are refined', () => {
    const g = { width: 3, height: 3, widthMeters: 2, depthMeters: 2, boundary: 'open' as const };
    const initial = new Float64Array(9).fill(20);
    initial[4] = 8;
    initial[7] = 0;
    const drainage = routeGenesisDrainage(initial, g),
      hardness = new Float32Array(9);
    const solve = (steps: number) => {
      const h = initial.slice();
      for (let i = 0; i < steps; i++)
        inciseStreamPower(h, g, drainage, hardness, 0.2, 1, 3 / steps);
      return h[4];
    };
    const exact = 8 * Math.exp(-0.2 * 3);
    expect(Math.abs(solve(64) - exact)).toBeLessThan(Math.abs(solve(8) - exact));
    expect(Math.abs(solve(8) - exact)).toBeLessThan(Math.abs(solve(1) - exact));
    expect(solve(64)).toBeCloseTo(exact, 1);
  });

  it('conserves volume and stays monotone under large closed-domain diffusion steps', () => {
    const h = terrain(),
      input = h.slice();
    const areas = genesisCellAreas(grid);
    const before = h.reduce((sum, v, i) => sum + v * areas[i], 0);
    const result = relaxGenesisHillslopes(h, grid, areas, new Float32Array(h.length), 100, 2000000);
    const after = h.reduce((sum, v, i) => sum + v * areas[i], 0);
    expect(result.movedVolumeM3).toBeGreaterThan(0);
    expect(Math.abs(after - before)).toBeLessThan(1e-7);
    expect(Math.abs(result.residualM3)).toBeLessThan(1e-7);
    const min = Math.min(...input),
      max = Math.max(...input);
    for (const value of h) {
      expect(value).toBeGreaterThanOrEqual(min);
      expect(value).toBeLessThanOrEqual(max);
    }
  });
});

describe('complete multiscale Genesis', () => {
  it('preserves the version-one canonical terrain and diagnostic fingerprint', async () => {
    // Captured on Node 24.22.3, CPU reference. Quantized little-endian values
    // remove irrelevant sub-Float32 rounding. Changes require an algorithm
    // version/migration review, not an automatic golden update.
    const result = await prepareGenesis(source, domain, 25, 48271, settings);
    const hash = createHash('sha256');
    for (const key of [
      'height',
      'sourceHeight',
      'hardness',
      'uplift',
      'incision',
      'drainageArea',
      'channel',
    ] as const) {
      hash.update(key);
      const values = result[key],
        bytes = new Uint8Array(values.length * 4);
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < values.length; i++)
        view.setFloat32(i * 4, Math.round(values[i] * 1e4) / 1e4, true);
      hash.update(bytes);
    }
    hash.update(result.lithology);
    expect(hash.digest('hex')).toBe(
      '4f50971fa28693d33f4733d79760b171c60d9354f7ebfd88c4509196c158deeb',
    );
  });

  it('is deterministic, leaves inputs untouched and reports a complete volume ledger', async () => {
    const saved = structuredClone(settings);
    const a = await prepareGenesis(source, domain, 97, 71, settings);
    const b = await prepareGenesis(source, domain, 97, 71, settings);
    expect(settings).toEqual(saved);
    for (const key of [
      'height',
      'sourceHeight',
      'hardness',
      'lithology',
      'uplift',
      'incision',
      'drainageArea',
      'channel',
      'drainage',
    ] as const)
      expect(a[key]).toEqual(b[key]);
    expect(a.report.levels).toHaveLength(2);
    expect(a.report.levels.reduce((sum, l) => sum + l.durationYears, 0)).toBe(
      settings.durationYears,
    );
    expect(a.report.incisedVolumeM3).toBeGreaterThan(0);
    expect(a.report.upliftVolumeM3).toBeGreaterThan(0);
    expect(Math.abs(a.report.drainageAreaResidualM2)).toBeLessThan(1e-7);
    const budget =
      a.report.upliftVolumeM3 -
      a.report.incisedVolumeM3 +
      a.report.reconstructionVolumeM3 +
      a.report.hillslopeResidualM3;
    expect(Math.abs(a.report.finalVolumeChangeM3 - budget)).toBeLessThan(0.0001);
    expect(a.report.durationMs).toBeGreaterThan(0);
    expect(a.height.every(Number.isFinite)).toBe(true);
    expect(a.incision.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
    expect(a.channel.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)).toBe(true);
    expect(a.report.limitations.some((s) => s.includes('not outlet sediment export'))).toBe(true);
    for (let z = 0; z < a.rows; z++)
      for (let x = 0; x < a.width; x++) {
        if (x && z && x !== a.width - 1 && z !== a.rows - 1) continue;
        const i = z * a.width + x;
        expect(a.height[i]).toBe(a.sourceHeight[i]);
      }
  });

  it('has exact zero-effect identity after refinement and does not fill a flat world', async () => {
    for (const zero of [
      { ...settings, enabled: false },
      { ...settings, durationYears: 0 },
      { ...settings, upliftMeters: 0, faultThrowMeters: 0, erosionRate: 0, hillslopeRate: 0 },
    ]) {
      const result = await prepareGenesis(source, domain, 81, 19, zero);
      expect(result.height).toEqual(result.sourceHeight);
      expect(result.report.finalVolumeChangeM3).toBe(0);
      expect(result.uplift.every((v) => v === 0)).toBe(true);
      expect(result.incision.every((v) => v === 0)).toBe(true);
    }
    const flat = await prepareGenesis(() => 500, domain, 33, 19, {
      ...settings,
      upliftMeters: 0,
      faultThrowMeters: 0,
    });
    expect(flat.height.every((h) => h === 500)).toBe(true);
  });

  it('supports closed rectangular worlds with one internal terminal and no export claim', async () => {
    const result = await prepareGenesis(
      source,
      { ...domain, boundary: 'closed' },
      41,
      91,
      settings,
    );
    expect(result.report.outletCount).toBe(1);
    expect(result.report.maxDrainageAreaM2).toBeCloseTo(domain.width * domain.depth, 6);
    expect(result.report).not.toHaveProperty('exportedSedimentVolumeM3');
  });

  it('keeps allowed extreme forcing finite with an explicit volume ledger', async () => {
    const forced = await prepareGenesis(source, { ...domain, boundary: 'closed' }, 25, 91, {
      ...settings,
      durationYears: 2000000,
      upliftMeters: 10000,
      faultThrowMeters: -10000,
      erosionRate: 0.01,
      rainfall: 10,
      hillslopeRate: 100,
      hardnessContrast: 1,
      strataThicknessMeters: 1,
      strataDipDegrees: -80,
      foldAmplitudeMeters: 10000,
    });
    expect(forced.height.every(Number.isFinite)).toBe(true);
    expect(forced.hardness.every((h) => h >= 0 && h <= 1)).toBe(true);
    const budget =
      forced.report.upliftVolumeM3 -
      forced.report.incisedVolumeM3 +
      forced.report.reconstructionVolumeM3 +
      forced.report.hillslopeResidualM3;
    expect(Math.abs(forced.report.finalVolumeChangeM3 - budget)).toBeLessThan(0.001);
  });

  it('validates complete bounded report metadata before cache or CLI reuse', async () => {
    const { report } = await prepareGenesis(source, domain, 17, 3, settings);
    expect(isGenesisReport(report)).toBe(true);
    expect(isGenesisReport({ algorithmVersion: 'world-genesis-1' })).toBe(false);
    const missing = { ...report } as Partial<typeof report>;
    delete missing.levels;
    expect(isGenesisReport(missing)).toBe(false);
    for (const malformed of [
      { ...report, mode: 'native-8k' },
      { ...report, algorithmVersion: 'world-genesis-2' },
      { ...report, durationMs: NaN },
      { ...report, incisedVolumeM3: null },
      { ...report, width: 1 },
      { ...report, height: 1025 },
      { ...report, levels: [] },
      { ...report, levels: new Array(4).fill(report.levels[0]) },
      { ...report, levels: [{ ...report.levels[0], width: 2 }] },
      { ...report, levels: [{ ...report.levels[0], iterations: 65 }] },
      { ...report, limitations: [new Array(2050).fill('x').join('')] },
      { ...report, unexpected: [1, 2, 3] },
      { ...report, durationYears: 0 },
    ])
      expect(isGenesisReport(malformed)).toBe(false);
  });

  it('rejects bad sources and periodic worlds, and cancels without poisoning reuse', async () => {
    await expect(
      prepareGenesis(source, { ...domain, boundary: 'periodic' }, 33, 1, settings),
    ).rejects.toThrow(/periodic/);
    await expect(prepareGenesis(() => Infinity, domain, 33, 1, settings)).rejects.toThrow(
      /finite source/,
    );
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      prepareGenesis(source, domain, 33, 1, settings, { signal: aborted.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    const controller = new AbortController();
    await expect(
      prepareGenesis(source, domain, 97, 1, settings, {
        signal: controller.signal,
        onProgress: (fraction) => {
          if (fraction > 0) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    const recovered = await prepareGenesis(source, domain, 33, 1, settings);
    expect(recovered.height.every(Number.isFinite)).toBe(true);
    const final = new AbortController();
    await expect(
      prepareGenesis(source, domain, 17, 1, settings, {
        signal: final.signal,
        onProgress: (p) => {
          if (p === 1) final.abort();
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
