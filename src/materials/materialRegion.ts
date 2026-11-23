import type { MaterialStroke } from './materialPaint';

/** Half-open source-grid coordinates in north-to-south row order. */
export interface TexelRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export function tileRect(n: number): TexelRect {
  return { left: 0, top: 0, right: n, bottom: n };
}
export function padRect(rect: TexelRect, n: number, pad: number): TexelRect {
  return {
    left: Math.max(0, rect.left - pad),
    top: Math.max(0, rect.top - pad),
    right: Math.min(n, rect.right + pad),
    bottom: Math.min(n, rect.bottom + pad),
  };
}
export function rectArea(rect: TexelRect) {
  return (rect.right - rect.left) * (rect.bottom - rect.top);
}

/** Every changed sample is inside the swept disks of the divergent suffixes. */
export function paintChangeBounds(
  before: readonly MaterialStroke[],
  after: readonly MaterialStroke[],
  n: number,
): TexelRect | null {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  if (start === before.length && start === after.length) return null;
  let left = n,
    top = n,
    right = 0,
    bottom = 0;
  const last = n - 1;
  for (const path of [before, after])
    for (let i = start; i < path.length; i++) {
      const { radius, points } = path[i];
      for (const { u, v } of points) {
        left = Math.min(left, (u - radius) * last);
        right = Math.max(right, (u + radius) * last);
        top = Math.min(top, (v - radius) * last);
        bottom = Math.max(bottom, (v + radius) * last);
      }
    }
  // Round outwards, including the disk perimeter for a hard-edge brush.
  return {
    left: Math.max(0, Math.floor(left)),
    top: Math.max(0, Math.floor(top)),
    right: Math.min(n, Math.ceil(right) + 1),
    bottom: Math.min(n, Math.ceil(bottom) + 1),
  };
}

/** Copy-on-write keeps an undo snapshot and any other live map consumer immutable. */
export function replaceRegion<T extends Uint8Array | Uint8ClampedArray | Float32Array>(
  original: T,
  patch: T,
  rect: TexelRect,
  n: number,
  channels: number,
): T {
  const output = original.slice() as T;
  const stride = (rect.right - rect.left) * channels;
  for (let y = rect.top; y < rect.bottom; y++) {
    const i = (y - rect.top) * stride;
    output.set(patch.subarray(i, i + stride), (y * n + rect.left) * channels);
  }
  return output;
}
