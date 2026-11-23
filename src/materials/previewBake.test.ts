import { describe, expect, it, vi } from 'vitest';
import { createProject } from '../model/presets';
import type { HeightField } from '../model/types';
import { packPreviewPBR } from '../render/previewMaterial';
import type { MaterialStroke } from './materialPaint';
import { paintChangeBounds, type TexelRect } from './materialRegion';
import { generatePBR } from './pbr';
import { packedPreview, requestPBR } from './pbrClient';
import { assemblePreview, bakePreview } from './previewBake';

const n = 65;
function field(): HeightField {
  return {
    resolution: n,
    height: Float32Array.from(
      { length: n * n },
      (_, i) => 0.19 + 0.28 * ((i % n) / (n - 1)) + 0.17 * Math.sin(Math.floor(i / n) * 0.08),
    ),
    flow: new Float32Array(n * n),
    wear: new Float32Array(n * n),
    deposition: new Float32Array(n * n),
  };
}
const scene = { ...createProject(), worldSize: 300, heightScale: 200 };
const a: MaterialStroke = {
  layer: 'rock',
  radius: 0.07,
  hardness: 0.55,
  strength: 0.75,
  points: [
    { u: 0, v: 0 },
    { u: 0.13, v: 0.11 },
  ],
};
const b: MaterialStroke = {
  ...a,
  layer: 'snow',
  radius: 0.08,
  hardness: 1,
  points: [
    { u: 0.98, v: 0.8 },
    { u: 1, v: 1 },
  ],
};
const erase: MaterialStroke = { ...b, layer: 'erase', radius: 0.045 };

describe('incremental preview baking', () => {
  it('matches every byte of a fresh bake across edits, erasure, reordering and undo, including the derivative halo', () => {
    const dem = field();
    const initial = bakePreview(dem, scene);
    let snapshot = assemblePreview(n, initial),
      strokes: MaterialStroke[] = [];
    const first = snapshot.maps.basecolor.slice();
    const original = snapshot.maps;
    for (const next of [[a], [a, b], [a, b, erase], [a, b], [b, a], [], [b]]) {
      const project = { ...scene, materialPaint: next };
      const rect = paintChangeBounds(strokes, next, n)!;
      const bake = bakePreview(dem, project, rect, initial.ranges);
      snapshot = assemblePreview(n, bake, snapshot);
      const full = generatePBR(dem, project);
      const packed = packPreviewPBR(full, dem, project);
      // Byte comparisons also check all Float32 relief bits at the boundary.
      for (const name of ['detail', 'basecolor', 'roughness', 'splat', 'ao', 'curvature'] as const)
        expect(
          Buffer.compare(Buffer.from(snapshot.maps[name].buffer), Buffer.from(full[name].buffer)),
          name,
        ).toBe(0);
      expect(
        Buffer.compare(Buffer.from(snapshot.packed.orm.buffer), Buffer.from(packed.orm.buffer)),
      ).toBe(0);
      expect(
        Buffer.compare(
          Buffer.from(snapshot.packed.microNormal.buffer),
          Buffer.from(packed.microNormal.buffer),
        ),
      ).toBe(0);
      expect(original.ao).toBe(snapshot.maps.ao);
      expect(original.curvature).toBe(snapshot.maps.curvature);
      strokes = next;
    }
    expect(Buffer.compare(Buffer.from(first.buffer), Buffer.from(original.basecolor.buffer))).toBe(
      0,
    );
  });

  it('requests local work only on compatible completed snapshots, and terminates superseded shared work', async () => {
    const workers: Array<{ dirty?: TexelRect; terminated: boolean; complete(): void }> = [];
    class MockWorker {
      terminated = false;
      dirty?: TexelRect;
      complete = () => {};
      onmessage?: (event: unknown) => void;
      constructor() {
        workers.push(this);
      }
      postMessage(message: { field: HeightField; project: typeof scene; dirty?: TexelRect }) {
        this.dirty = message.dirty;
        this.complete = () =>
          this.onmessage?.({
            data: {
              type: 'result',
              bake: bakePreview(message.field, message.project, message.dirty),
            },
          });
      }
      terminate() {
        this.terminated = true;
      }
    }
    vi.stubGlobal('Worker', MockWorker);
    try {
      const dem = field();
      const first = requestPBR(dem, scene);
      workers[0].complete();
      const base = await first.promise;
      first.release();
      const next = { ...scene, materialPaint: [a] };
      const paint = requestPBR(dem, next),
        other = requestPBR(dem, next);
      expect(workers).toHaveLength(2);
      expect(workers[1].dirty).toEqual(paintChangeBounds([], [a], n));
      paint.release();
      expect(workers[1].terminated).toBe(false);
      workers[1].complete();
      const mapped = await other.promise;
      other.release();
      expect(mapped.ao).toBe(base.ao);
      expect(packedPreview(mapped)?.orm).toBeDefined();
      const anotherSurface = requestPBR(dem, { ...next, worldSize: 600 });
      expect(workers[2].dirty).toBeUndefined();
      const canceled = expect(anotherSurface.promise).rejects.toThrow('superseded');
      anotherSurface.release();
      await canceled;
      expect(workers[2].terminated).toBe(true);
      const large = requestPBR(dem, { ...next, materialPaint: [a, { ...b, radius: 1 }] });
      expect(workers[3].dirty).toBeUndefined();
      workers[3].complete();
      await large.promise;
      large.release();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
