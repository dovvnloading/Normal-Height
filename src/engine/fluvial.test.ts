import { describe, expect, it } from 'vitest';
import {
  accordUplands, evolveFluvialLandscape, FLUVIAL_DEFAULTS, fluvialLevels, planeFloodplains,
} from './fluvial';
import { accumulateDrainage, createDrainageWorkspace, routeDrainage } from './hydrology';
import { estimatedWorkingBytes, evaluateGraph, WORKING_MEMORY_BUDGET } from './index';
import { createProject } from '../model/presets';
import { createNode } from '../model/registry';

/** A broad, asymmetric uplift: a high upland falling to one corner. */
function upland(n: number): Float32Array {
  const field = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = x / (n - 1), v = y / (n - 1);
    field[y * n + x] = 0.2 + 0.7 * Math.exp(-((u - 0.45) ** 2 + (v - 0.4) ** 2) / 0.12) +
      0.08 * Math.sin(u * 7.3 + 1.1) * Math.cos(v * 5.9 - 0.4);
  }
  return field;
}

/** Steady-state core only: no finishing steps, so the stream-power law is exact. */
const coreOnly = {
  accordance: 0, dissectionDepth: 1, floodplain: 0, ridgeSoftening: 0,
} as const;

function interiorPits(z: Float32Array, n: number): number {
  let pits = 0;
  for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
    const i = y * n + x;
    let lower = false;
    for (let dy = -1; dy <= 1 && !lower; dy++) for (let dx = -1; dx <= 1; dx++)
      if ((dx || dy) && z[i + dy * n + dx] < z[i]) { lower = true; break; }
    if (!lower) pits++;
  }
  return pits;
}

function downsample(z: Float32Array, n: number, m: number): Float64Array {
  const out = new Float64Array(m * m), f = n / m;
  for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
    let sum = 0;
    for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) sum += z[(y * f + j) * n + x * f + i];
    out[y * m + x] = sum / (f * f);
  }
  return out;
}

function correlation(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; }
  ma /= a.length; mb /= b.length;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += (a[i] - ma) * (b[i] - mb); aa += (a[i] - ma) ** 2; bb += (b[i] - mb) ** 2;
  }
  return ab / Math.sqrt(aa * bb);
}

describe('fluvial uplands: uplift balanced by stream-power incision', () => {
  it('returns an exact copy at zero strength or for a flat field', () => {
    const source = upland(48);
    const zero = evolveFluvialLandscape(source, 48, { strength: 0, seed: 3 }).height;
    expect(zero).not.toBe(source);
    expect(Array.from(zero)).toEqual(Array.from(source));
    const flat = new Float32Array(48 * 48).fill(0.4);
    expect(Array.from(evolveFluvialLandscape(flat, 48, { strength: 1, seed: 3 }).height))
      .toEqual(Array.from(flat));
  });

  it('is deterministic per seed, varies between seeds, and never mutates its input', () => {
    const source = upland(64), copy = source.slice();
    const a = evolveFluvialLandscape(source, 64, { strength: 1, seed: 11 }).height;
    const b = evolveFluvialLandscape(source, 64, { strength: 1, seed: 11 }).height;
    const c = evolveFluvialLandscape(source, 64, { strength: 1, seed: 12 }).height;
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
    expect(Array.from(source)).toEqual(Array.from(copy));
    expect(a.every(Number.isFinite)).toBe(true);
  });

  it('forms trunk drainage coarse to fine, ending at the output resolution', () => {
    expect(fluvialLevels(1024)).toEqual([128, 256, 512, 1024]);
    expect(fluvialLevels(300)).toEqual([150, 300]);
    expect(fluvialLevels(100)).toEqual([100]);
  });

  it('drains every interior cell downhill at steady state (no pits)', () => {
    const n = 96;
    const result = evolveFluvialLandscape(upland(n), n, { strength: 1, seed: 5, ...coreOnly });
    expect(interiorPits(result.height, n)).toBe(0);
  });

  it('follows the stream-power slope–area law S ∝ U·A^−m along channels', () => {
    const n = 128, m = 0.5;
    const source = upland(n);
    const result = evolveFluvialLandscape(source, n, {
      strength: 1, seed: 9, concavity: m, lithology: 0, heterogeneity: 0, channelCells: 4,
      ...coreOnly,
    }).height;
    const workspace = routeDrainage(result, n, 9, createDrainageWorkspace(n));
    const area = accumulateDrainage(workspace, 1, 0);
    let low = Infinity, high = -Infinity;
    for (const v of source) { low = Math.min(low, v); high = Math.max(high, v); }
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i < n * n; i++) {
      const r = workspace.receiver[i];
      if (r < 0 || area[i] < 30) continue;
      const diagonal = i % n !== r % n && ((i / n) | 0) !== ((r / n) | 0);
      const slope = (result[i] - result[r]) / (diagonal ? Math.SQRT2 : 1);
      if (slope <= 0) continue;
      const uplift = 0.12 + 0.88 * (source[i] - low) / (high - low);
      xs.push(Math.log(area[i]));
      ys.push(Math.log(slope / uplift));
    }
    expect(xs.length).toBeGreaterThan(300);
    const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
    const my = ys.reduce((s, v) => s + v, 0) / ys.length;
    let num = 0, den = 0;
    for (let k = 0; k < xs.length; k++) { num += (xs[k] - mx) * (ys[k] - my); den += (xs[k] - mx) ** 2; }
    const theta = -num / den;
    expect(theta).toBeGreaterThan(m - 0.12);
    expect(theta).toBeLessThan(m + 0.12);
  });

  it('cuts channels below their interfluves', () => {
    const n = 128;
    const result = evolveFluvialLandscape(upland(n), n, { strength: 1, seed: 21 }).height;
    const workspace = routeDrainage(result, n, 21, createDrainageWorkspace(n));
    const area = accumulateDrainage(workspace, 1, 0);
    let below = 0, count = 0;
    for (let y = 5; y < n - 5; y++) for (let x = 5; x < n - 5; x++) {
      const i = y * n + x;
      if (area[i] < 200) continue;
      let sum = 0;
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) sum += result[i + dy * n + dx];
      below += sum / 81 - result[i];
      count++;
    }
    expect(count).toBeGreaterThan(50);
    expect(below / count).toBeGreaterThan(0.004);
  });

  it('keeps the broad structure consistent across resolutions', () => {
    const coarse = evolveFluvialLandscape(upland(128), 128, { strength: 1, seed: 4 }).height;
    const fine = evolveFluvialLandscape(upland(256), 256, { strength: 1, seed: 4 }).height;
    expect(correlation(downsample(coarse, 128, 32), downsample(fine, 256, 32))).toBeGreaterThan(0.85);
  });

  it('planes floodplains downward only: flat beside the river, untouched beyond the floor', () => {
    const n = 129, river = 64;
    const z = new Float64Array(n * n), area = new Float32Array(n * n).fill(1);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      z[y * n + x] = Math.abs(x - river) * 0.01 + (n - 1 - y) * 0.001;
      if (x === river) area[y * n + x] = 0.6 * (n - 1) * (n - 1);
    }
    const before = z.slice();
    planeFloodplains(z, n, area, 1, 7);
    let lowered = 0;
    for (let i = 0; i < z.length; i++) {
      expect(z[i]).toBeLessThanOrEqual(before[i] + 1e-12);
      if (z[i] < before[i] - 1e-9) lowered++;
    }
    expect(lowered).toBeGreaterThan(n);
    for (let y = 8; y < n - 8; y++) {
      const level = before[y * n + river];
      // One cell from the river: the floor sits within a cross-floor rise of it.
      expect(z[y * n + river + 1] - level).toBeLessThan(0.004);
      expect(z[y * n + river + 1]).toBeLessThan(before[y * n + river + 1]);
      expect(z[y * n + river + 20]).toBe(before[y * n + river + 20]);
    }
  });

  it('accords broad summits without touching lowlands or fine relief', () => {
    const n = 256;
    const z = new Float64Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const u = x / (n - 1), v = y / (n - 1);
      // ~3-cell gullies: far finer than the ~6-cell broad component.
      z[y * n + x] = Math.exp(-((u - 0.5) ** 2 + (v - 0.5) ** 2) / 0.05) +
        0.01 * Math.sin(x * 2.1) * Math.cos(y * 1.9);
    }
    const before = z.slice();
    accordUplands(z, n, 1);
    let unchanged = 0, maxBefore = -Infinity, maxAfter = -Infinity;
    for (let i = 0; i < z.length; i++) {
      expect(z[i]).toBeLessThanOrEqual(before[i] + 1e-12);
      if (z[i] === before[i]) unchanged++;
      maxBefore = Math.max(maxBefore, before[i]);
      maxAfter = Math.max(maxAfter, z[i]);
    }
    expect(unchanged).toBeGreaterThan(z.length * 0.5);
    expect(maxAfter).toBeLessThan(maxBefore - 0.2);
    // The change is smooth: the fine relief (each cell minus its 5×5 mean)
    // is kept almost exactly while the broad slope above the knee is reduced.
    const fine = (field: Float64Array, i: number) => {
      let sum = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) sum += field[i + dy * n + dx];
      return field[i] - sum / 25;
    };
    let worst = 0, amplitude = 0;
    for (let y = 2; y < n - 2; y++) for (let x = 2; x < n - 2; x++) {
      const i = y * n + x;
      worst = Math.max(worst, Math.abs(fine(z, i) - fine(before, i)));
      amplitude = Math.max(amplitude, Math.abs(fine(before, i)));
    }
    expect(amplitude).toBeGreaterThan(0.008);
    expect(worst).toBeLessThan(amplitude * 0.1);
  });
});

describe('Fluvial uplands landform in the terrain graph', () => {
  it('evaluates the reference-style preset; zero dissection is the classic range exactly', () => {
    const project = createProject('uplands');
    const source = project.graph.nodes.find((node) => node.id === 'range')!;
    expect(source.params.profile).toBe('fluvial');
    const formed = evaluateGraph(project, { resolution: 80, previewNodeId: 'range' }).field.height;
    source.params.profile = 'range';
    const classic = evaluateGraph(project, { resolution: 80, previewNodeId: 'range' }).field.height;
    source.params.profile = 'fluvial';
    source.params.dissection = 0;
    const zero = evaluateGraph(project, { resolution: 80, previewNodeId: 'range' }).field.height;
    expect(formed.every(Number.isFinite)).toBe(true);
    expect(Array.from(zero)).toEqual(Array.from(classic));
    let difference = 0;
    for (let i = 0; i < formed.length; i++) difference += Math.abs(formed[i] - classic[i]);
    expect(difference / formed.length).toBeGreaterThan(0.01);
    const output = evaluateGraph(createProject('uplands'), { resolution: 64 }).field.height;
    expect(output.every(Number.isFinite)).toBe(true);
  });

  it('keeps node defaults identical to the engine defaults', () => {
    const params = createNode('mountain', { x: 0, y: 0 }, 'm').params;
    expect(params.profile).toBe('fluvial');
    for (const [key, value] of Object.entries(FLUVIAL_DEFAULTS)) expect(params[key], key).toBe(value);
  });

  it('fits fluvial graphs up to 2048² inside the working-memory budget', () => {
    const project = createProject('uplands');
    const needed = new Set(project.graph.nodes.map((node) => node.id));
    for (const n of [512, 1024, 2048])
      expect(estimatedWorkingBytes(project.graph, needed, n)).toBeLessThanOrEqual(WORKING_MEMORY_BUDGET);
    // The transient solver set is still counted.
    expect(estimatedWorkingBytes(project.graph, needed, 1024))
      .toBeGreaterThan(64 * 1024 * 1024 + 13 * 1024 * 1024 * 4);
  });
});
