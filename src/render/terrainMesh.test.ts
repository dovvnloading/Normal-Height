import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createProject } from '../model/presets';
import type { HeightField } from '../model/types';
import { buildGroundApron, TERRAIN_SIZE } from './GroundExtension';
import {
  adaptiveTerrainGeometrySteps, advanceWithinBudget, buildAdaptiveTerrainGeometry,
  createTerrainSampler, MESH_VERTEX_BUDGET, planTerrainMesh, planUniform512Reference, prefilterHeights,
  runToCompletion, TERRAIN_TILES,
} from './terrainMesh';
import type { TerrainMeshPlan, TerrainSampler } from './terrainMesh';

const field = (n: number, fn: (x: number, y: number) => number): HeightField => {
  const height = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++)
    height[y * n + x] = fn(x / (n - 1), y / (n - 1));
  return { resolution: n, height,
    flow: new Float32Array(n * n), wear: new Float32Array(n * n),
    deposition: new Float32Array(n * n),
  };
};

const fixedPlan = (segments: number[]): TerrainMeshPlan => ({
  segments, key: segments.join(','),
  vertexCount: segments.reduce((total, s) => total + (s + 1) ** 2, 0),
  triangleCount: segments.reduce((total, s) => total + 2 * s * s, 0),
  maxSegments: Math.max(...segments),
});

describe('physically faithful heightfield reconstruction', () => {
  it('exactly reproduces planes and continuous, physical slope normals at the border', () => {
    const map = field(33, (u, v) => 0.24 + 0.43 * u - 0.19 * v);
    const sampler = createTerrainSampler(map.height, 33, 1800, 6000);
    for (const u of [0, 0.01, 0.17, 0.49, 0.83, 0.99, 1])
      for (const v of [0, 0.04, 0.23, 0.54, 0.88, 1]) {
        expect(sampler.height(u, v)).toBeCloseTo(0.24 + 0.43 * u - 0.19 * v, 5);
        const actual = sampler.normal(u, v);
        const expected = new THREE.Vector3(-0.43 * 1800 / 6000, 1,
          0.19 * 1800 / 6000).normalize();
        expect(actual[0]).toBeCloseTo(expected.x, 5);
        expect(actual[1]).toBeCloseTo(expected.y, 5);
        expect(actual[2]).toBeCloseTo(expected.z, 5);
      }
  });

  it('does not overshoot spikes or erase the original Float32 heightfield', () => {
    const map = field(33, (u, v) =>
      u > 0.5 && v > 0.5 ? 0.91 : 0.13);
    const copy = map.height.slice();
    const sampler = createTerrainSampler(map.height, 33, 1900, 8000);
    for (let j = 0; j <= 150; j++)
      for (let i = 0; i <= 150; i++) {
        const u = i / 150, v = j / 150;
        const value = sampler.height(u, v);
        expect(value).toBeGreaterThanOrEqual(0.13 - 1e-6);
        expect(value).toBeLessThanOrEqual(0.91 + 1e-6);
        expect(sampler.normal(u, v).every(Number.isFinite)).toBe(true);
      }
    expect(map.height).toEqual(copy);
  });
});

describe('budgeted camera-adaptive terrain mesh', () => {
  const simpleSampler: TerrainSampler = {
    resolution: 1024,
    height: (u, v) => 0.4 + 0.1 * u - 0.06 * v,
    normal: () => [0, 1, 0],
  };
  const camera = (x: number, y: number, z: number) => {
    const cam = new THREE.PerspectiveCamera(36, 1.5, 0.002, 40);
    cam.position.set(x, y, z);
    cam.lookAt(0, 0.35, 0);
    cam.updateMatrixWorld();
    return cam;
  };
  it('spends more vertices near the camera while respecting each quality budget', () => {
    const far = planTerrainMesh(simpleSampler, camera(0, 5, 9), 860, 1.5,
      1800, 8000, 1, 'high');
    const near = planTerrainMesh(simpleSampler, camera(0, 0.4, 0.45), 860, 1.5,
      1800, 8000, 1, 'high');
    const ultra = planTerrainMesh(simpleSampler, camera(0, 0.4, 0.45), 860, 1.5,
      1800, 8000, 1, 'ultra');
    expect(near.vertexCount).toBeGreaterThan(far.vertexCount);
    expect(near.maxSegments).toBeGreaterThan(far.maxSegments);
    expect(near.vertexCount).toBeLessThanOrEqual(MESH_VERTEX_BUDGET.high);
    expect(ultra.vertexCount).toBeLessThanOrEqual(MESH_VERTEX_BUDGET.ultra);
    expect(ultra.vertexCount).toBeGreaterThanOrEqual(near.vertexCount);
    expect(near.segments.some((value) => value < near.maxSegments)).toBe(true);
    expect(planTerrainMesh(simpleSampler, camera(0, 0.4, 0.45), 860, 1.5,
      1800, 8000, 1, 'high')).toEqual(near);
  });

  it('offers a reproducible uniform reference for matched-camera hardware benchmarks', () => {
    const reference = planUniform512Reference();
    expect(reference.maxSegments).toBe(64);
    expect(reference.vertexCount).toBe(8 * 8 * 65 * 65);
    expect(reference.triangleCount).toBe(8 * 8 * 2 * 64 * 64);
    expect(reference.segments.every(value => value === 64)).toBe(true);
    expect(reference).toEqual(planUniform512Reference());
  });

  it('keeps mesh density stable across small camera motion, then downgrades when far away', () => {
    const near = planTerrainMesh(simpleSampler, camera(0, 0.4, 0.45),
      860, 1.5, 1800, 8000, 1, 'high');
    const drift = planTerrainMesh(simpleSampler, camera(0, 0.4, 0.455),
      860, 1.5, 1800, 8000, 1, 'high', near);
    expect(drift.key).toBe(near.key);
    const far = planTerrainMesh(simpleSampler, camera(0, 6, 10),
      860, 1.5, 1800, 8000, 1, 'high', near);
    expect(far.vertexCount).toBeLessThan(near.vertexCount);
    expect(far.maxSegments).toBeLessThan(near.maxSegments);
  });

  it('stitches unequal-resolution borders without cracks or differing border normals', () => {
    const n = 33, source = field(n, (u, v) =>
      0.42 + 0.17 * u + 0.2 * v + 0.09 * Math.sin(u * 16) * Math.cos(v * 9));
    const sampler = createTerrainSampler(source.height, n, 1400, 4000);
    const segments = new Array<number>(TERRAIN_TILES ** 2).fill(16);
    segments[0] = 64;
    const geometry = buildAdaptiveTerrainGeometry(sampler, fixedPlan(segments), 1400, 4000);
    const positions = geometry.getAttribute('position');
    const normals = geometry.getAttribute('normal');
    const first = 0, second = (64 + 1) ** 2;
    for (let y = 0; y <= 64; y++) {
      const high = first + y * 65 + 64;
      const step = y / 4, k = Math.floor(step), f = step - k;
      const low0 = second + Math.min(k, 16) * 17;
      const low1 = second + Math.min(k + 1, 16) * 17;
      const expected = positions.getY(low0) * (1 - f) + positions.getY(low1) * f;
      expect(positions.getY(high)).toBeCloseTo(expected, 5);
      // Fine-edge normals must match the interpolation of coarse-edge
      // normals even between shared vertices (no lighting seams).
      for (let axis = 0; axis < 3; axis++) {
        const expectedNormal = normals.getComponent(low0, axis) * (1 - f) +
          normals.getComponent(low1, axis) * f;
        expect(normals.getComponent(high, axis)).toBeCloseTo(expectedNormal, 5);
      }
    }
    expect(geometry.index!.count).toBe(fixedPlan(segments).triangleCount * 3);
    geometry.dispose();
  });

  it('uses the exact adaptive mesh outline for skirts and meadow-apron geometry', () => {
    const map = field(33, (u, v) =>
      0.31 + u * 0.2 + v * 0.26 + 0.03 * Math.cos(15 * u));
    const sampler = createTerrainSampler(map.height, map.resolution, 2000, 5000);
    const segments = new Array<number>(TERRAIN_TILES ** 2).fill(16);
    segments[0] = 64; segments[7] = 32; segments[56] = 32;
    const geometry = buildAdaptiveTerrainGeometry(sampler, fixedPlan(segments), 2000, 5000);
    const perimeter = geometry.userData.nhPerimeterIndices as number[];
    const positions = geometry.getAttribute('position');
    const project = createProject();
    project.heightScale = 2000; project.worldSize = 5000;
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
    const apron = buildGroundApron(map, project, 1.7, -0.1, TERRAIN_SIZE * 5, mesh);
    const apronPositions = apron.getAttribute('position');
    expect(apron.userData.edgeVertexCount).toBe(perimeter.length);
    expect(perimeter.length).toBeGreaterThan(8 * 16 * 4);
    for (let i = 0; i < perimeter.length; i++) {
      const j = perimeter[i];
      expect(apronPositions.getX(i)).toBeCloseTo(positions.getX(j), 5);
      expect(apronPositions.getY(i)).toBeCloseTo(positions.getY(j) * 1.7, 5);
      expect(apronPositions.getZ(i)).toBeCloseTo(positions.getZ(j), 5);
    }
    apron.dispose(); geometry.dispose(); mesh.material.dispose();
  });
});

/**
 * The original, closure-based sampler (PR #33). The production sampler reads
 * interior texels directly for speed; it must return exactly these values.
 */
function referenceSampler(height: Float32Array, n: number, heightScale: number, worldSize: number) {
  const clamp01 = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
  const slope = (left: number, right: number) =>
    left * right <= 0 ? 0 : (2 * left * right) / (left + right);
  const cubic = (p0: number, p1: number, p2: number, p3: number, t: number) => {
    const t2 = t * t, t3 = t2 * t;
    const m1 = slope(p1 - p0, p2 - p1), m2 = slope(p2 - p1, p3 - p2);
    return (2 * t3 - 3 * t2 + 1) * p1 + (t3 - 2 * t2 + t) * m1 +
      (-2 * t3 + 3 * t2) * p2 + (t3 - t2) * m2;
  };
  const inside = (x: number, y: number) => height[y * n + x];
  const at = (x: number, y: number) => {
    const xx = clamp01(x, 0, n - 1), yy = clamp01(y, 0, n - 1);
    const base = inside(xx, yy);
    const slopeX = xx === 0 ? inside(1, yy) - base : xx === n - 1 ? base - inside(n - 2, yy) : 0;
    const slopeY = yy === 0 ? inside(xx, 1) - base : yy === n - 1 ? base - inside(xx, n - 2) : 0;
    return base + (x - xx) * slopeX + (y - yy) * slopeY;
  };
  const gradientX = new Float32Array(n * n), gradientY = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    gradientX[y * n + x] = (at(x + 1, y - 1) - at(x - 1, y - 1) +
      2 * (at(x + 1, y) - at(x - 1, y)) + at(x + 1, y + 1) - at(x - 1, y + 1)) / 8;
    gradientY[y * n + x] = (at(x - 1, y + 1) - at(x - 1, y - 1) +
      2 * (at(x, y + 1) - at(x, y - 1)) + at(x + 1, y + 1) - at(x + 1, y - 1)) / 8;
  }
  const coordinates = (u: number, v: number) => {
    const x = clamp01(u) * (n - 1), y = clamp01(v) * (n - 1);
    const ix = Math.min(n - 2, Math.floor(x)), iy = Math.min(n - 2, Math.floor(y));
    return { ix, iy, tx: x - ix, ty: y - iy };
  };
  const heightAt = (u: number, v: number) => {
    const { ix, iy, tx, ty } = coordinates(u, v);
    const rows = [-1, 0, 1, 2].map((dy) => cubic(at(ix - 1, iy + dy), at(ix, iy + dy),
      at(ix + 1, iy + dy), at(ix + 2, iy + dy), tx));
    const value = cubic(rows[0], rows[1], rows[2], rows[3], ty);
    const a = inside(ix, iy), b = inside(ix + 1, iy);
    const c = inside(ix, iy + 1), d = inside(ix + 1, iy + 1);
    return clamp01(value, Math.min(a, b, c, d), Math.max(a, b, c, d));
  };
  const gradient = (values: Float32Array, u: number, v: number) => {
    const { ix, iy, tx, ty } = coordinates(u, v);
    const i = iy * n + ix;
    return values[i] * (1 - tx) * (1 - ty) + values[i + 1] * tx * (1 - ty) +
      values[i + n] * (1 - tx) * ty + values[i + n + 1] * tx * ty;
  };
  const physical = (n - 1) * heightScale / worldSize;
  const normalAt = (u: number, v: number) => {
    const gx = gradient(gradientX, u, v) * physical, gz = gradient(gradientY, u, v) * physical;
    const inv = 1 / Math.hypot(gx, 1, gz);
    return [-gx * inv, inv, -gz * inv];
  };
  return { height: heightAt, normal: normalAt };
}

describe('fast sampler and frame-sliced LOD rebuilds', () => {
  // Rough, non-smooth terrain so every monotone-cubic branch is exercised.
  const rough = (n: number) => field(n, (u, v) =>
    0.5 + 0.3 * Math.sin(u * 23.1) * Math.cos(v * 17.3) +
    0.08 * Math.sin((u * 311 + v * 173) * 1.7) - (u > 0.6 && v < 0.3 ? 0.21 : 0));

  it('returns exactly the original sampler values, including border extrapolation', () => {
    for (const n of [4, 17, 64]) {
      const map = rough(n);
      const fast = createTerrainSampler(map.height, n, 1700, 5200);
      const reference = referenceSampler(map.height, n, 1700, 5200);
      const coordinates = [0, 1e-7, 0.5 / (n - 1), 1 / (n - 1), 0.0123, 0.25, 0.4999, 0.5,
        0.73, 1 - 1.5 / (n - 1), 1 - 1 / (n - 1), 0.999999, 1, -0.2, 1.3];
      for (const u of coordinates) for (const v of coordinates) {
        // Equal as numbers (=== treats +0 and -0 alike), not merely close.
        expect(fast.height(u, v) === reference.height(u, v)).toBe(true);
        const a = fast.normal(u, v), b = reference.normal(u, v);
        for (let axis = 0; axis < 3; axis++) expect(a[axis] === b[axis]).toBe(true);
      }
    }
  });

  it('builds the identical mesh whether run at once or a row at a time', () => {
    const n = 65, map = rough(n);
    const sampler = createTerrainSampler(map.height, n, 1500, 4800);
    // Unequal neighbours exercise every stitched-edge transition.
    const segments = new Array<number>(TERRAIN_TILES ** 2).fill(16);
    segments[0] = 64; segments[9] = 128; segments[10] = 32; segments[63] = 8;
    const plan = fixedPlan(segments);
    const whole = buildAdaptiveTerrainGeometry(sampler, plan, 1500, 4800);
    const steps = adaptiveTerrainGeometrySteps(sampler, plan, 1500, 4800);
    let slices = 0, result = steps.next();
    while (!result.done) { slices++; result = steps.next(); }
    const sliced = result.value;
    // One yield per tessellated row plus one per tile's index pass.
    expect(slices).toBe(segments.reduce((total, s) => total + s + 2, 0));
    for (const name of ['position', 'normal', 'uv', 'color'])
      expect(sliced.getAttribute(name).array).toEqual(whole.getAttribute(name).array);
    expect(sliced.index!.array).toEqual(whole.index!.array);
    expect(sliced.userData.nhPerimeterIndices).toEqual(whole.userData.nhPerimeterIndices);
    expect(sliced.userData.nhMeshPlanKey).toBe(plan.key);
    expect(sliced.boundingSphere!.radius).toBe(whole.boundingSphere!.radius);
    expect(runToCompletion(adaptiveTerrainGeometrySteps(sampler, plan, 1500, 4800))
      .getAttribute('position').array).toEqual(whole.getAttribute('position').array);
    whole.dispose(); sliced.dispose();
  });

  it('spends at most the frame budget per call yet always makes progress', () => {
    let clock = 0, ran = 0;
    function* work(count: number, costMs: number): Generator<void, string, undefined> {
      for (let i = 0; i < count; i++) { clock += costMs; ran++; yield; }
      return 'mesh';
    }
    const now = () => clock;
    const steps = work(10, 1);
    expect(advanceWithinBudget(steps, 4, now)).toEqual({ done: false });
    expect(ran).toBe(4);
    // A single step costlier than the budget still runs, one per call.
    const slow = work(2, 25);
    ran = 0;
    expect(advanceWithinBudget(slow, 4, now)).toEqual({ done: false });
    expect(ran).toBe(1);
    expect(advanceWithinBudget(slow, 0, now)).toEqual({ done: false });
    expect(ran).toBe(2);
    expect(advanceWithinBudget(slow, 4, now)).toEqual({ done: true, value: 'mesh' });
    let frames = 1, result = advanceWithinBudget(steps, 4, now);
    while (!result.done) { frames++; result = advanceWithinBudget(steps, 4, now); }
    expect(result.value).toBe('mesh');
    expect(frames).toBe(2);
  });
});

describe('prefiltered geometry for coarse mesh tiles', () => {
  // A smooth ramp with a one-cell checkerboard: detail no coarse tile can hold.
  const rippled = (n: number) => field(n, (u, v) => 0.3 + 0.25 * u + 0.15 * v) as HeightField;
  const withChecker = (n: number) => {
    const map = rippled(n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++)
      map.height[y * n + x] += ((x + y) % 2 ? 0.02 : -0.02);
    return map;
  };

  it('keeps planes exactly planar, borders included, at every level', () => {
    const n = 65, plane = rippled(n);
    for (const level of [1, 2, 3, 4]) {
      const filtered = prefilterHeights(plane.height, n, level);
      for (let i = 0; i < n * n; i++) expect(Math.abs(filtered[i] - plane.height[i])).toBeLessThan(1e-5);
    }
    expect(prefilterHeights(plane.height, n, 0)).toBe(plane.height);
  });

  it('removes detail finer than the vertex spacing; full detail below ~1.5 samples', () => {
    const n = 129, map = withChecker(n);
    const sampler = createTerrainSampler(map.height, n, 1500, 4800);
    expect(sampler.heightForSpacing!(1)).toBe(sampler.height);
    const coarse = sampler.heightForSpacing!(4);
    let pointError = 0, filteredError = 0;
    for (let j = 8; j < n - 8; j += 4) for (let i = 8; i < n - 8; i += 4) {
      const u = i / (n - 1), v = j / (n - 1);
      const ramp = 0.3 + 0.25 * u + 0.15 * v;
      pointError = Math.max(pointError, Math.abs(sampler.height(u, v) - ramp));
      filteredError = Math.max(filteredError, Math.abs(coarse(u, v) - ramp));
    }
    expect(pointError).toBeGreaterThan(0.015);
    expect(filteredError).toBeLessThan(pointError * 0.1);
  });

  it('builds coarse tiles from the prefiltered surface and fine tiles at full detail', () => {
    const n = 257, map = withChecker(n);
    const sampler = createTerrainSampler(map.height, n, 1500, 4800);
    const heightFactor = TERRAIN_SIZE * 1500 / 4800;
    const deviation = (segments: number) => {
      const geometry = buildAdaptiveTerrainGeometry(sampler,
        fixedPlan(new Array<number>(TERRAIN_TILES ** 2).fill(segments)), 1500, 4800);
      const positions = geometry.getAttribute('position');
      let worst = 0;
      for (let k = 0; k < positions.count; k++) {
        const u = positions.getX(k) / TERRAIN_SIZE + 0.5, v = positions.getZ(k) / TERRAIN_SIZE + 0.5;
        if (u < 0.05 || u > 0.95 || v < 0.05 || v > 0.95) continue;
        worst = Math.max(worst, Math.abs(positions.getY(k) / heightFactor - (0.3 + 0.25 * u + 0.15 * v)));
      }
      geometry.dispose();
      return worst;
    };
    // 8 segments per tile → 4 source samples per vertex: smooth ramp.
    expect(deviation(8)).toBeLessThan(0.003);
    // 64 segments → half-sample spacing: the checkerboard is kept.
    expect(deviation(64)).toBeGreaterThan(0.015);
  });

  it('stitches tiles sampled at different prefilter levels without cracks', () => {
    const n = 257, map = withChecker(n);
    const sampler = createTerrainSampler(map.height, n, 1500, 4800);
    const segments = new Array<number>(TERRAIN_TILES ** 2).fill(8);
    segments[0] = 32;
    const geometry = buildAdaptiveTerrainGeometry(sampler, fixedPlan(segments), 1500, 4800);
    const positions = geometry.getAttribute('position');
    const first = 0, second = (32 + 1) ** 2;
    for (let y = 0; y <= 32; y++) {
      const high = first + y * 33 + 32;
      const step = y / 4, k = Math.floor(step), f = step - k;
      const low0 = second + Math.min(k, 8) * 9;
      const low1 = second + Math.min(k + 1, 8) * 9;
      const expected = positions.getY(low0) * (1 - f) + positions.getY(low1) * f;
      expect(positions.getY(high)).toBeCloseTo(expected, 6);
    }
    geometry.dispose();
  });
});

describe('watertight adaptive mesh', () => {
  it('draws every shared tile edge identically from both sides on a mixed plan', () => {
    const n = 257;
    const map = field(n, (u, v) => 0.4 + 0.2 * Math.sin(u * 9) * Math.cos(v * 7));
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++)
      map.height[y * n + x] += ((x * 7 + y * 13) % 5 - 2) * 0.006;
    const sampler = createTerrainSampler(map.height, n, 1500, 4800);
    const options = [8, 16, 32, 64];
    const segments = Array.from({ length: TERRAIN_TILES ** 2 },
      (_, i) => options[(i * 7 + Math.floor(i / 8) * 3) % options.length]);
    const plan = fixedPlan(segments);
    const geometry = buildAdaptiveTerrainGeometry(sampler, plan, 1500, 4800);
    const y = geometry.getAttribute('position');
    const offsets: number[] = [];
    let total = 0;
    for (const s of segments) { offsets.push(total); total += (s + 1) ** 2; }
    // Height along one tile's edge, as that tile's triangles draw it.
    const edge = (tile: number, side: 'left' | 'right' | 'top' | 'bottom') => {
      const s = segments[tile], o = offsets[tile];
      const index = (k: number) => side === 'left' ? o + k * (s + 1)
        : side === 'right' ? o + k * (s + 1) + s
          : side === 'top' ? o + k : o + s * (s + 1) + k;
      return (t: number) => {
        const k = Math.min(s - 1, Math.floor(t * s)), f = t * s - k;
        return y.getY(index(k)) * (1 - f) + y.getY(index(k + 1)) * f;
      };
    };
    let worst = 0;
    for (let ty = 0; ty < TERRAIN_TILES; ty++) for (let tx = 0; tx < TERRAIN_TILES; tx++) {
      const tile = ty * TERRAIN_TILES + tx;
      const pairs: Array<[(t: number) => number, (t: number) => number, number]> = [];
      if (tx + 1 < TERRAIN_TILES)
        pairs.push([edge(tile, 'right'), edge(tile + 1, 'left'), Math.max(segments[tile], segments[tile + 1])]);
      if (ty + 1 < TERRAIN_TILES)
        pairs.push([edge(tile, 'bottom'), edge(tile + TERRAIN_TILES, 'top'),
          Math.max(segments[tile], segments[tile + TERRAIN_TILES])]);
      for (const [a, b, finest] of pairs)
        for (let k = 0; k <= finest; k++) worst = Math.max(worst, Math.abs(a(k / finest) - b(k / finest)));
    }
    expect(worst).toBeLessThan(1e-6);
    geometry.dispose();
  });
});
