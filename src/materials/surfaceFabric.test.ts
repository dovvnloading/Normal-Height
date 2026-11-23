import { describe, expect, it } from 'vitest';
import { resolveSurface } from './pbr';
import { fabricFrame, SurfaceFabric } from './surfaceFabric';

const seed = 48271;
const settings = resolveSurface();

function correlation(x: number[], y: number[]) {
  const mx = x.reduce((sum, value) => sum + value, 0) / x.length;
  const my = y.reduce((sum, value) => sum + value, 0) / y.length;
  let xx = 0,
    yy = 0,
    xy = 0;
  for (let i = 0; i < x.length; i++) {
    xx += (x[i] - mx) ** 2;
    yy += (y[i] - my) ** 2;
    xy += (x[i] - mx) * (y[i] - my);
  }
  return xy / Math.sqrt(xx * yy);
}

describe('procedural material morphology', () => {
  it.each(['alpine', 'arid', 'volcanic'] as const)(
    '%s endmembers have distinct relief patterns at the same coordinates',
    (biome) => {
      const fabric = new SurfaceFabric({ ...settings, biome }, seed, 2);
      const samples = [[], [], [], []] as number[][];
      for (let y = 0; y < 128; y++)
        for (let x = 0; x < 128; x++) {
          fabric.sample(2 * x, 2 * y, 210 + 0.62 * x + 0.28 * y, 0.31, 0.14);
          samples[0].push(fabric.rockHeight);
          samples[1].push(fabric.soilHeight);
          samples[2].push(fabric.plantHeight);
          samples[3].push(fabric.snowHeight);
        }
      // A shared noise texture reused with different gains gives |r| = 1.
      for (let i = 0; i < samples.length; i++)
        for (let j = i + 1; j < samples.length; j++)
          expect(Math.abs(correlation(samples[i], samples[j]))).toBeLessThan(0.8);
    },
  );

  it('cuts through different beds when a surface is translated vertically', () => {
    const fabric = new SurfaceFabric(settings, seed, 1.5);
    let total = 0;
    for (let x = 0; x < 180; x++) {
      const h = 200 + x * 0.66;
      fabric.sample(x, 50, h, 0.66, 0);
      const mineral = fabric.mineral,
        snow = fabric.snowHeight;
      fabric.sample(x, 50, h + 0.4 * settings.strataMeters, 0.66, 0);
      total += Math.abs(fabric.mineral - mineral);
      expect(fabric.snowHeight).toBe(snow);
    }
    expect(total / 180).toBeGreaterThan(0.08);
  });

  it('forms elongated snow tongues along the seeded wind axis', () => {
    const fabric = new SurfaceFabric(settings, seed, 1.5);
    const angle = fabricFrame(seed).azimuth;
    const u = Math.cos(angle),
      v = Math.sin(angle);
    let along = 0,
      across = 0;
    for (let y = 0; y < 256; y += 3)
      for (let x = 0; x < 256; x += 3) {
        fabric.sample(x, y, 0, 0, 0);
        const center = fabric.snowHeight;
        fabric.sample(x + u, y + v, 0, 0, 0);
        along += (fabric.snowHeight - center) ** 2;
        fabric.sample(x - v, y + u, 0, 0, 0);
        across += (fabric.snowHeight - center) ** 2;
      }
    expect(across / along).toBeGreaterThan(1.75);
  });
});
