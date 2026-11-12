import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { geometryBufferBytes, timingDistribution } from './meshDiagnostics';

describe('mesh budget and frame-time audit helpers', () => {
  it('computes nearest-rank frame percentiles without assuming GPU time', () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(timingDistribution(samples)).toEqual({
      samples: 100, minMs: 1, p50Ms: 50, p95Ms: 95,
      p99Ms: 99, worstMs: 100,
    });
    expect(timingDistribution([Number.NaN, -2, Infinity])).toEqual({
      samples: 0, minMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, worstMs: 0,
    });
    expect(timingDistribution([5, 5, 12, 7, Number.NaN]).worstMs).toBe(12);
  });

  it('counts each underlying geometry buffer only once, including reused attributes', () => {
    const geometry = new THREE.BufferGeometry();
    const shared = new THREE.Float32BufferAttribute([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
    ], 3);
    geometry.setAttribute('position', shared);
    geometry.setAttribute('normal', shared);
    geometry.setIndex([0, 1, 2]);
    const indexedBytes = geometry.index!.array.byteLength;
    expect(geometryBufferBytes(geometry)).toBe(shared.array.byteLength + indexedBytes);
    expect(geometryBufferBytes(geometry, geometry)).toBe(shared.array.byteLength + indexedBytes);
    expect(geometryBufferBytes(null, undefined)).toBe(0);
    geometry.dispose();
  });
});
