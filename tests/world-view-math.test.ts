import { describe, expect, it } from 'vitest';
import { createWorldDefinition } from '../src/model/world';
import type { WorldRegionResult } from '../src/engine/world';
import {
  canCompareWorldSnapshots,
  fitWorldCamera,
  frameWorldRegion,
  sampleWorldProbe,
  screenToWorld,
  shiftWorldRegion,
  tileAtWorldPoint,
  unionWorldRegions,
  visibleWorldRegion,
  worldDifferenceRange,
  worldGridBounds,
  worldLayerScale,
  worldMapPixels,
  worldMapScale,
  zoomWorldCamera,
} from '../src/components/world/worldViewMath';
import type { WorldSnapshot } from '../src/components/world/worldViewMath';

function plane(): WorldSnapshot {
  const world = createWorldDefinition({ worldSize: 4000, heightScale: 2 });
  Object.assign(world.domain, {
    originX: 500,
    originZ: -200,
    width: 20,
    depth: 40,
    cellsX: 8,
    cellsZ: 8,
    datum: 100,
  });
  const heights = new Float32Array(9);
  for (let z = 0; z < 3; z++)
    for (let x = 0; x < 3; x++) heights[z * 3 + x] = (x * 10 + z * 40 - 5) / 2;
  const result: WorldRegionResult = {
    width: 3,
    height: 3,
    heights,
    flow: new Float32Array(9).fill(0.5),
    wear: new Float32Array(9).fill(0.1),
    deposition: new Float32Array(9).fill(0.2),
    min: -2.5,
    max: 47.5,
    stages: [],
    spacingX: 10,
    spacingZ: 20,
    duration: 1,
    backend: 'cpu-reference',
    estimatedPeakBytes: 0,
  };
  return {
    result,
    world,
    grid: { startX: 0, startZ: 0, cellsX: 8, cellsZ: 8, samplesX: 3, samplesZ: 3 },
  };
}

describe('world map navigation', () => {
  const world = createWorldDefinition({ worldSize: 4000, heightScale: 1800 });
  const size = { width: 1000, height: 680 };
  it('keeps the exact physical point beneath the cursor while zooming and clamping', () => {
    const camera = fitWorldCamera(world);
    const cursor = { x: 743, y: 192 };
    const before = screenToWorld(cursor, camera, world, size);
    for (const factor of [0.001, 0.25, 2, 50, 10000]) {
      const next = zoomWorldCamera(camera, factor, cursor, world, size);
      const after = screenToWorld(cursor, next, world, size);
      expect(after.x).toBeCloseTo(before.x, 8);
      expect(after.z).toBeCloseTo(before.z, 8);
      expect(next.zoom).toBeGreaterThanOrEqual(0.25);
      expect(next.zoom).toBeLessThanOrEqual(64);
    }
  });
  it('frames a selected region at its physical center within the view', () => {
    const region = { startX: 256, startZ: 512, cellsX: 256, cellsZ: 128 };
    const bounds = worldGridBounds(world, region);
    const camera = frameWorldRegion(region, world, size);
    expect(camera.centerX).toBe(bounds.x + bounds.width / 2);
    expect(camera.centerZ).toBe(bounds.z + bounds.depth / 2);
    expect(bounds.width * worldMapScale(world, size, camera.zoom)).toBeLessThanOrEqual(
      size.width - 143,
    );
    expect(bounds.depth * worldMapScale(world, size, camera.zoom)).toBeLessThanOrEqual(
      size.height - 143,
    );
  });
  it('uses the last partial tile at inclusive east and south world edges', () => {
    const partial = structuredClone(world);
    partial.domain.cellsX = 1000;
    partial.domain.cellsZ = 700;
    const tile = tileAtWorldPoint(2000, 2000, partial);
    expect(tile).toEqual({ startX: 768, startZ: 512, cellsX: 232, cellsZ: 188 });
    expect(tileAtWorldPoint(2000.1, 2000, partial)).toBeNull();
    expect(tileAtWorldPoint(-2000, -2000, partial)).toEqual({
      startX: 0,
      startZ: 0,
      cellsX: 256,
      cellsZ: 256,
    });
  });
  it('extends a region in any direction without losing its anchor', () => {
    expect(
      unionWorldRegions(
        { startX: 256, startZ: 512, cellsX: 256, cellsZ: 256 },
        { startX: 0, startZ: 256, cellsX: 256, cellsZ: 256 },
      ),
    ).toEqual({ startX: 0, startZ: 256, cellsX: 512, cellsZ: 512 });
    expect(shiftWorldRegion(null, 1, 0, world)).toEqual({
      startX: 0,
      startZ: 0,
      cellsX: 256,
      cellsZ: 256,
    });
    expect(
      shiftWorldRegion({ startX: 768, startZ: 768, cellsX: 256, cellsZ: 256 }, 1, 1, world),
    ).toEqual({ startX: 768, startZ: 768, cellsX: 256, cellsZ: 256 });
  });
  it('requests only visible integer intervals after zoom, clipped at physical world edges', () => {
    const camera = fitWorldCamera(world);
    expect(visibleWorldRegion(camera, world, size)).toBeNull();
    const visible = visibleWorldRegion({ ...camera, zoom: 5 }, world, size)!;
    expect(visible.cellsX).toBeLessThan(world.domain.cellsX);
    expect(visible.cellsZ).toBeLessThan(world.domain.cellsZ);
    for (const value of Object.values(visible)) expect(Number.isInteger(value)).toBe(true);
    const edge = visibleWorldRegion({ centerX: -2000, centerZ: -2000, zoom: 5 }, world, size)!;
    expect(edge.startX).toBe(0);
    expect(edge.startZ).toBe(0);
    expect(
      visibleWorldRegion({ centerX: 200000, centerZ: 200000, zoom: 5 }, world, size),
    ).toBeNull();
  });
});

describe('physical world inspection', () => {
  it('probes real elevation with datum, relative diagnostics, slope, and clockwise downslope azimuth', () => {
    const snapshot = plane();
    const probe = sampleWorldProbe(snapshot, 510, -180)!;
    expect(probe.elevation).toBeCloseTo(145);
    expect(probe.slope).toBeCloseTo((Math.atan(Math.sqrt(5)) * 180) / Math.PI);
    expect(probe.aspect).toBeCloseTo(333.434948822922);
    expect(probe.cellX).toBe(4);
    expect(probe.cellZ).toBe(4);
    expect(probe.wear).toBeCloseTo(0.1);
    expect(probe.deposition).toBeCloseTo(0.2);
    expect(probe.flow).toBe(0.5);
  });
  it('uses one-sided gradients at boundaries and bilinear interpolation between samples', () => {
    const snapshot = plane();
    const corner = sampleWorldProbe(snapshot, 500, -200)!;
    const inside = sampleWorldProbe(snapshot, 505, -190)!;
    expect(corner.elevation).toBeCloseTo(95);
    expect(inside.elevation).toBeCloseTo(120);
    expect(corner.slope).toBeCloseTo(inside.slope);
    expect(sampleWorldProbe(snapshot, 499, -190)).toBeNull();
    expect(sampleWorldProbe(snapshot, 520, -160)).not.toBeNull();
  });
  it('reports no azimuth for flat ground', () => {
    const snapshot = plane();
    snapshot.result.heights.fill(1);
    expect(sampleWorldProbe(snapshot, 510, -180)?.aspect).toBeNull();
    expect(sampleWorldProbe(snapshot, 510, -180)?.slope).toBe(0);
  });
  it('compares physical footprints rather than sample dimensions or interval numbering', () => {
    const a = plane(),
      b = plane();
    b.world.domain.cellsX = 16;
    b.grid.cellsX = 16;
    b.grid.samplesX = 128;
    expect(canCompareWorldSnapshots(a, b)).toBe(true);
    b.world.domain.originX += 1;
    expect(canCompareWorldSnapshots(a, b)).toBe(false);
  });
  it('computes differences in physical metres, including changes to datum and height scale', () => {
    const previous = plane(),
      current = plane();
    current.world.domain.datum += 12;
    expect(worldDifferenceRange(current, previous)).toBeCloseTo(12);
    current.world.domain.heightScale = 4;
    expect(worldDifferenceRange(current, previous)).toBeCloseTo(107);
  });
  it('renders every supported layer without mutating terrain, using a supplied stable scale', () => {
    const snapshot = plane();
    const original = snapshot.result.heights.slice();
    const scale = worldLayerScale(snapshot);
    expect(scale.min).toBe(95);
    expect(scale.max).toBe(195);
    for (const layer of [
      'relief',
      'elevation',
      'flow',
      'wear',
      'deposition',
      'slope',
      'contours',
      'aspect',
    ] as const) {
      const pixels = worldMapPixels(snapshot, layer, scale);
      expect(pixels).toHaveLength(36);
      for (let i = 3; i < pixels.length; i += 4) expect(pixels[i]).toBe(255);
    }
    expect(snapshot.result.heights).toEqual(original);
    const cropped = { ...snapshot, result: { ...snapshot.result, min: 10, max: 30 } };
    expect(worldMapPixels(cropped, 'elevation', scale)).toEqual(
      worldMapPixels(snapshot, 'elevation', scale),
    );
  });
});
