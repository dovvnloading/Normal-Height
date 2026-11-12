import { describe, expect, it } from 'vitest';
import { createHillslopeWorkspace, relaxLayeredHillslope } from './hillslope';

function stair(n: number): Float32Array {
  const values = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++)
    values[y * n + x] = x < n / 2 ? 0.92 : 0.12;
  return values;
}

const sum = (data: Float32Array): number =>
  data.reduce((total, value) => total + value, 0);

describe('layered, conservative hillslope relaxation', () => {
  it('cannot move fully resistant bedrock when the terrain has no mobile cover', () => {
    const n = 16, original = stair(n), height = original.slice();
    const mobile = new Float32Array(n * n), bedrock = height.slice();
    const work = createHillslopeWorkspace(n * n);
    for (let i = 0; i < 8; i++)
      relaxLayeredHillslope(height, mobile, bedrock, n,
        0.02, 0.2, 0, -0.5, undefined, work);
    expect(height).toEqual(original);
    expect(mobile.every(value => value === 0)).toBe(true);
    expect(bedrock).toEqual(original);
  });

  it('redistributes loose sediment without destroying resistant underlying rock', () => {
    const n = 16, original = stair(n), height = original.slice();
    const mobile = new Float32Array(n * n).fill(0.25);
    const bedrock = height.map((value) => value - 0.25);
    const before = sum(height), rockBefore = bedrock.slice();
    relaxLayeredHillslope(height, mobile, bedrock, n,
      0.02, 0.2, 0, -0.5, undefined, createHillslopeWorkspace(n * n));
    expect(height).not.toEqual(original);
    expect(bedrock).toEqual(rockBefore);
    expect(Math.abs(sum(height) - before)).toBeLessThan(2e-5);
    for (let i = 0; i < height.length; i++) {
      expect(mobile[i]).toBeGreaterThanOrEqual(0);
      expect(Math.abs(height[i] - (mobile[i] + bedrock[i]))).toBeLessThan(1e-7);
    }
  });

  it('weathers softer rock but conserves the solid material and respects zero masks', () => {
    const n = 16, original = stair(n), height = original.slice();
    const mobile = new Float32Array(n * n), bedrock = height.slice();
    const before = sum(height);
    const workspace = createHillslopeWorkspace(n * n);
    const blocked = new Float32Array(n * n);
    relaxLayeredHillslope(height, mobile, bedrock, n,
      0.02, 0.2, 0.7, -0.5, blocked, workspace);
    expect(height).toEqual(original);
    relaxLayeredHillslope(height, mobile, bedrock, n,
      0.02, 0.2, 0.7, -0.5, undefined, workspace);
    expect(height).not.toEqual(original);
    expect(Math.abs(sum(height) - before)).toBeLessThan(2e-5);
    expect(mobile.some(v => v > 0)).toBe(true);
  });

  it('caps extreme hillslope strength to avoid reversing the local terrain gradient', () => {
    const n = 9, height = new Float32Array(n * n).fill(0.12);
    const center = 4 * n + 4;
    height[center] = 0.92;
    const initial = height.slice(), before = sum(height);
    const mobile = new Float32Array(n * n).fill(2);
    const bedrock = height.map(v => v - 2);
    relaxLayeredHillslope(height, mobile, bedrock, n,
      0, 9, 1, -10, undefined, createHillslopeWorkspace(n * n));
    expect(height[center]).toBeGreaterThan(Math.max(
      height[center - 1], height[center + 1],
      height[center - n], height[center + n],
    ));
    expect(height[center]).toBeLessThan(initial[center]);
    expect(Math.abs(sum(height) - before)).toBeLessThan(2e-5);
  });

  it('remains unchanged on a planar slope below repose, even with loose soil', () => {
    const n = 16, height = new Float32Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++)
      height[y * n + x] = 0.3 + 0.001 * (x + y);
    const original = height.slice();
    const mobile = new Float32Array(n * n).fill(0.1);
    const bedrock = height.map(value => value - 0.1);
    relaxLayeredHillslope(height, mobile, bedrock, n,
      0.01, 0.5, 1, -1, undefined, createHillslopeWorkspace(n * n));
    expect(height).toEqual(original);
  });
});
