import { describe, expect, it } from 'vitest';
import { STUDIO_DEFAULTS } from '../../model/noiseStudio';
import { createKernel } from './kernels';
import { broadenSpot, filteredEdgeMask } from './coverage';

describe('narrow feature footprint coverage', () => {
  it('the cellular border filter matches numerical box integration of the original profile', () => {
    const count = 4096;
    for (const width of [0.01, 0.07, 0.4])
      for (const footprint of [0.013, 0.1, 0.37]) {
        for (const distance of [0, 0.003, 0.037, 0.17, 0.41]) {
          let reference = 0;
          for (let i = 0; i < count; i++) {
            const x = distance + ((i + 0.5) / count - 0.5) * footprint;
            const t = Math.min(1, Math.abs(x) / width);
            reference += 1 - t * t * (3 - 2 * t);
          }
          expect(filteredEdgeMask(distance, width, footprint)).toBeCloseTo(reference / count, 6);
        }
      }
  });

  it('subpixel borders retain coverage rather than disappearing or expanding to opaque lines', () => {
    expect(filteredEdgeMask(0, 0.01, 0.2)).toBeCloseTo(0.05, 14);
    const n = createKernel(
      {
        ...STUDIO_DEFAULTS,
        kernel: 'cellular',
        cellularReturn: 'edge',
        cellularJitter: 0,
        cellularEdgeWidth: 0.01,
      },
      3,
    );
    // x=1 is an exact regular-grid cell border. Signed output represents 95%
    // interior coverage instead of an aliased black line occupying the pixel.
    expect(n.sample(1, 0.5, 0)).toBe(-1);
    expect(n.sample(1, 0.5, 0.2)).toBeCloseTo(0.9, 13);
  });

  it('spot broadening preserves integrated mass and adds the pixel second moment', () => {
    const radius = 0.047,
      power = 5,
      footprint = 0.17;
    const filtered = broadenSpot(radius, power, footprint);
    const integrate = (r: number, amplitude: number): { mass: number; variance: number } => {
      let mass = 0,
        moment = 0;
      const count = 8192,
        dr = r / count;
      for (let i = 0; i < count; i++) {
        const x = (i + 0.5) * dr,
          v = amplitude * Math.pow(1 - (x / r) ** 2, power);
        const weight = 2 * Math.PI * x * dr * v;
        mass += weight;
        moment += weight * x * x * 0.5;
      }
      return { mass, variance: moment / mass };
    };
    const source = integrate(radius, 1),
      result = integrate(filtered.radius, filtered.amplitude);
    expect(result.mass).toBeCloseTo(source.mass, 10);
    expect(result.variance - source.variance).toBeCloseTo((footprint * footprint) / 12, 9);
  });

  it('narrow sparse features keep their area and reduce subpixel translation flicker', () => {
    const n = createKernel(
      { ...STUDIO_DEFAULTS, kernel: 'sparse', spotRadius: 0.05, spotDensity: 1, spotSoftness: 0.5 },
      157,
    );
    let reference = 0;
    const fine = 384,
      extent = 4;
    for (let y = 0; y < fine; y++)
      for (let x = 0; x < fine; x++) {
        reference += 0.5 + 0.5 * n.sample(((x + 0.5) * extent) / fine, ((y + 0.5) * extent) / fine);
      }
    reference /= fine * fine;
    let pointError = 0,
      filteredError = 0;
    const coarse = 16,
      footprint = extent / coarse;
    for (const phase of [0.07, 0.23, 0.41, 0.59, 0.73, 0.91]) {
      let pointMean = 0,
        filteredMean = 0;
      for (let y = 0; y < coarse; y++)
        for (let x = 0; x < coarse; x++) {
          pointMean += 0.5 + 0.5 * n.sample((x + phase) * footprint, (y + phase) * footprint);
          filteredMean +=
            0.5 + 0.5 * n.sample((x + phase) * footprint, (y + phase) * footprint, footprint);
        }
      pointError += (pointMean / (coarse * coarse) - reference) ** 2;
      filteredError += (filteredMean / (coarse * coarse) - reference) ** 2;
    }
    expect(filteredError).toBeLessThan(pointError * 0.1);
  });
});
