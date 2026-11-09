import { describe, expect, it } from 'vitest';
import { sculptSpline } from '../src/engine/spline';
import { sampleHeight } from '../src/engine/erosion';
import { evaluateGraph, validateGraph } from '../src/engine';
import { DEFAULT_SPLINE_PATH, insertSplinePoint, sampleSpline } from '../src/model/splines';
import { createNode } from '../src/model/registry';
import { createProject } from '../src/model/presets';
import { parseProject } from '../src/model/project';

const river = {
  mode: 'river' as const, width: 0.024, strength: 0.15, falloff: 3, downhill: true,
};
const ridge = { ...river, mode: 'ridge' as const };
const diagonal = [{ x: 0.1, y: 0.1 }, { x: 0.46, y: 0.54 }, { x: 0.92, y: 0.89 }];
const constant = (n: number, height = 0.6) => new Float32Array(n * n).fill(height);
const at = (height: Float32Array, n: number, p: { x: number; y: number }) =>
  sampleHeight(height, n, p.x * (n - 1), p.y * (n - 1));

describe('non-destructive spline terrain authoring', () => {
  it('passes through control points smoothly and inserts into the closest path span', () => {
    const samples = sampleSpline(diagonal, 40);
    expect(samples[0]).toEqual(diagonal[0]);
    expect(samples.at(-1)).toEqual(diagonal.at(-1));
    expect(samples[40]).toEqual(diagonal[1]);
    for (let i = 1; i < samples.length; i++) {
      expect(Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y))
        .toBeLessThan(0.036);
    }
    const inserted = insertSplinePoint(diagonal, { x: 0.25, y: 0.25 });
    expect(inserted).toHaveLength(4);
    expect(inserted[1]).toEqual({ x: 0.25, y: 0.25 });
    expect(diagonal).toHaveLength(3);
  });

  it('carves river channels and smooth valley banks without changing distant heights', () => {
    const n = 128, before = constant(n);
    const after = sculptSpline(before, n, diagonal, river);
    expect(after.every(Number.isFinite)).toBe(true);
    expect(after).not.toEqual(before);
    expect(at(after, n, diagonal[1])).toBeLessThan(0.55);
    expect(Math.abs(after[0] - before[0])).toBe(0);
    expect(Math.abs(after[n * 80 + 8] - before[n * 80 + 8])).toBe(0);
    // Smooth shoulders: adjacent pixels near a channel do not form sharp steps.
    let maximumStep = 0;
    for (let y = 5; y < n - 5; y++)
      for (let x = 5; x < n - 5; x++) {
        const i = y * n + x;
        maximumStep = Math.max(maximumStep, Math.abs(after[i] - after[i + 1]));
      }
    expect(maximumStep).toBeLessThan(0.14);
    expect(before.every((h) => Math.abs(h - 0.6) < 1e-6)).toBe(true);
  });

  it('raises a ridge, does not build overlapping bumps at controls, and preserves outer pixels', () => {
    const n = 128, before = constant(n, 0.4);
    const after = sculptSpline(before, n, diagonal, ridge);
    expect(at(after, n, diagonal[1])).toBeGreaterThan(0.53);
    expect(after[0]).toBeCloseTo(0.4);
    expect(after.every((height) => height >= 0.4 && height <= 0.551)).toBe(true);
    const interpolated = sampleSpline(diagonal, 22);
    const centerHeights = interpolated.map((p) => at(after, n, p));
    expect(Math.max(...centerHeights) - Math.min(...centerHeights)).toBeLessThan(0.013);
  });

  it('enforces downstream river grade, never deposits, and accepts reverse flow deliberately', () => {
    const n = 128, input = new Float32Array(n * n);
    // Underlying terrain climbs toward the outlet. A designed river must cut
    // through that topographic high instead of flowing uphill.
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) input[y * n + x] = 0.3 + 0.4 * (x / (n - 1));
    const path = [{ x: 0.12, y: 0.5 }, { x: 0.45, y: 0.5 }, { x: 0.86, y: 0.5 }];
    const cut = sculptSpline(input, n, path, { ...river, width: 0.035, strength: 0.08 });
    const samples = sampleSpline(path, 10);
    const center = samples.map((p) => at(cut, n, p));
    for (let i = 1; i < center.length; i++) expect(center[i]).toBeLessThanOrEqual(center[i - 1] + 0.005);
    for (let i = 0; i < cut.length; i++) expect(cut[i]).toBeLessThanOrEqual(input[i]);
    const free = sculptSpline(input, n, path, { ...river, downhill: false });
    expect(at(free, n, path.at(-1)!)).toBeGreaterThan(at(cut, n, path.at(-1)!) + 0.2);
  });

  it('keeps path influence approximately resolution-independent and returns unmodified input when strength is zero', () => {
    const sample = (n: number) => {
      const before = constant(n);
      return sculptSpline(before, n, diagonal, river);
    };
    const a = sample(96), b = sample(192);
    for (const point of [...diagonal, { x: 0.3, y: 0.4 }, { x: 0.2, y: 0.7 }])
      expect(Math.abs(at(a, 96, point) - at(b, 192, point))).toBeLessThan(0.012);
    expect(sculptSpline(a, 96, diagonal, { ...river, strength: 0 })).toEqual(a);
  });

  it('preserves spline geometry through project JSON and validates malformed points', () => {
    const project = createProject();
    const node = createNode('spline', { x: 420, y: 100 }, 'river');
    expect(node.path).toEqual(DEFAULT_SPLINE_PATH);
    project.graph.nodes.push(node);
    const saved = JSON.stringify(project);
    const restored = parseProject(JSON.parse(saved));
    expect(restored.graph.nodes.at(-1)?.path).toEqual(node.path);
    const invalid = structuredClone(project);
    invalid.graph.nodes.at(-1)!.path![0].x = 1.5;
    expect(() => parseProject(invalid)).toThrow(/Spline paths/);
    expect(validateGraph(invalid.graph)).toMatch(/valid spline points/);
    invalid.graph.nodes.at(-1)!.path = [{ x: 0, y: 0 }];
    expect(() => parseProject(invalid)).toThrow(/Spline paths/);
  });

  it('evaluates spline stages through the connected graph, including bypass and final output', () => {
    const project = createProject();
    const stage = createNode('spline', { x: 405, y: 100 }, 'spline');
    stage.path = diagonal;
    project.graph.nodes.push(stage);
    const upstream = project.graph.edges.find((edge) => edge.target === 'erosion')!;
    upstream.target = stage.id;
    project.graph.edges.push({
      id: 'spline-erosion', source: stage.id, target: 'erosion',
      sourceHandle: 'height', targetHandle: 'in',
    });
    const pre = evaluateGraph(project, { resolution: 48, previewNodeId: 'warp' });
    const edited = evaluateGraph(project, { resolution: 48, previewNodeId: 'spline' });
    expect(edited.field.height).not.toEqual(pre.field.height);
    expect(edited.field.height.every(Number.isFinite)).toBe(true);
    const repeat = evaluateGraph(project, { resolution: 48, previewNodeId: 'spline' });
    expect(repeat.field.height).toEqual(edited.field.height);
    stage.bypassed = true;
    const skipped = evaluateGraph(project, { resolution: 48, previewNodeId: 'spline' });
    expect(skipped.field.height).toEqual(pre.field.height);
    stage.bypassed = false;
    const final = evaluateGraph(project, { resolution: 48 });
    expect(final.field.height.every(Number.isFinite)).toBe(true);
    expect(final.outputNodeId).toBe('output');
  });
});
