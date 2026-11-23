import { BufferGeometry, Ray, Vector3 } from 'three';
import { TERRAIN_TILES } from './terrainMesh';
import { TERRAIN_SIZE } from './GroundExtension';
import type { TerrainMeshPlan } from './terrainMesh';
import type { TerrainPoint } from '../model/viewportUX';

/** Walk only the projected cells crossed by the ray, testing the two triangles
 * actually displayed in each cell. Picking cost is independent of tile area. */
export function createTerrainPicker(geometry: BufferGeometry, plan: TerrainMeshPlan) {
  const tiles = plan.tilesPerSide ?? TERRAIN_TILES;
  const positions = geometry.getAttribute('position');
  const offsets: number[] = [];
  let offset = 0;
  for (const segments of plan.segments) {
    offsets.push(offset);
    offset += (segments + 1) ** 2;
  }
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), d = new Vector3();
  const hit = new Vector3();
  const pick = (ray: Ray): TerrainPoint | null => {
    const u = ray.origin.x / TERRAIN_SIZE + 0.5, v = ray.origin.z / TERRAIN_SIZE + 0.5;
    const du = ray.direction.x / TERRAIN_SIZE, dv = ray.direction.z / TERRAIN_SIZE;
    let enter = 0, exit = Infinity;
    for (const [origin, direction] of [[u, du], [v, dv]]) {
      if (Math.abs(direction) < 1e-14) {
        if (origin < 0 || origin > 1) return null;
      } else {
        const lo = -origin / direction, hi = (1 - origin) / direction;
        enter = Math.max(enter, Math.min(lo, hi));
        exit = Math.min(exit, Math.max(lo, hi));
      }
    }
    // Choose the forward cell at a shared edge (including parallel/top-down rays).
    const index = (x: number, count: number, velocity: number) => Math.max(0,
      Math.min(count - 1, Math.floor(x * count + Math.sign(velocity) * 1e-9)));
    const nextEdge = (i: number, scale: number, origin: number, velocity: number) =>
      Math.abs(velocity) < 1e-14 ? Infinity : ((i + Number(velocity > 0)) / scale - origin) / velocity;
    let t = enter;
    while (t <= exit) {
      const x = u + t * du, z = v + t * dv;
      const tx = index(x, tiles, du), tz = index(z, tiles, dv);
      const tile = tz * tiles + tx;
      const s = plan.segments[tile], scale = tiles * s;
      const ix = index(x * tiles - tx, s, du), iz = index(z * tiles - tz, s, dv);
      const row = s + 1, first = offsets[tile] + iz * row + ix;
      a.fromBufferAttribute(positions, first);
      b.fromBufferAttribute(positions, first + 1);
      c.fromBufferAttribute(positions, first + row);
      d.fromBufferAttribute(positions, first + row + 1);
      const h1 = ray.intersectTriangle(a, c, b, true, hit);
      const d1 = h1 ? h1.distanceToSquared(ray.origin) : Infinity;
      const h2 = ray.intersectTriangle(b, c, d, true, hit);
      if (h1 || h2) {
        if (h1 && (!h2 || d1 < h2.distanceToSquared(ray.origin)))
          ray.intersectTriangle(a, c, b, true, hit);
        return {
          u: Math.max(0, Math.min(1, hit.x / TERRAIN_SIZE + 0.5)),
          v: Math.max(0, Math.min(1, hit.z / TERRAIN_SIZE + 0.5)),
        };
      }
      const next = Math.min(nextEdge(tx * s + ix, scale, u, du),
        nextEdge(tz * s + iz, scale, v, dv));
      if (!Number.isFinite(next) || next <= t || next >= exit) break;
      t = next;
    }
    return null;
  };
  // Use the same diagonal as the index buffer, including at stitched edges.
  // A bilinear DEM sample can sit above or beneath the triangle on screen.
  const heightAt = (u: number, v: number) => {
    const x = Math.max(0, Math.min(1, u)) * tiles;
    const y = Math.max(0, Math.min(1, v)) * tiles;
    const tx = Math.min(tiles - 1, Math.floor(x));
    const ty = Math.min(tiles - 1, Math.floor(y));
    const tile = ty * tiles + tx;
    const s = plan.segments[tile], row = s + 1;
    const sx = (x - tx) * s, sy = (y - ty) * s;
    const ix = Math.min(s - 1, Math.floor(sx)), iy = Math.min(s - 1, Math.floor(sy));
    const fx = sx - ix, fy = sy - iy;
    const first = offsets[tile] + iy * row + ix;
    const b = positions.getY(first + 1), c = positions.getY(first + row);
    if (fx + fy <= 1) return positions.getY(first) * (1 - fx - fy) + b * fx + c * fy;
    return positions.getY(first + row + 1) * (fx + fy - 1) + b * (1 - fy) + c * (1 - fx);
  };
  return Object.assign(pick, { heightAt });
}
