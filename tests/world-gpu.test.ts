import { describe, expect, it } from 'vitest';
import { createPointwiseBackend, pointwiseCPU } from '../src/engine/gpu/pointwise';

describe('World f32 pointwise numerical contract', () => {
  it('keeps signed linear remapping and clamps only when authored', () => {
    const source = Float32Array.from([-1, 0, 0.25, 0.5, 1, 2]);
    const operation = { kind: 'remap' as const, contrast: 2, brightness: 0, gamma: 1, clamp: false };
    expect([...pointwiseCPU(operation, source)]).toEqual([-2.5, -0.5, 0, 0.5, 1.5, 3.5]);
    expect([...pointwiseCPU({ ...operation, clamp: true }, source)]).toEqual([0, 0, 0, 0.5, 1, 1]);
    expect([...source]).toEqual([-1, 0, 0.25, 0.5, 1, 2]);
  });
  it('defines terrace thresholds and symmetric band masks', () => {
    const stepped = pointwiseCPU({ kind: 'terrace', steps: 4, softness: 0.5 }, Float32Array.from([0, 0.125, 0.25, 0.375, 1, -0.125]));
    expect([...stepped]).toEqual([0, 0.125, 0.25, 0.375, 1, -0.125]);
    const source = Float32Array.from([0, 0.25, 0.5, 0.75, 1]);
    const mask = { kind: 'mask' as const, low: 0.25, high: 0.75, softness: 0.125, invert: false };
    expect([...pointwiseCPU(mask, source)]).toEqual([0, 0.5, 1, 0.5, 0]);
    expect([...pointwiseCPU({ ...mask, invert: true }, source)]).toEqual([1, 0.5, 0, 0.5, 1]);
  });
  it('uses one masked contribution for every supported blend mode', () => {
    const a = Float32Array.from([0.25, 0.5, 1]), b = Float32Array.from([1, 0.25, 0.5]);
    const mask = Float32Array.from([-1, 0.5, 2]);
    const expected = {
      mix: [0.25, 0.4375, 0.75], add: [0.25, 0.5625, 1.25],
      multiply: [0.25, 0.40625, 0.75], min: [0.25, 0.4375, 0.75], max: [0.25, 0.5, 1],
    };
    for (const mode of ['mix', 'add', 'multiply', 'min', 'max'] as const)
      expect([...pointwiseCPU({ kind: 'blend', mode, amount: 0.5 }, a, b, mask)]).toEqual(expected[mode]);
  });
  it('rejects malformed fields before dispatch or allocation', () => {
    const blend = { kind: 'blend' as const, mode: 'mix' as const, amount: 0.3 };
    expect(() => pointwiseCPU(blend, new Float32Array(1))).toThrow('second input');
    expect(() => pointwiseCPU(blend, new Float32Array(1), new Float32Array(2))).toThrow('sample counts');
    expect(() => pointwiseCPU(blend, Float32Array.of(NaN), new Float32Array(1))).toThrow('non-finite');
    expect(() => pointwiseCPU({ kind: 'remap', contrast: 1, brightness: 0, gamma: 0, clamp: false }, Float32Array.of(1))).toThrow('valid range');
  });
  it('keeps a usable CPU backend when WebGPU is absent', async () => {
    const backend = await createPointwiseBackend('cpu-reference');
    expect(backend.capability.backend).toBe('cpu-reference');
    expect(backend.capability.qualified).toBe(false);
    const a = Float32Array.of(0.2, 0.8);
    const result = await backend.apply({ kind: 'blend', mode: 'mix', amount: 0.5 }, a, Float32Array.of(0.8, 0.2));
    expect([...result.values]).toEqual([0.5, 0.5]);
    expect(result.values.buffer).not.toBe(a.buffer);
    backend.dispose();
  });
});
