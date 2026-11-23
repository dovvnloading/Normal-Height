import { BufferGeometry, Ray, Vector3 } from 'three';
import { TERRAIN_TILES } from './terrainMesh';
import { TERRAIN_SIZE } from './GroundExtension';
import type { TerrainMeshPlan } from './terrainMesh';
import type { TerrainPoint } from '../model/viewportUX';

/** Walk only the projected cells crossed by the ray, testing the two triangles
 * actually displayed in each cell. Picking cost is independent of tile area. */
export function createTerrainPicker(geometry: BufferGeometry, plan: TerrainMeshPlan) {
  const positions = geometry.getAttribute('position');
  const offsets: number[] = [];
  let offset = 0;
  for (const segments of plan.segments) {
    offsets.push(offset);
    offset += (segments + 1) ** 2;
  }
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), d = new Vector3();
  const hit = new Vector3();
  return (ray: Ray): TerrainPoint | null => {
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
      const tx = index(x, TERRAIN_TILES, du), tz = index(z, TERRAIN_TILES, dv);
      const tile = tz * TERRAIN_TILES + tx;
      const s = plan.segments[tile], scale = TERRAIN_TILES * s;
      const ix = index(x * TERRAIN_TILES - tx, s, du), iz = index(z * TERRAIN_TILES - tz, s, dv);
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
}
