import { describe, expect, it } from 'vitest';
import { deriveSeed, STUDIO_DEFAULTS, type StudioSettings } from '../../model/noiseStudio';
import { createFractal } from './fractal';
import FastNoiseLite, { NoiseType } from './vendor/FastNoiseLite';

type Point = readonly [number, number];
const bounded = (x: number) => Math.min(1, Math.max(0, x));
function rotate([x, y]: Point, radians: number): Point {
  return [
    x * Math.cos(radians) - y * Math.sin(radians),
    x * Math.sin(radians) + y * Math.cos(radians),
  ];
}

/**
 * Independent recurrence oracle: use only the pinned vendor's scalar Perlin
 * implementation and central differences, never the engine's gradient,
 * kernel factory, layer construction, statistics, or coordinate helpers.
 *
 * Swiss follows de Carpentier's ridged/height-feedback recurrence. Jordan
 * verifies the documented Studio adaptation with shared distortion, bounded
 * d/(1+d) damping, fractional octave weights, and common-frame guidance.
 * Filtering is intentionally off: this checks the underlying recurrence,
 * rather than duplicating the separate footprint/moment approximations.
 */
function recurrenceReference(
  settings: StudioSettings,
  seed: number,
  step = 1e-5,
  brokenJordanFrame = false,
) {
  const layers = Array.from({ length: Math.ceil(settings.octaves) }, (_, octave) => {
    const noise = new FastNoiseLite((octave === 0 ? seed : deriveSeed(seed, 101, octave)) | 0);
    noise.SetNoiseType(NoiseType.Perlin);
    noise.SetFrequency(1);
    return {
      value: (x: number, y: number) => noise.GetNoise(x, y),
      fraction: Math.min(1, settings.octaves - octave),
      authoredAmplitude: settings.persistence ** octave,
      frequency: settings.lacunarity ** octave,
      angle: (octave * settings.octaveRotation * Math.PI) / 180,
    };
  });
  const denominator = layers.reduce(
    (total, layer) => total + layer.authoredAmplitude * layer.fraction,
    0,
  );
  return (origin: Point): number => {
    let result = 0,
      swissAmplitude = 1,
      detailFeedback = 1;
    let guidance: Point = [0, 0],
      slope: Point = [0, 0];
    for (let octave = 0; octave < layers.length; octave++) {
      const layer = layers[octave];
      if (layer.authoredAmplitude === 0) continue;
      let query: Point;
      if (settings.fractal === 'swiss') {
        query = rotate(
          [
            (origin[0] + settings.derivativeWarp * guidance[0]) * layer.frequency,
            (origin[1] + settings.derivativeWarp * guidance[1]) * layer.frequency,
          ],
          layer.angle,
        );
      } else if (brokenJordanFrame) {
        const point = rotate(
          [origin[0] * layer.frequency, origin[1] * layer.frequency],
          layer.angle,
        );
        query = [point[0] + guidance[0], point[1] + guidance[1]];
      } else {
        query = rotate(
          [origin[0] * layer.frequency + guidance[0], origin[1] * layer.frequency + guidance[1]],
          layer.angle,
        );
      }
      const [u, v] = query;
      const value = layer.value(u, v);
      const localGradient: Point = [
        (layer.value(u + step, v) - layer.value(u - step, v)) / (2 * step),
        (layer.value(u, v + step) - layer.value(u, v - step)) / (2 * step),
      ];
      const gradient = rotate(localGradient, -layer.angle);
      if (settings.fractal === 'swiss') {
        const contribution = layer.fraction * swissAmplitude * detailFeedback;
        result += contribution * (1 - Math.abs(value));
        guidance = [
          guidance[0] - contribution * value * gradient[0],
          guidance[1] - contribution * value * gradient[1],
        ];
        swissAmplitude *= settings.persistence * bounded(result);
      } else {
        const dampingStrength = settings.derivativeDamping / (1 + settings.derivativeDamping);
        const damping =
          octave === 0 ? 1 : 1 - dampingStrength / (1 + slope[0] ** 2 + slope[1] ** 2);
        result += layer.authoredAmplitude * layer.fraction * detailFeedback * damping * value ** 2;
        const weightedGradient: Point = [value * gradient[0], value * gradient[1]];
        guidance = [
          guidance[0] + settings.derivativeWarp * weightedGradient[0],
          guidance[1] + settings.derivativeWarp * weightedGradient[1],
        ];
        slope = [slope[0] + weightedGradient[0], slope[1] + weightedGradient[1]];
      }
      detailFeedback *=
        1 - settings.weightedStrength + settings.weightedStrength * bounded((value + 1) / 2);
    }
    return bounded(result / denominator);
  };
}

const coordinates: Point[] = [
  [0.317, -0.891],
  [-3.7, 4.5],
  [2, -1],
  [-0.00001, 0.00003],
  [0, 0],
];

describe('derivative fractals against independent scalar-noise recurrences', () => {
  for (const fractal of ['swiss', 'jordan'] as const) {
    for (const seed of [0, 0xffffffff]) {
      it(`${fractal} agrees at rotated, fractional octaves with seed ${seed}`, () => {
        const settings: StudioSettings = {
          ...STUDIO_DEFAULTS,
          kernel: 'perlin',
          fractal,
          octaves: 4.35,
          octaveRotation: 47,
          lacunarity: 2.2,
          persistence: 0.67,
          derivativeWarp: 0.32,
          derivativeDamping: 1.6,
          weightedStrength: 0.3,
        };
        const actual = createFractal(settings, seed),
          reference = recurrenceReference(settings, seed);
        for (const point of coordinates) {
          expect(actual.sample(point[0], point[1], 0)).toBeCloseTo(reference(point), 7);
        }
      });
    }
  }

  it('preserves Swiss height-dependent amplitude feedback when distortion is disabled', () => {
    const settings: StudioSettings = {
      ...STUDIO_DEFAULTS,
      kernel: 'perlin',
      fractal: 'swiss',
      octaves: 5.7,
      octaveRotation: -73,
      lacunarity: 1.8,
      persistence: 0.81,
      derivativeWarp: 0,
      weightedStrength: 0,
    };
    const actual = createFractal(settings, 9721),
      reference = recurrenceReference(settings, 9721);
    for (const point of coordinates)
      expect(actual.sample(...point, 0)).toBeCloseTo(reference(point), 12);
  });

  it('reduces Jordan to authored squared-noise layers when distortion and damping are zero', () => {
    const settings: StudioSettings = {
      ...STUDIO_DEFAULTS,
      kernel: 'perlin',
      fractal: 'jordan',
      octaves: 3.25,
      octaveRotation: -29,
      lacunarity: 2.35,
      persistence: 0.43,
      derivativeWarp: 0,
      derivativeDamping: 0,
      weightedStrength: 0,
    };
    const actual = createFractal(settings, 4981),
      reference = recurrenceReference(settings, 4981);
    for (const point of coordinates)
      expect(actual.sample(...point, 0)).toBeCloseTo(reference(point), 12);
  });

  it('catches applying common-frame Jordan guidance directly in rotated local coordinates', () => {
    const settings: StudioSettings = {
      ...STUDIO_DEFAULTS,
      kernel: 'perlin',
      fractal: 'jordan',
      octaves: 4.75,
      octaveRotation: 67,
      lacunarity: 2.1,
      persistence: 0.62,
      derivativeWarp: 0.7,
      derivativeDamping: 1.3,
      weightedStrength: 0.2,
    };
    const point: Point = [0.317, -0.891],
      seed = 0xffffffff;
    const correct = recurrenceReference(settings, seed)(point);
    const incorrect = recurrenceReference(settings, seed, 1e-5, true)(point);
    expect(Math.abs(correct - incorrect)).toBeGreaterThan(1e-4);
    expect(createFractal(settings, seed).sample(...point, 0)).toBeCloseTo(correct, 7);
  });

  it('keeps the numerical oracle stable when its differentiation step is halved', () => {
    for (const fractal of ['swiss', 'jordan'] as const) {
      const settings: StudioSettings = {
        ...STUDIO_DEFAULTS,
        kernel: 'perlin',
        fractal,
        octaves: 4.6,
        octaveRotation: 38,
        derivativeWarp: 0.4,
        derivativeDamping: 2,
      };
      const fullStep = recurrenceReference(settings, 2741, 1e-5);
      const halfStep = recurrenceReference(settings, 2741, 5e-6);
      for (const point of coordinates) expect(fullStep(point)).toBeCloseTo(halfStep(point), 7);
    }
  });
});
