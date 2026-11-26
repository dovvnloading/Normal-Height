import { describe, expect, it } from 'vitest';
import { shapeNaturalContacts } from './materialContacts';
import { SurfaceFabric } from './surfaceFabric';
import { resolveSurface } from './pbr';

const neutral = { facies: 0, fleck: 0, clasts: 0, hummock: 0, straw: 0 };

describe('resolved substrate contacts', () => {
  it('preserves pure fills, absent layers, snow retention and normalized coverage', () => {
    for (const input of [[1,0,0,0], [0,1,0,0], [0,0,1,0], [0,0,0,1],
      [0.3,0.4,0,0.3], [0.12,0.27,0.34,0.27]]) {
      const weights = [...input];
      shapeNaturalContacts(weights, { facies: -1, fleck: 1, clasts: 1, hummock: 0, straw: 1 });
      expect(weights[3]).toBe(input[3]);
      expect(weights.reduce((sum, w) => sum + w, 0)).toBeCloseTo(1, 12);
      for (let i = 0; i < 4; i++) {
        expect(weights[i]).toBeGreaterThanOrEqual(0);
        expect(weights[i]).toBeLessThanOrEqual(1);
        if (input[i] === 0 || input[i] === 1) expect(weights[i]).toBe(input[i]);
      }
    }
  });

  it('sharpens the dominant substrate without introducing a hard boundary', () => {
    const weights = [0.58, 0.22, 0.15, 0.05];
    shapeNaturalContacts(weights, neutral);
    expect(weights[0]).toBeGreaterThan(0.58);
    expect(weights[1]).toBeGreaterThan(0.1);
    expect(weights[2]).toBeGreaterThan(0.05);
    const rock = [0.4,0.4,0.2,0], sediment = [...rock];
    shapeNaturalContacts(rock, { ...neutral, facies: 0.8 });
    shapeNaturalContacts(sediment, { ...neutral, facies: -0.8 });
    expect(rock[0]).toBeGreaterThan(sediment[0]);
    expect(rock[1]).toBeLessThan(sediment[1]);
  });

  it.each(['alpine','arid','volcanic'] as const)(
    '%s facies is seeded, spatially coherent and filtered when unresolved', biome => {
      const settings = { ...resolveSurface(), biome };
      const a = new SurfaceFabric(settings, 44, 2);
      const same = new SurfaceFabric(settings, 44, 4);
      const coarse = new SurfaceFabric(settings, 44, 96);
      const other = new SurfaceFabric(settings, 45, 2);
      let range = 0, delta = 0, seedDelta = 0;
      for (let x = 0; x < 512; x += 4) {
        a.sample(x, 41, 10, 0, 0);
        same.sample(x, 41, 10, 0, 0);
        coarse.sample(x, 41, 10, 0, 0);
        other.sample(x, 41, 10, 0, 0);
        const v = a.facies;
        expect(v).toBe(same.facies);
        expect(coarse.facies).toBe(0);
        range = Math.max(range, Math.abs(v));
        seedDelta += Math.abs(v - other.facies);
        a.sample(x + 0.25, 41, 10, 0, 0);
        delta = Math.max(delta, Math.abs(a.facies - v));
      }
      expect(range).toBeGreaterThan(0.12);
      expect(seedDelta / 128).toBeGreaterThan(0.04);
      expect(delta).toBeLessThan(0.08);
    },
  );
});
