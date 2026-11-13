import { expect, it } from 'vitest';
import { sampleGrid } from './viewportUX';

it('physical comparison is zero for identical fields, regardless of sampling resolution', () => {
  const source = Float32Array.from([0, 0.5, 0.5, 1]);
  const baseline = Float32Array.from([
    0, 0.25, 0.5,
    0.25, 0.5, 0.75,
    0.5, 0.75, 1,
  ]);
  for (let y = 0; y <= 4; y++) for (let x = 0; x <= 4; x++) {
    const uv = { u: x / 4, v: y / 4 };
    expect(sampleGrid(source, 2, uv) - sampleGrid(baseline, 3, uv)).toBeCloseTo(0);
  }
});
