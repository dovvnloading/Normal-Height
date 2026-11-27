import { worldGridBounds } from './worldViewMath';
import type { WorldSnapshot } from './worldViewMath';

/** A bounded display mesh with normals derived from the full physical field,
 * independent of the decimated mesh's triangle density. */
export function buildWorldTerrainMesh(snapshot: WorldSnapshot) {
  const { result: field, world, grid } = snapshot;
  const bounds = worldGridBounds(world, grid);
  const extent = Math.max(bounds.width, bounds.depth);
  if (
    ![field.width, field.height].every((value) => Number.isInteger(value) && value >= 2) ||
    field.heights.length !== field.width * field.height ||
    ![extent, field.min, field.max, field.spacingX, field.spacingZ].every(Number.isFinite) ||
    extent <= 0 ||
    field.spacingX <= 0 ||
    field.spacingZ <= 0 ||
    field.min > field.max
  )
    throw new Error('The sampled world cannot form a physical display mesh.');
  const width = bounds.width / extent,
    depth = bounds.depth / extent;
  const minimum = world.domain.datum + field.min * world.domain.heightScale;
  const verticalSpan = ((field.max - field.min) * world.domain.heightScale) / extent;
  const columns = Math.min(257, field.width),
    rows = Math.min(257, field.height);
  const positions = new Float32Array(columns * rows * 3);
  const normals = new Float32Array(positions.length);
  const uv = new Float32Array(columns * rows * 2);
  for (let z = 0; z < rows; z++)
    for (let x = 0; x < columns; x++) {
      const sourceX = Math.round((x / (columns - 1)) * (field.width - 1));
      const sourceZ = Math.round((z / (rows - 1)) * (field.height - 1));
      const u = sourceX / (field.width - 1),
        v = sourceZ / (field.height - 1);
      const i = z * columns + x;
      positions[i * 3] = (u - 0.5) * width;
      positions[i * 3 + 1] =
        ((field.heights[sourceZ * field.width + sourceX] - field.min) * world.domain.heightScale) /
        extent;
      positions[i * 3 + 2] = (v - 0.5) * depth;
      const left = Math.max(0, sourceX - 1),
        right = Math.min(field.width - 1, sourceX + 1);
      const north = Math.max(0, sourceZ - 1),
        south = Math.min(field.height - 1, sourceZ + 1);
      const gx =
        ((field.heights[sourceZ * field.width + right] -
          field.heights[sourceZ * field.width + left]) *
          world.domain.heightScale) /
        ((right - left) * field.spacingX);
      const gz =
        ((field.heights[south * field.width + sourceX] -
          field.heights[north * field.width + sourceX]) *
          world.domain.heightScale) /
        ((south - north) * field.spacingZ);
      const length = Math.hypot(gx, 1, gz);
      normals[i * 3] = -gx / length;
      normals[i * 3 + 1] = 1 / length;
      normals[i * 3 + 2] = -gz / length;
      uv[i * 2] = u;
      uv[i * 2 + 1] = 1 - v;
    }
  const indices = new Uint32Array((columns - 1) * (rows - 1) * 6);
  let index = 0;
  for (let z = 0; z < rows - 1; z++)
    for (let x = 0; x < columns - 1; x++) {
      const a = z * columns + x,
        b = a + 1,
        c = a + columns,
        d = c + 1;
      indices.set([a, c, b, b, c, d], index);
      index += 6;
    }
  const boundary: number[] = [];
  for (let x = 0; x < columns; x++) boundary.push(x);
  for (let z = 1; z < rows; z++) boundary.push(z * columns + columns - 1);
  for (let x = columns - 2; x >= 0; x--) boundary.push((rows - 1) * columns + x);
  for (let z = rows - 2; z >= 1; z--) boundary.push(z * columns);
  const walls = new Float32Array(boundary.length * 18);
  for (let i = 0; i < boundary.length; i++) {
    const a = boundary[i] * 3,
      b = boundary[(i + 1) % boundary.length] * 3;
    const p = [positions[a], positions[a + 1], positions[a + 2]],
      q = [positions[b], positions[b + 1], positions[b + 2]];
    walls.set(
      [...p, p[0], -0.025, p[2], ...q, ...q, p[0], -0.025, p[2], q[0], -0.025, q[2]],
      i * 18,
    );
  }
  return {
    positions,
    normals,
    uv,
    indices,
    walls,
    width,
    depth,
    minimum,
    verticalSpan,
    columns,
    rows,
    bounds,
    extent,
    footprint: `${bounds.x}/${bounds.z}/${bounds.width}/${bounds.depth}`,
  };
}
