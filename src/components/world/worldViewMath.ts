import type { WorldRegionResult } from '../../engine/world';
import type { WorldGridRequest } from '../../hooks/worldProtocol';
import type { WorldDefinition } from '../../model/world';
import type { WorldDisplayLayer } from '../../model/worldViewSettings';
import { GENESIS_LITHOLOGIES } from '../../model/genesis';

export type WorldRegion = Pick<WorldGridRequest, 'startX' | 'startZ' | 'cellsX' | 'cellsZ'>;
export type WorldViewMode = 'map' | 'terrain' | 'split';
export type WorldLayer = WorldDisplayLayer;
export type GenesisLayer =
  'hardness' | 'lithology' | 'uplift' | 'incision' | 'drainageArea' | 'channel';
export const GENESIS_LAYERS: readonly GenesisLayer[] = [
  'hardness',
  'lithology',
  'uplift',
  'incision',
  'drainageArea',
  'channel',
];
export const isGenesisLayer = (layer: WorldLayer): layer is GenesisLayer =>
  GENESIS_LAYERS.includes(layer as GenesisLayer);
const GENESIS_LITHOLOGY_COLORS: Record<number, number[]> = Object.fromEntries(
  GENESIS_LITHOLOGIES.map(({ id, color }) => [
    id,
    [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16)),
  ]),
);

export interface WorldSnapshot {
  result: WorldRegionResult;
  world: WorldDefinition;
  grid: WorldGridRequest;
  label?: string;
}

export interface WorldProbe {
  x: number;
  z: number;
  cellX: number;
  cellZ: number;
  elevation: number;
  slope: number;
  /** Downslope azimuth, clockwise from north; null on a flat surface. */
  aspect: number | null;
  flow: number;
  wear: number;
  deposition: number;
  /** Physical Genesis reference diagnostics, before optional World transport. */
  genesis?: {
    hardness: number;
    lithology: number;
    uplift: number;
    incision: number;
    drainageArea: number;
    channel: number;
  };
}

export interface WorldCamera {
  centerX: number;
  centerZ: number;
  zoom: number;
}

export interface ViewSize {
  width: number;
  height: number;
}

export interface WorldLayerScale {
  min: number;
  max: number;
  flow: number;
  wear: number;
  deposition: number;
  genesis?: { uplift: number; incision: number; drainageArea: number };
}

export const WORLD_LAYERS: ReadonlyArray<{
  id: WorldLayer;
  label: string;
  description: string;
}> = [
  { id: 'relief', label: 'Shaded relief', description: 'Elevation with physical terrain shading' },
  {
    id: 'elevation',
    label: 'Elevation',
    description: 'Height in metres, including the configured datum',
  },
  { id: 'contours', label: 'Contours', description: 'Elevation bands at a fixed metre interval' },
  { id: 'slope', label: 'Slope', description: 'Inclination derived from physical sample spacing' },
  { id: 'aspect', label: 'Aspect', description: 'Downslope direction, clockwise from north' },
  { id: 'flow', label: 'Flow', description: 'Relative flow signal from the evaluated terrain' },
  {
    id: 'wear',
    label: 'Erosion',
    description: 'Relative erosion diagnostic from the evaluated graph',
  },
  {
    id: 'deposition',
    label: 'Deposition',
    description: 'Relative deposition diagnostic from the evaluated graph',
  },
  { id: 'hardness', label: 'Rock hardness', description: 'Resistance to Genesis incision · 0–1' },
  { id: 'lithology', label: 'Lithology', description: 'Exposed rock layers · discrete classes' },
  { id: 'uplift', label: 'Tectonic uplift', description: 'Accumulated Genesis uplift in metres' },
  { id: 'incision', label: 'Channel incision', description: 'Genesis bedrock erosion in metres' },
  {
    id: 'drainageArea',
    label: 'Drainage area',
    description: 'Upstream contributing area in square metres',
  },
  { id: 'channel', label: 'River network', description: 'Drainage-derived channel strength · 0–1' },
];

export const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value));

export function fullWorldGrid(world: WorldDefinition): WorldGridRequest {
  return {
    startX: 0,
    startZ: 0,
    cellsX: world.domain.cellsX,
    cellsZ: world.domain.cellsZ,
    samplesX: 2,
    samplesZ: 2,
  };
}

export function worldGridBounds(world: WorldDefinition, grid: WorldRegion) {
  const d = world.domain;
  return {
    x: d.originX + (grid.startX / d.cellsX) * d.width,
    z: d.originZ + (grid.startZ / d.cellsZ) * d.depth,
    width: (grid.cellsX / d.cellsX) * d.width,
    depth: (grid.cellsZ / d.cellsZ) * d.depth,
  };
}

export function fitWorldCamera(world: WorldDefinition): WorldCamera {
  const d = world.domain;
  return { centerX: d.originX + d.width / 2, centerZ: d.originZ + d.depth / 2, zoom: 1 };
}

export function worldMapScale(world: WorldDefinition, size: ViewSize, zoom = 1) {
  return (
    Math.max(
      1e-12,
      Math.min(
        Math.max(1, size.width - 112) / world.domain.width,
        Math.max(1, size.height - 112) / world.domain.depth,
      ),
    ) * zoom
  );
}

export function screenToWorld(
  point: { x: number; y: number },
  camera: WorldCamera,
  world: WorldDefinition,
  size: ViewSize,
) {
  const scale = worldMapScale(world, size, camera.zoom);
  return {
    x: camera.centerX + (point.x - size.width / 2) / scale,
    z: camera.centerZ + (point.y - size.height / 2) / scale,
  };
}

export function zoomWorldCamera(
  camera: WorldCamera,
  factor: number,
  point: { x: number; y: number },
  world: WorldDefinition,
  size: ViewSize,
): WorldCamera {
  const before = screenToWorld(point, camera, world, size);
  const zoom = clamp(camera.zoom * factor, 0.25, 64);
  const after = screenToWorld(point, { ...camera, zoom }, world, size);
  return {
    centerX: camera.centerX + before.x - after.x,
    centerZ: camera.centerZ + before.z - after.z,
    zoom,
  };
}

export function frameWorldRegion(
  region: WorldRegion,
  world: WorldDefinition,
  size: ViewSize,
): WorldCamera {
  const bounds = worldGridBounds(world, region);
  const scale = worldMapScale(world, size);
  const desired = Math.min(
    Math.max(1, size.width - 144) / bounds.width,
    Math.max(1, size.height - 144) / bounds.depth,
  );
  return {
    centerX: bounds.x + bounds.width / 2,
    centerZ: bounds.z + bounds.depth / 2,
    zoom: clamp(desired / scale, 0.25, 64),
  };
}

/** Clip the visible camera footprint to whole world intervals for bounded detail sampling. */
export function visibleWorldRegion(
  camera: WorldCamera,
  world: WorldDefinition,
  size: ViewSize,
): WorldRegion | null {
  if (camera.zoom <= 1.4) return null;
  const northWest = screenToWorld({ x: 0, y: 0 }, camera, world, size);
  const southEast = screenToWorld({ x: size.width, y: size.height }, camera, world, size);
  const d = world.domain;
  if (
    northWest.x >= d.originX + d.width ||
    northWest.z >= d.originZ + d.depth ||
    southEast.x <= d.originX ||
    southEast.z <= d.originZ
  )
    return null;
  const startX = clamp(
    Math.floor(((northWest.x - d.originX) / d.width) * d.cellsX),
    0,
    d.cellsX - 1,
  );
  const startZ = clamp(
    Math.floor(((northWest.z - d.originZ) / d.depth) * d.cellsZ),
    0,
    d.cellsZ - 1,
  );
  const endX = clamp(
    Math.ceil(((southEast.x - d.originX) / d.width) * d.cellsX),
    startX + 1,
    d.cellsX,
  );
  const endZ = clamp(
    Math.ceil(((southEast.z - d.originZ) / d.depth) * d.cellsZ),
    startZ + 1,
    d.cellsZ,
  );
  if (startX === 0 && startZ === 0 && endX === d.cellsX && endZ === d.cellsZ) return null;
  return { startX, startZ, cellsX: endX - startX, cellsZ: endZ - startZ };
}

export function tileAtWorldPoint(x: number, z: number, world: WorldDefinition): WorldRegion | null {
  const d = world.domain;
  if (x < d.originX || z < d.originZ || x > d.originX + d.width || z > d.originZ + d.depth)
    return null;
  const cellX = clamp(((x - d.originX) / d.width) * d.cellsX, 0, d.cellsX - 1e-8);
  const cellZ = clamp(((z - d.originZ) / d.depth) * d.cellsZ, 0, d.cellsZ - 1e-8);
  const startX = Math.floor(cellX / world.tileCells) * world.tileCells;
  const startZ = Math.floor(cellZ / world.tileCells) * world.tileCells;
  return {
    startX,
    startZ,
    cellsX: Math.min(world.tileCells, d.cellsX - startX),
    cellsZ: Math.min(world.tileCells, d.cellsZ - startZ),
  };
}

export function unionWorldRegions(a: WorldRegion, b: WorldRegion): WorldRegion {
  const startX = Math.min(a.startX, b.startX),
    startZ = Math.min(a.startZ, b.startZ);
  return {
    startX,
    startZ,
    cellsX: Math.max(a.startX + a.cellsX, b.startX + b.cellsX) - startX,
    cellsZ: Math.max(a.startZ + a.cellsZ, b.startZ + b.cellsZ) - startZ,
  };
}

export function shiftWorldRegion(
  region: WorldRegion | null,
  dx: number,
  dz: number,
  world: WorldDefinition,
): WorldRegion {
  const d = world.domain;
  const base = region ?? { startX: 0, startZ: 0, cellsX: world.tileCells, cellsZ: world.tileCells };
  const startX = clamp(base.startX + (region ? dx : 0) * world.tileCells, 0, d.cellsX - 1);
  const startZ = clamp(base.startZ + (region ? dz : 0) * world.tileCells, 0, d.cellsZ - 1);
  return {
    startX: Math.min(Math.floor(startX / world.tileCells) * world.tileCells, d.cellsX - 1),
    startZ: Math.min(Math.floor(startZ / world.tileCells) * world.tileCells, d.cellsZ - 1),
    cellsX: Math.min(
      base.cellsX,
      d.cellsX - Math.floor(startX / world.tileCells) * world.tileCells,
    ),
    cellsZ: Math.min(
      base.cellsZ,
      d.cellsZ - Math.floor(startZ / world.tileCells) * world.tileCells,
    ),
  };
}

/** Bilinear sampling is a display interpolation, never additional terrain evaluation. */
export function sampleArray(
  data: Float32Array,
  width: number,
  height: number,
  u: number,
  v: number,
) {
  const x = clamp(u, 0, width - 1),
    z = clamp(v, 0, height - 1);
  const x0 = Math.floor(x),
    z0 = Math.floor(z),
    x1 = Math.min(width - 1, x0 + 1),
    z1 = Math.min(height - 1, z0 + 1);
  const a = data[z0 * width + x0] * (1 - (x - x0)) + data[z0 * width + x1] * (x - x0);
  const b = data[z1 * width + x0] * (1 - (x - x0)) + data[z1 * width + x1] * (x - x0);
  return a * (1 - (z - z0)) + b * (z - z0);
}

export function sampleGradient(
  field: WorldRegionResult,
  world: WorldDefinition,
  u: number,
  v: number,
) {
  const x0 = Math.max(0, u - 1),
    x1 = Math.min(field.width - 1, u + 1),
    z0 = Math.max(0, v - 1),
    z1 = Math.min(field.height - 1, v + 1);
  const integer = Number.isInteger(u) && Number.isInteger(v);
  const get = integer
    ? (x: number, z: number) => field.heights[z * field.width + x]
    : (x: number, z: number) => sampleArray(field.heights, field.width, field.height, x, z);
  const dx =
    ((get(x1, v) - get(x0, v)) * world.domain.heightScale) /
    Math.max(1e-12, (x1 - x0) * field.spacingX);
  const dz =
    ((get(u, z1) - get(u, z0)) * world.domain.heightScale) /
    Math.max(1e-12, (z1 - z0) * field.spacingZ);
  return { dx, dz };
}

export function sampleWorldProbe(snapshot: WorldSnapshot, x: number, z: number): WorldProbe | null {
  const { world, grid, result: field } = snapshot;
  const bounds = worldGridBounds(world, grid);
  const epsilon = Math.max(bounds.width, bounds.depth) * 1e-10;
  if (
    x < bounds.x - epsilon ||
    z < bounds.z - epsilon ||
    x > bounds.x + bounds.width + epsilon ||
    z > bounds.z + bounds.depth + epsilon
  )
    return null;
  const u = clamp(((x - bounds.x) / bounds.width) * (field.width - 1), 0, field.width - 1);
  const v = clamp(((z - bounds.z) / bounds.depth) * (field.height - 1), 0, field.height - 1);
  const get = (data: Float32Array) => sampleArray(data, field.width, field.height, u, v);
  const { dx, dz } = sampleGradient(field, world, u, v);
  const genesis = field.genesis;
  return {
    x,
    z,
    cellX: ((x - world.domain.originX) / world.domain.width) * world.domain.cellsX,
    cellZ: ((z - world.domain.originZ) / world.domain.depth) * world.domain.cellsZ,
    elevation: world.domain.datum + get(field.heights) * world.domain.heightScale,
    slope: Math.atan(Math.hypot(dx, dz)) * (180 / Math.PI),
    aspect: Math.hypot(dx, dz) < 1e-10 ? null : ((Math.atan2(-dx, dz) * 180) / Math.PI + 360) % 360,
    flow: get(field.flow),
    wear: get(field.wear),
    deposition: get(field.deposition),
    ...(genesis
      ? {
          genesis: {
            hardness: get(genesis.hardness),
            // A rock ID is a class, not a scalar; interpolation invents materials.
            lithology: genesis.lithology[Math.round(v) * field.width + Math.round(u)],
            uplift: get(genesis.uplift),
            incision: get(genesis.incision),
            drainageArea: get(genesis.drainageArea),
            channel: get(genesis.channel),
          },
        }
      : {}),
  };
}

export const probeWorld = sampleWorldProbe;

export function canCompareWorldSnapshots(a: WorldSnapshot, b: WorldSnapshot) {
  const aa = worldGridBounds(a.world, a.grid),
    bb = worldGridBounds(b.world, b.grid);
  const tolerance = Math.max(aa.width, aa.depth, bb.width, bb.depth) * 1e-9;
  return (['x', 'z', 'width', 'depth'] as const).every(
    (key) => Math.abs(aa[key] - bb[key]) <= tolerance,
  );
}

export function worldLayerScale(snapshot: WorldSnapshot): WorldLayerScale {
  const { result, world } = snapshot;
  let flow = 0,
    wear = 0,
    deposition = 0,
    uplift = 0,
    incision = 0;
  for (let i = 0; i < result.heights.length; i++) {
    flow = Math.max(flow, result.flow[i]);
    wear = Math.max(wear, result.wear[i]);
    deposition = Math.max(deposition, result.deposition[i]);
    if (result.genesis) {
      uplift = Math.max(uplift, Math.abs(result.genesis.uplift[i]));
      incision = Math.max(incision, result.genesis.incision[i]);
    }
  }
  return {
    min: world.domain.datum + result.min * world.domain.heightScale,
    max: world.domain.datum + result.max * world.domain.heightScale,
    flow,
    wear,
    deposition,
    ...(result.genesis
      ? {
          genesis: {
            uplift,
            incision,
            // Drainage always uses the whole-domain maximum, even for a cropped preview.
            drainageArea: result.genesis.report.maxDrainageAreaM2,
          },
        }
      : {}),
  };
}

/** A stable 1/2/5 metre interval shared across zoom levels. */
export function niceWorldDistance(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const power = Math.pow(10, Math.floor(Math.log10(value)));
  const fraction = value / power;
  return (fraction >= 5 ? 5 : fraction >= 2 ? 2 : 1) * power;
}

export function formatWorldDistance(metres: number, digits = 1) {
  const abs = Math.abs(metres);
  return abs >= 1000
    ? `${(metres / 1000).toLocaleString('en-US', { maximumFractionDigits: digits })} km`
    : `${metres.toLocaleString('en-US', { maximumFractionDigits: digits })} m`;
}

const reliefRamp = [
  [0, 35, 64, 62],
  [0.16, 65, 103, 85],
  [0.36, 115, 142, 104],
  [0.56, 175, 178, 124],
  [0.73, 197, 177, 140],
  [0.88, 207, 204, 183],
  [1, 239, 240, 227],
];
const elevationRamp = [
  [0, 31, 65, 83],
  [0.23, 58, 115, 115],
  [0.47, 123, 165, 126],
  [0.7, 199, 194, 138],
  [1, 247, 239, 199],
];

function rampColor(value: number, ramp: number[][]) {
  const v = clamp(value, 0, 1);
  const upper = Math.max(
    1,
    ramp.findIndex((stop) => stop[0] >= v),
  );
  const a = ramp[upper - 1],
    b = ramp[upper];
  const fraction = (v - a[0]) / (b[0] - a[0]);
  return [
    a[1] + (b[1] - a[1]) * fraction,
    a[2] + (b[2] - a[2]) * fraction,
    a[3] + (b[3] - a[3]) * fraction,
  ];
}

function hueColor(degrees: number) {
  const hue = (((degrees % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((hue % 2) - 1);
  const rgb =
    hue < 1
      ? [1, x, 0]
      : hue < 2
        ? [x, 1, 0]
        : hue < 3
          ? [0, 1, x]
          : hue < 4
            ? [0, x, 1]
            : hue < 5
              ? [x, 0, 1]
              : [1, 0, x];
  return rgb.map((c) => 65 + c * 150);
}

export function worldDifferenceRange(snapshot: WorldSnapshot, comparison: WorldSnapshot) {
  if (!canCompareWorldSnapshots(snapshot, comparison)) return 0;
  const a = snapshot.result,
    b = comparison.result;
  let maximum = 0;
  for (let z = 0; z < a.height; z++)
    for (let x = 0; x < a.width; x++) {
      const before =
        comparison.world.domain.datum +
        sampleArray(
          b.heights,
          b.width,
          b.height,
          (x / (a.width - 1)) * (b.width - 1),
          (z / (a.height - 1)) * (b.height - 1),
        ) *
          comparison.world.domain.heightScale;
      const after =
        snapshot.world.domain.datum +
        a.heights[z * a.width + x] * snapshot.world.domain.heightScale;
      maximum = Math.max(maximum, Math.abs(after - before));
    }
  return maximum;
}

/** Rasterize genuine samples only. Scale is supplied by the retained overview, not the view crop. */
export function worldMapPixels(
  snapshot: WorldSnapshot,
  layer: WorldLayer,
  scale: WorldLayerScale,
  difference?: { snapshot: WorldSnapshot; max: number },
): Uint8ClampedArray {
  const { result: field, world } = snapshot;
  const pixels = new Uint8ClampedArray(field.width * field.height * 4);
  const span = Math.max(1e-8, scale.max - scale.min);
  const contourInterval = niceWorldDistance(span / 12);
  const comparable = difference && canCompareWorldSnapshots(snapshot, difference.snapshot);
  const needsGradient = !comparable && ['relief', 'contours', 'slope', 'aspect'].includes(layer);
  for (let z = 0; z < field.height; z++)
    for (let x = 0; x < field.width; x++) {
      const i = z * field.width + x;
      const metres = world.domain.datum + field.heights[i] * world.domain.heightScale;
      const value = clamp((metres - scale.min) / span, 0, 1);
      const { dx, dz } = needsGradient ? sampleGradient(field, world, x, z) : { dx: 0, dz: 0 };
      const slope = (Math.atan(Math.hypot(dx, dz)) * 180) / Math.PI;
      const light = Math.max(0, (-dx * -0.58 + 0.69 - dz * -0.43) / Math.hypot(dx, 1, dz));
      let rgb: number[];
      if (comparable && difference) {
        const before = difference.snapshot;
        const b = before.result;
        const previous =
          before.world.domain.datum +
          sampleArray(
            b.heights,
            b.width,
            b.height,
            (x / (field.width - 1)) * (b.width - 1),
            (z / (field.height - 1)) * (b.height - 1),
          ) *
            before.world.domain.heightScale;
        const delta = metres - previous;
        const t = clamp(Math.abs(delta) / Math.max(difference.max, 1e-10), 0, 1);
        const base = [224, 230, 219];
        const end = delta < 0 ? [47, 134, 185] : [218, 137, 68];
        rgb = base.map((c, k) => c + (end[k] - c) * t);
      } else if (isGenesisLayer(layer)) {
        const genesis = field.genesis;
        if (!genesis) {
          // A missing diagnostic is not a measurement of zero.
          rgb = (x + z) % 12 < 6 ? [103, 112, 109] : [112, 121, 118];
        } else if (layer === 'lithology') {
          rgb = GENESIS_LITHOLOGY_COLORS[genesis.lithology[i]] ?? [126, 126, 126];
        } else if (layer === 'hardness') {
          rgb = rampColor(genesis.hardness[i], [
            [0, 227, 197, 139],
            [0.5, 151, 120, 103],
            [1, 55, 69, 85],
          ]);
        } else if (layer === 'drainageArea') {
          const maximum = scale.genesis?.drainageArea ?? genesis.report.maxDrainageAreaM2;
          const v =
            Math.log1p(Math.max(0, genesis.drainageArea[i])) / Math.max(1e-10, Math.log1p(maximum));
          rgb = rampColor(v, [
            [0, 25, 44, 53],
            [0.7, 46, 116, 137],
            [1, 169, 236, 232],
          ]);
        } else if (layer === 'channel') {
          rgb = rampColor(genesis.channel[i], [
            [0, 29, 46, 52],
            [0.4, 48, 105, 126],
            [1, 155, 229, 240],
          ]);
        } else if (layer === 'incision') {
          const maximum = scale.genesis?.incision ?? 0;
          rgb = rampColor(genesis.incision[i] / Math.max(maximum, 1e-10), [
            [0, 47, 42, 37],
            [0.5, 173, 106, 65],
            [1, 247, 209, 147],
          ]);
        } else {
          const maximum = scale.genesis?.uplift ?? 0;
          rgb = rampColor(0.5 + (0.5 * genesis.uplift[i]) / Math.max(maximum, 1e-10), [
            [0, 47, 134, 185],
            [0.5, 224, 230, 219],
            [1, 218, 137, 68],
          ]);
        }
      } else if (layer === 'flow') {
        const v =
          Math.log1p(Math.max(0, field.flow[i]) * 80) /
          Math.max(1e-10, Math.log1p(scale.flow * 80));
        rgb = [24 + 99 * v, 48 + 167 * v, 59 + 177 * v];
      } else if (layer === 'wear' || layer === 'deposition') {
        const data = layer === 'wear' ? field.wear : field.deposition;
        const maximum = layer === 'wear' ? scale.wear : scale.deposition;
        const v = clamp(data[i] / Math.max(maximum, 1e-10), 0, 1);
        rgb =
          layer === 'wear'
            ? [47 + 199 * v, 42 + 122 * v, 37 + 64 * v]
            : [26 + 114 * v, 49 + 173 * v, 43 + 122 * v];
      } else if (layer === 'slope') {
        rgb = rampColor(slope / 90, [
          [0, 41, 73, 69],
          [0.2, 107, 160, 129],
          [0.45, 221, 200, 124],
          [0.7, 221, 135, 75],
          [1, 150, 62, 68],
        ]);
      } else if (layer === 'aspect') {
        rgb =
          Math.hypot(dx, dz) < 1e-10
            ? [169, 180, 176]
            : hueColor(((Math.atan2(-dx, dz) * 180) / Math.PI + 360) % 360);
      } else {
        rgb = rampColor(value, layer === 'elevation' ? elevationRamp : reliefRamp);
        if (layer === 'relief' || layer === 'contours') {
          const shade = 0.58 + 0.53 * light;
          rgb = rgb.map((c) => c * shade);
        }
        if (layer === 'contours') {
          const nearest = Math.abs(metres - Math.round(metres / contourInterval) * contourInterval);
          const pixelRise = Math.max(Math.abs(dx * field.spacingX), Math.abs(dz * field.spacingZ));
          const line =
            1 -
            clamp(
              nearest /
                Math.max(
                  contourInterval * 0.015,
                  Math.min(contourInterval * 0.22, pixelRise * 0.65),
                ),
              0,
              1,
            );
          rgb = rgb.map((c) => c * (1 - 0.5 * line));
        }
      }
      for (let k = 0; k < 3; k++) pixels[i * 4 + k] = clamp(rgb[k], 0, 255);
      pixels[i * 4 + 3] = 255;
    }
  return pixels;
}
