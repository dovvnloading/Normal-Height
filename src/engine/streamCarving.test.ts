import { describe, expect, it } from 'vitest';
import { carveConnectedValleys } from './streamCarving';

const sourceHeight = (n: number) => {
  const values = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = x / (n - 1), v = y / (n - 1);
    const ridge = Math.exp(-Math.pow(
      (v - 0.51 + Math.sin(u * 8.7) * 0.078) / 0.31, 2));
    values[y * n + x] = 0.06 + 0.72 * ridge *
      (0.75 + 0.25 * Math.cos(u * 11.2) * Math.cos(v * 7.1));
  }
  return values;
};
const fineRelief = (height: Float32Array, n: number) => {
  let total = 0;
  for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
    const i = y * n + x;
    const bankAverage = (height[i - n] + height[i + n] +
      height[i - 1] + height[i + 1]) * 0.25;
    total += Math.abs(height[i] - bankAverage);
  }
  return total / ((n - 2) * (n - 2));
};

describe('continuous dendritic valley construction', () => {
  it('makes geomorphological cuts instead of raised white stream branches', () => {
    const n = 192, input = sourceHeight(n);
    const output = carveConnectedValleys(input, n, 62, 1);
    const { height, incision, drainage, receiver } = output;
    let eligible = 0, totalBankDepth = 0, allLower = true;
    for (let y = 5; y < n - 5; y++) for (let x = 5; x < n - 5; x++) {
      const i = y * n + x, j = receiver[i];
      if (j < 0 || drainage[i] < 55 || incision[i] < 0.008) continue;
      const dy = Math.floor(j / n) - y, dx = j % n - x;
      const norm = Math.hypot(dx, dy);
      if (norm < 0.5) continue;
      const nx = -dy / norm, ny = dx / norm;
      const ax = Math.round(x + nx * 3), ay = Math.round(y + ny * 3);
      const bx = Math.round(x - nx * 3), by = Math.round(y - ny * 3);
      const a = ay * n + ax, b = by * n + bx;
      const bankIncision = 0.5 * (incision[a] + incision[b]);
      totalBankDepth += incision[i] - bankIncision;
      allLower &&= height[i] <= input[i] + 1e-7;
      eligible++;
    }
    expect(eligible).toBeGreaterThan(80);
    expect(allLower).toBe(true);
    // Cross-section correction removes the original slope; positive
    // center-to-bank incision means a real *valley*, not a white raised river.
    expect(totalBankDepth / eligible).toBeGreaterThan(0.005);
    expect(height.every(Number.isFinite)).toBe(true);
    expect(input.every(Number.isFinite)).toBe(true);
  });

  it('preserves a stable connected flow tree and adds resolved valley relief', () => {
    const n = 192, input = sourceHeight(n);
    const output = carveConnectedValleys(input, n, 72, 0.84);
    const same = carveConnectedValleys(input, n, 72, 0.84);
    expect(same.height).toEqual(output.height);
    expect(same.drainage).toEqual(output.drainage);
    expect(output.incision.some(v => v > 0.04)).toBe(true);
    expect(fineRelief(output.height, n)).toBeGreaterThan(fineRelief(input, n) * 3);
    for (let i = n + 1; i < n * n - n - 1; i += 37) {
      let j = i, steps = 0;
      while (output.receiver[j] >= 0 && steps < n * n) {
        j = output.receiver[j];
        steps++;
      }
      expect(steps).toBeLessThan(n * n);
      expect(j % n === 0 || j % n === n - 1 ||
        Math.floor(j / n) === 0 || Math.floor(j / n) === n - 1).toBe(true);
    }
  });

  it('keeps undisturbed source fields exact when strength=0 and on flat uplift', () => {
    const n = 64;
    const input = sourceHeight(n);
    const neutral = carveConnectedValleys(input, n, 33, 0);
    expect(neutral.height).toEqual(input);
    expect(neutral.incision.every(v => v === 0)).toBe(true);
    const flat = new Float32Array(n * n).fill(0.45);
    const blank = carveConnectedValleys(flat, n, 33, 1);
    expect(blank.height).toEqual(flat);
    expect(blank.incision.every(v => v === 0)).toBe(true);
  });
});
