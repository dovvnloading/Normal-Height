import * as THREE from 'three';
import type { HeightField } from '../model/types';
import { TERRAIN_SIZE } from './GroundExtension';

/**
 * A single indexed mesh with independently tessellated terrain tiles.
 * The contour, PBR and raycast systems keep a single Mesh, but triangles
 * are spent where they cover screen pixels instead of uniformly over 8 km.
 */
export const TERRAIN_TILES = 8;
export type MeshQuality = 'balanced' | 'high' | 'ultra';

export interface TerrainMeshPlan {
  readonly segments: readonly number[];
  readonly key: string;
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly maxSegments: number;
}

export interface TerrainSampler {
  readonly resolution: number;
  height(u: number, v: number): number;
  normal(u: number, v: number): readonly [number, number, number];
}

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

const monotoneSlope = (left: number, right: number): number => {
  if (left * right <= 0) return 0;
  return (2 * left * right) / (left + right);
};

/** Monotonic cubic Hermite interpolation. Linear slopes reproduce planes. */
function monotoneCubic(
  p0: number, p1: number, p2: number, p3: number, t: number,
): number {
  const t2 = t * t, t3 = t2 * t;
  const m1 = monotoneSlope(p1 - p0, p2 - p1);
  const m2 = monotoneSlope(p2 - p1, p3 - p2);
  return (2 * t3 - 3 * t2 + 1) * p1 +
    (t3 - 2 * t2 + t) * m1 +
    (-2 * t3 + 3 * t2) * p2 +
    (t3 - t2) * m2;
}

/**
 * Source-derived geometry and normals, independent of displayed triangle size.
 * Boundary samples use linear extrapolation rather than flattening derivative
 * estimates at x=0/n-1 or y=0/n-1.
 *
 * Geometric interpolation never overshoots its source cell's four corners.
 * This is a preview-only reconstruction and does NOT alter original heights.
 */
export function createTerrainSampler(
  height: Float32Array, n: number, heightScale: number, worldSize: number,
): TerrainSampler {
  if (!Number.isInteger(n) || n < 2 || height.length !== n * n ||
      !Number.isFinite(heightScale) || heightScale <= 0 ||
      !Number.isFinite(worldSize) || worldSize <= 0)
    throw new Error('Terrain preview requires aligned physical height samples.');
  const gradientX = new Float32Array(n * n);
  const gradientY = new Float32Array(n * n);

  const inside = (x: number, y: number) => height[y * n + x];
  const at = (x: number, y: number): number => {
    // Extrapolation preserves the true slope of a planar DEM at tile edges.
    const xx = clamp(x, 0, n - 1);
    const yy = clamp(y, 0, n - 1);
    const base = inside(xx, yy);
    const offsetX = x - xx, offsetY = y - yy;
    const slopeX = xx === 0
      ? inside(1, yy) - base : xx === n - 1
        ? base - inside(n - 2, yy) : 0;
    const slopeY = yy === 0
      ? inside(xx, 1) - base : yy === n - 1
        ? base - inside(xx, n - 2) : 0;
    return base + offsetX * slopeX + offsetY * slopeY;
  };

  // Sobel derivatives reject single-diagonal triangle artifacts while
  // preserving genuine source-height gradients. One source texel of support,
  // with a continuous bilinear reconstruction between source samples.
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x;
    gradientX[i] = (
      at(x + 1, y - 1) - at(x - 1, y - 1) +
      2 * (at(x + 1, y) - at(x - 1, y)) +
      at(x + 1, y + 1) - at(x - 1, y + 1)
    ) / 8;
    gradientY[i] = (
      at(x - 1, y + 1) - at(x - 1, y - 1) +
      2 * (at(x, y + 1) - at(x, y - 1)) +
      at(x + 1, y + 1) - at(x + 1, y - 1)
    ) / 8;
  }

  const coordinates = (u: number, v: number) => {
    const x = clamp(u) * (n - 1), y = clamp(v) * (n - 1);
    const ix = Math.min(n - 2, Math.floor(x));
    const iy = Math.min(n - 2, Math.floor(y));
    return { ix, iy, tx: x - ix, ty: y - iy };
  };
  const sampleHeight = (u: number, v: number): number => {
    const { ix, iy, tx, ty } = coordinates(u, v);
    const row0 = monotoneCubic(
      at(ix - 1, iy - 1), at(ix, iy - 1),
      at(ix + 1, iy - 1), at(ix + 2, iy - 1), tx,
    );
    const row1 = monotoneCubic(
      at(ix - 1, iy), at(ix, iy),
      at(ix + 1, iy), at(ix + 2, iy), tx,
    );
    const row2 = monotoneCubic(
      at(ix - 1, iy + 1), at(ix, iy + 1),
      at(ix + 1, iy + 1), at(ix + 2, iy + 1), tx,
    );
    const row3 = monotoneCubic(
      at(ix - 1, iy + 2), at(ix, iy + 2),
      at(ix + 1, iy + 2), at(ix + 2, iy + 2), tx,
    );
    const value = monotoneCubic(row0, row1, row2, row3, ty);
    const a = inside(ix, iy), b = inside(ix + 1, iy);
    const c = inside(ix, iy + 1), d = inside(ix + 1, iy + 1);
    return clamp(value, Math.min(a, b, c, d), Math.max(a, b, c, d));
  };
  const sampleGradient = (values: Float32Array, u: number, v: number) => {
    const { ix, iy, tx, ty } = coordinates(u, v);
    const i = iy * n + ix;
    return values[i] * (1 - tx) * (1 - ty) +
      values[i + 1] * tx * (1 - ty) +
      values[i + n] * (1 - tx) * ty +
      values[i + n + 1] * tx * ty;
  };
  const physicalGradient = (n - 1) * heightScale / worldSize;
  const normal = (u: number, v: number): readonly [number, number, number] => {
    const gx = sampleGradient(gradientX, u, v) * physicalGradient;
    const gz = sampleGradient(gradientY, u, v) * physicalGradient;
    const inv = 1 / Math.hypot(gx, 1, gz);
    return [-gx * inv, inv, -gz * inv];
  };
  return { resolution: n, height: sampleHeight, normal };
}

const baseSegments = (n: number) => n < 256 ? 16 : n < 512 ? 32 : 64;
const vertexCost = (segments: number) => (segments + 1) * (segments + 1);

/**
 * Camera-space size selects per-region density. A deterministic vertex budget
 * prioritizes nearby visible regions. Balancing the target error separately
 * from the memory budget avoids uncontrolled whole-terrain subdivision.
 */
export function planTerrainMesh(
  sampler: TerrainSampler,
  camera: THREE.PerspectiveCamera,
  viewportHeight: number,
  pixelRatio: number,
  heightScale: number,
  worldSize: number,
  exaggeration: number,
  quality: MeshQuality,
): TerrainMeshPlan {
  const n = sampler.resolution;
  const base = baseSegments(n);
  const maximum = Math.min(256, Math.max(base,
    2 ** Math.ceil(Math.log2(Math.max(1, (n - 1) / TERRAIN_TILES))) * 2,
  ));
  const budget = quality === 'ultra' ? 970000 :
    quality === 'balanced' ? 340000 : 680000;
  const targetPixelSize = quality === 'ultra' ? 2.6 :
    quality === 'balanced' ? 7 : 4.3;
  const focal = 0.5 * Math.max(1, viewportHeight * pixelRatio) /
    Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const tileWidth = TERRAIN_SIZE / TERRAIN_TILES;
  const terrainScale = TERRAIN_SIZE * heightScale / worldSize;
  const segments = new Array<number>(TERRAIN_TILES * TERRAIN_TILES).fill(base);
  let vertices = segments.length * vertexCost(base);
  const candidates: Array<{ index: number; desired: number; score: number }> = [];
  camera.updateMatrixWorld();
  const point = new THREE.Vector3();
  const projected = new THREE.Vector3();
  for (let y = 0; y < TERRAIN_TILES; y++) for (let x = 0; x < TERRAIN_TILES; x++) {
    const u = (x + 0.5) / TERRAIN_TILES;
    const v = (y + 0.5) / TERRAIN_TILES;
    point.set((u - 0.5) * TERRAIN_SIZE,
      sampler.height(u, v) * terrainScale * exaggeration,
      (v - 0.5) * TERRAIN_SIZE);
    projected.copy(point).project(camera);
    const index = y * TERRAIN_TILES + x;
    const withinTile = Math.abs(camera.position.x - point.x) <= tileWidth &&
      Math.abs(camera.position.z - point.z) <= tileWidth;
    const visible = withinTile ||
      (projected.z >= -1 && projected.z <= 1.3 &&
        Math.abs(projected.x) < 1.55 && Math.abs(projected.y) < 1.55);
    if (!visible) continue;
    const distance = Math.max(0.03, camera.position.distanceTo(point));
    const tilePixels = (focal * tileWidth) / distance;
    const ideal = tilePixels / targetPixelSize;
    let desired = base;
    while (desired < maximum && desired < ideal) desired *= 2;
    if (desired > base) candidates.push({ index, desired, score: tilePixels });
  }
  candidates.sort((a, b) => b.score - a.score || a.index - b.index);
  for (const candidate of candidates) {
    let next = segments[candidate.index] * 2;
    while (next <= candidate.desired) {
      const cost = vertexCost(next) - vertexCost(segments[candidate.index]);
      if (vertices + cost > budget) break;
      vertices += cost;
      segments[candidate.index] = next;
      next *= 2;
    }
  }
  const triangleCount = segments.reduce((total, value) => total + 2 * value * value, 0);
  return {
    segments,
    key: `${quality}:${segments.join(',')}`,
    vertexCount: vertices,
    triangleCount,
    maxSegments: Math.max(...segments),
  };
}

export interface TerrainMeshGeometry extends THREE.BufferGeometry {
  userData: {
    nhPerimeterIndices?: number[];
    nhMeshPlanKey?: string;
    [key: string]: unknown;
  };
}

/**
 * Stitch a finer tile boundary to its coarser neighbour's exact edge *line*.
 * The correction fades into the first few interior rows, eliminating cracks
 * and sharp boundary steps without flattening the underlying DEM.
 */
export function buildAdaptiveTerrainGeometry(
  sampler: TerrainSampler,
  plan: TerrainMeshPlan,
  heightScale: number,
  worldSize: number,
): THREE.BufferGeometry {
  if (plan.segments.length !== TERRAIN_TILES * TERRAIN_TILES)
    throw new Error('Adaptive terrain plan must cover all tiles.');
  const positions = new Float32Array(plan.vertexCount * 3);
  const normals = new Float32Array(plan.vertexCount * 3);
  const uvs = new Float32Array(plan.vertexCount * 2);
  const colors = new Float32Array(plan.vertexCount * 3);
  const indices = new Uint32Array(plan.triangleCount * 3);
  const offsets = new Uint32Array(plan.segments.length);
  let vertex = 0, triangle = 0;
  const heightFactor = TERRAIN_SIZE * heightScale / worldSize;
  const tileAt = (x: number, y: number) =>
    plan.segments[y * TERRAIN_TILES + x];
  const lockedEdge = (u: number, v: number, lowSegments: number,
    origin: number, fixed: number, vertical: boolean): number => {
    const t = clamp((vertical ? v : u) * TERRAIN_TILES - origin);
    const step = Math.min(lowSegments - 1, Math.floor(t * lowSegments));
    const f = t * lowSegments - step;
    const p0 = (origin + step / lowSegments) / TERRAIN_TILES;
    const p1 = (origin + (step + 1) / lowSegments) / TERRAIN_TILES;
    return vertical
      ? sampler.height(fixed / TERRAIN_TILES, p0) * (1 - f) +
        sampler.height(fixed / TERRAIN_TILES, p1) * f
      : sampler.height(p0, fixed / TERRAIN_TILES) * (1 - f) +
        sampler.height(p1, fixed / TERRAIN_TILES) * f;
  };
  for (let ty = 0; ty < TERRAIN_TILES; ty++) for (let tx = 0; tx < TERRAIN_TILES; tx++) {
    const tile = ty * TERRAIN_TILES + tx;
    const s = plan.segments[tile];
    if (!Number.isInteger(s) || s < 2 || s > 256 || (s & (s - 1)))
      throw new Error('Adaptive terrain segments must be powers of two within bounds.');
    offsets[tile] = vertex;
    const fade = (distance: number) => {
      const influence = 1 - clamp(distance / Math.max(3, Math.round(s / 24)));
      return influence * influence * (3 - 2 * influence);
    };
    for (let iy = 0; iy <= s; iy++) for (let ix = 0; ix <= s; ix++) {
      const u = (tx + ix / s) / TERRAIN_TILES;
      const v = (ty + iy / s) / TERRAIN_TILES;
      let h = sampler.height(u, v);
      if (tx > 0 && tileAt(tx - 1, ty) < s && ix < Math.max(3, s / 24)) {
        const edgeU = tx / TERRAIN_TILES;
        h += (lockedEdge(edgeU, v, tileAt(tx - 1, ty), ty, tx, true) -
          sampler.height(edgeU, v)) * fade(ix);
      }
      if (tx + 1 < TERRAIN_TILES && tileAt(tx + 1, ty) < s &&
          s - ix < Math.max(3, s / 24)) {
        const edgeU = (tx + 1) / TERRAIN_TILES;
        h += (lockedEdge(edgeU, v, tileAt(tx + 1, ty), ty, tx + 1, true) -
          sampler.height(edgeU, v)) * fade(s - ix);
      }
      if (ty > 0 && tileAt(tx, ty - 1) < s && iy < Math.max(3, s / 24)) {
        const edgeV = ty / TERRAIN_TILES;
        h += (lockedEdge(u, edgeV, tileAt(tx, ty - 1), tx, ty, false) -
          sampler.height(u, edgeV)) * fade(iy);
      }
      if (ty + 1 < TERRAIN_TILES && tileAt(tx, ty + 1) < s &&
          s - iy < Math.max(3, s / 24)) {
        const edgeV = (ty + 1) / TERRAIN_TILES;
        h += (lockedEdge(u, edgeV, tileAt(tx, ty + 1), tx, ty + 1, false) -
          sampler.height(u, edgeV)) * fade(s - iy);
      }
      const i = vertex * 3, j = vertex * 2;
      positions[i] = (u - 0.5) * TERRAIN_SIZE;
      positions[i + 1] = h * heightFactor;
      positions[i + 2] = (v - 0.5) * TERRAIN_SIZE;
      const normal = sampler.normal(u, v);
      normals[i] = normal[0]; normals[i + 1] = normal[1]; normals[i + 2] = normal[2];
      uvs[j] = u; uvs[j + 1] = 1 - v;
      vertex++;
    }
    const row = s + 1;
    const start = offsets[tile];
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const a = start + y * row + x, b = a + 1;
      const c = a + row, d = c + 1;
      indices[triangle++] = a; indices[triangle++] = c; indices[triangle++] = b;
      indices[triangle++] = b; indices[triangle++] = c; indices[triangle++] = d;
    }
  }
  const perimeter: number[] = [];
  // Counter-clockwise in XZ when viewed from above; never duplicate corners.
  for (let tx = 0; tx < TERRAIN_TILES; tx++) {
    const tile = tx, s = plan.segments[tile], offset = offsets[tile];
    for (let x = 0; x < s; x++) perimeter.push(offset + x);
  }
  for (let ty = 0; ty < TERRAIN_TILES; ty++) {
    const tile = ty * TERRAIN_TILES + TERRAIN_TILES - 1;
    const s = plan.segments[tile], offset = offsets[tile];
    for (let y = 0; y < s; y++) perimeter.push(offset + y * (s + 1) + s);
  }
  for (let tx = TERRAIN_TILES - 1; tx >= 0; tx--) {
    const tile = (TERRAIN_TILES - 1) * TERRAIN_TILES + tx;
    const s = plan.segments[tile], offset = offsets[tile];
    for (let x = s; x > 0; x--) perimeter.push(offset + s * (s + 1) + x);
  }
  for (let ty = TERRAIN_TILES - 1; ty >= 0; ty--) {
    const tile = ty * TERRAIN_TILES;
    const s = plan.segments[tile], offset = offsets[tile];
    for (let y = s; y > 0; y--) perimeter.push(offset + y * (s + 1));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('uv2', new THREE.BufferAttribute(uvs.slice(), 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.userData.nhPerimeterIndices = perimeter;
  geometry.userData.nhMeshPlanKey = plan.key;
  geometry.computeBoundingSphere();
  return geometry;
}
