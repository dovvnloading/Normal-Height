import { describe, expect, it } from 'vitest';
import { createWorldDefinition } from '../src/model/world';
import { DEFAULT_GENESIS, GENESIS_LITHOLOGIES } from '../src/model/genesis';
import { parseWorldViewSettings } from '../src/model/worldViewSettings';
import {
  GENESIS_LAYERS,
  sampleWorldProbe,
  worldLayerScale,
  worldMapPixels,
} from '../src/components/world/worldViewMath';
import type { WorldSnapshot } from '../src/components/world/worldViewMath';

function fixture(): WorldSnapshot {
  const world = createWorldDefinition({ worldSize: 100, heightScale: 2000 });
  world.domain.originX = 0;
  world.domain.originZ = 0;
  world.domain.datum = 200;
  world.genesis = { ...DEFAULT_GENESIS, enabled: true };
  return {
    world,
    grid: { startX: 0, startZ: 0, cellsX: 1024, cellsZ: 1024, samplesX: 2, samplesZ: 2 },
    result: {
      width: 2,
      height: 2,
      heights: Float32Array.of(0, 0.5, 0.5, 1),
      min: 0,
      max: 1,
      flow: new Float32Array(4),
      wear: new Float32Array(4),
      deposition: new Float32Array(4),
      stages: [],
      spacingX: 100,
      spacingZ: 100,
      duration: 1,
      backend: 'cpu-reference',
      estimatedPeakBytes: 0,
      genesis: {
        hardness: Float32Array.of(0, 1, 0, 1),
        lithology: Uint8Array.of(0, 3, 0, 3),
        uplift: Float32Array.of(0, 10, 0, 10),
        incision: Float32Array.of(0, 2, 0, 2),
        drainageArea: Float32Array.of(2500, 5000, 7500, 10000),
        channel: Float32Array.of(0, 1, 0, 1),
        report: {
          algorithmVersion: 'world-genesis-1',
          mode: 'multiscale-stream-power',
          width: 64,
          height: 64,
          spacingX: 100 / 63,
          spacingZ: 100 / 63,
          levels: [
            {
              width: 64,
              height: 64,
              spacingX: 100 / 63,
              spacingZ: 100 / 63,
              iterations: 1,
              durationYears: 100,
            },
          ],
          durationYears: 100,
          upliftVolumeM3: 0,
          incisedVolumeM3: 0,
          hillslopeRedistributedVolumeM3: 0,
          hillslopeResidualM3: 0,
          reconstructionVolumeM3: 0,
          finalVolumeChangeM3: 0,
          outletCount: 1,
          maxDrainageAreaM2: 10000,
          drainageAreaResidualM2: 0,
          durationMs: 10,
          limitations: [],
        },
      },
    },
  };
}

describe('Genesis diagnostic presentation', () => {
  it('probes scalar diagnostics in their physical units while preserving discrete rock classes', () => {
    const snapshot = fixture();
    const nearWest = sampleWorldProbe(snapshot, 25, 50)!;
    const nearEast = sampleWorldProbe(snapshot, 75, 50)!;
    expect(nearWest.genesis).toEqual({
      hardness: 0.25,
      lithology: 0,
      uplift: 2.5,
      incision: 0.5,
      drainageArea: 5625,
      channel: 0.25,
    });
    expect(nearEast.genesis?.lithology).toBe(3);
    expect(nearEast.genesis?.uplift).toBe(7.5);
    // Changing terrain scale/datum must not multiply metre or square-metre diagnostics.
    snapshot.world.domain.heightScale = 10;
    snapshot.world.domain.datum = -500;
    expect(sampleWorldProbe(snapshot, 25, 50)?.genesis).toEqual(nearWest.genesis);
  });

  it('renders rock IDs as exact class colors without blending nonexistent classes', () => {
    const snapshot = fixture();
    const pixels = worldMapPixels(snapshot, 'lithology', worldLayerScale(snapshot));
    const rgb = (hex: string) =>
      [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
    expect(Array.from(pixels.slice(0, 4))).toEqual([...rgb(GENESIS_LITHOLOGIES[0].color), 255]);
    expect(Array.from(pixels.slice(4, 8))).toEqual([...rgb(GENESIS_LITHOLOGIES[3].color), 255]);
    expect(Array.from(snapshot.result.genesis!.lithology)).toEqual([0, 3, 0, 3]);
  });

  it('keeps drainage colors anchored to the whole-world contributing area after cropping', () => {
    const whole = fixture();
    const crop = fixture();
    crop.grid.cellsX = 512;
    crop.result.genesis!.drainageArea = Float32Array.of(2500, 5000, 2500, 5000);
    const wholeScale = worldLayerScale(whole);
    const cropScale = worldLayerScale(crop);
    expect(cropScale.genesis?.drainageArea).toBe(10000);
    const a = worldMapPixels(whole, 'drainageArea', wholeScale);
    const b = worldMapPixels(crop, 'drainageArea', cropScale);
    expect(Array.from(b.slice(0, 8))).toEqual(Array.from(a.slice(0, 8)));
  });

  it('shows negative fault throw and positive uplift on opposite sides of a signed scale', () => {
    const snapshot = fixture();
    snapshot.result.genesis!.uplift = Float32Array.of(-10, 10, 0, 5);
    const scale = worldLayerScale(snapshot);
    expect(scale.genesis?.uplift).toBe(10);
    const pixels = worldMapPixels(snapshot, 'uplift', scale);
    expect(Array.from(pixels.slice(0, 4))).toEqual([47, 134, 185, 255]);
    expect(Array.from(pixels.slice(4, 8))).toEqual([218, 137, 68, 255]);
    expect(sampleWorldProbe(snapshot, 0, 0)?.genesis?.uplift).toBe(-10);
  });

  it('distinguishes absent Genesis diagnostics from a valid all-zero formation', () => {
    const missing = fixture();
    delete missing.result.genesis;
    expect(sampleWorldProbe(missing, 50, 50)?.genesis).toBeUndefined();
    expect(worldLayerScale(missing).genesis).toBeUndefined();
    const zero = fixture();
    zero.result.genesis!.hardness.fill(0);
    expect(worldMapPixels(missing, 'hardness', worldLayerScale(missing))).not.toEqual(
      worldMapPixels(zero, 'hardness', worldLayerScale(zero)),
    );
  });

  it('renders every diagnostic safely for zero ranges and keeps its saved layer choice', () => {
    const snapshot = fixture();
    snapshot.result.genesis!.uplift.fill(0);
    snapshot.result.genesis!.incision.fill(0);
    snapshot.result.genesis!.drainageArea.fill(0);
    snapshot.result.genesis!.report.maxDrainageAreaM2 = 0;
    for (const layer of GENESIS_LAYERS) {
      expect(parseWorldViewSettings({ layer }).layer).toBe(layer);
      const pixels = worldMapPixels(snapshot, layer, worldLayerScale(snapshot));
      expect(pixels.length).toBe(16);
      for (let i = 3; i < pixels.length; i += 4) expect(pixels[i]).toBe(255);
    }
    expect(parseWorldViewSettings({ layer: 'unknown-rocks' }).layer).toBe('relief');
  });
});
