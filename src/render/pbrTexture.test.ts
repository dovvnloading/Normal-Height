import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { updatePreviewTexture } from './pbrTexture';

const pixels = (size: number, value: number) =>
  new Uint8ClampedArray(size * size * 4).fill(value);

describe('PBR display texture recycling (#10)', () => {
  it('reuses GPU texture objects and updates their pixels for rapid material edits', () => {
    const original = pixels(4, 45);
    const a = updatePreviewTexture(undefined, original, 4, true, 4);
    expect(a.flipY).toBe(true);
    expect(a.colorSpace).toBe(THREE.SRGBColorSpace);
    const revision = a.version;
    const firstPixels = a.image.data!;
    expect(firstPixels.buffer).toBe(original.buffer);

    const next = pixels(4, 164);
    const b = updatePreviewTexture(a, next, 4, true, 4);
    expect(b).toBe(a);
    expect(b.version).toBeGreaterThan(revision);
    expect(b.image.data!.buffer).toBe(next.buffer);
    expect(b.image.data).not.toBe(firstPixels);
    expect(b.image.data![0]).toBe(164);
    b.dispose();
  });

  it('allocates fresh GPU resources only when dimensions or color space change', () => {
    const a = updatePreviewTexture(undefined, pixels(4, 1), 4, false, 2);
    const disposed = vi.fn();
    a.addEventListener('dispose', disposed);
    const b = updatePreviewTexture(a, pixels(8, 2), 8, false, 2);
    expect(b).not.toBe(a);
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(b.colorSpace).toBe(THREE.NoColorSpace);
    const c = updatePreviewTexture(b, pixels(8, 3), 8, true, 2);
    expect(c).not.toBe(b);
    expect(c.colorSpace).toBe(THREE.SRGBColorSpace);
    c.dispose();
  });

  it('refuses mismatched worker pixel data rather than uploading a corrupt texture', () => {
    expect(() => updatePreviewTexture(undefined, pixels(4, 0), 8, true, 1))
      .toThrow('dimensions');
  });
});
