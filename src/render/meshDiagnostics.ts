import type * as THREE from 'three';

/** A CPU-side estimate of live vertex/index storage, not measured VRAM. */
export function geometryBufferBytes(...geometries: Array<THREE.BufferGeometry | null | undefined>): number {
  let bytes = 0;
  const seen = new Set<ArrayBufferLike>();
  for (const geometry of geometries) {
    if (!geometry) continue;
    const attributes = Object.values(geometry.attributes);
    if (geometry.index) attributes.push(geometry.index);
    for (const attribute of attributes) {
      const buffer = attribute.isInterleavedBufferAttribute
        ? attribute.data.array.buffer : attribute.array.buffer;
      if (!seen.has(buffer)) {
        seen.add(buffer);
        bytes += buffer.byteLength;
      }
    }
  }
  return bytes;
}

export interface TimingDistribution {
  samples: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  worstMs: number;
}

/** Nearest-rank percentiles (no interpolation that invents extra samples). */
export function timingDistribution(values: readonly number[]): TimingDistribution {
  const sorted = values.filter(v => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (!sorted.length)
    return { samples: 0, minMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, worstMs: 0 };
  const percentile = (fraction: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  return {
    samples: sorted.length,
    minMs: sorted[0],
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    worstMs: sorted[sorted.length - 1],
  };
}
