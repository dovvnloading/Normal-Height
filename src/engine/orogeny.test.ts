import { describe, expect, it } from 'vitest';
import { generateOrogenicRelief } from './orogeny';
import { evaluateGraph } from './index';
import { createProject } from '../model/presets';

const terrain = (n: number) => {
  const values = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = x / (n - 1), v = y / (n - 1);
    const envelope = Math.exp(-Math.pow((v - 0.49 + Math.sin(u * 7) * 0.07) / 0.34, 2));
    values[y * n + x] = 0.06 + 0.74 * envelope *
      (0.8 + 0.20 * Math.cos(u * 15) * Math.cos(v * 11));
  }
  return values;
};

const meanAbsoluteDifference = (a: Float32Array, b: Float32Array) => {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
};

describe('orogenic stream-network terrain source', () => {
  it('never mutates the uplift source and reproduces an identical seeded heightfield', () => {
    const n = 96, original = terrain(n), saved = original.slice();
    const first = generateOrogenicRelief(original, n, 1928);
    const repeat = generateOrogenicRelief(original, n, 1928);
    expect(first.height).toEqual(repeat.height);
    expect(first.drainage).toEqual(repeat.drainage);
    expect(original).toEqual(saved);
    expect(first.height.every(Number.isFinite)).toBe(true);
    expect(first.drainage.every(v => Number.isFinite(v) && v >= 0)).toBe(true);
    expect(Math.max(...first.drainage)).toBeGreaterThan(20);
    expect(meanAbsoluteDifference(original, first.height)).toBeGreaterThan(0.015);
  });

  it('does not generate fake mountains on flat input and has a true zero control', () => {
    const n = 64, flat = new Float32Array(n * n).fill(0.32);
    const result = generateOrogenicRelief(flat, n, 8);
    expect(result.height).toEqual(flat);
    expect(result.drainage.every(v => v === 0)).toBe(true);
    const sloped = terrain(n);
    expect(generateOrogenicRelief(sloped, n, 8, 0).height).toEqual(sloped);
  });

  it('changes headwater routing with seed without changing the regional elevation span', () => {
    const n = 128, initial = terrain(n);
    const a = generateOrogenicRelief(initial, n, 11);
    const b = generateOrogenicRelief(initial, n, 12);
    expect(meanAbsoluteDifference(a.height, b.height)).toBeGreaterThan(0.00001);
    for (const map of [a.height, b.height]) {
      const min = Math.min(...map), max = Math.max(...map);
      expect(max - min).toBeGreaterThan(0.30);
      expect(max - min).toBeLessThan(1.10);
    }
  });

  it('routes the new profile through the existing native graph without breaking classic range', () => {
    const project = createProject('alpine');
    project.resolution = 96;
    const source = project.graph.nodes.find(node => node.id === 'range')!;
    expect(source.params.profile).toBe('orogenic');
    const evolved = evaluateGraph(project, { resolution: 96, previewNodeId: 'range' }).field.height;
    source.params.profile = 'range';
    const classic = evaluateGraph(project, { resolution: 96, previewNodeId: 'range' }).field.height;
    expect(meanAbsoluteDifference(evolved, classic)).toBeGreaterThan(0.010);
    expect(evolved.every(Number.isFinite)).toBe(true);
    expect(classic.every(Number.isFinite)).toBe(true);
    source.params.profile = 'orogenic';
    source.params.dissection = 0;
    const zero = evaluateGraph(project, { resolution: 96, previewNodeId: 'range' }).field.height;
    expect(zero).toEqual(classic);
  });
});
