/// <reference lib="webworker" />
import {
  createMaskEvaluator,
  pointInPaintSelection,
  type PaintMask,
  type PaintSelection,
} from '../materials/materialPaint';
import type { HeightField, TerrainProject } from '../model/types';

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.addEventListener(
  'message',
  (
    event: MessageEvent<{
      field: HeightField;
      project: TerrainProject;
      masks: (PaintMask | undefined)[];
      selection?: PaintSelection;
      showMask: boolean;
    }>,
  ) => {
    const { field, project, masks, selection, showMask } = event.data;
    const n = field.resolution;
    const pixels = new Uint8ClampedArray(n * n * 4);
    const rules = showMask
      ? masks
          .filter(Boolean)
          .map((mask) => createMaskEvaluator(mask, { field, project }, project.seed))
      : [];
    const selected = new Uint8Array(n * n);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const i = y * n + x,
          p = i * 4;
        const inside = pointInPaintSelection(selection, { u: x / (n - 1), v: y / (n - 1) });
        selected[i] = inside ? 1 : 0;
        const eligible = inside ? rules.reduce((amount, rule) => amount * rule(x, y), 1) : 0;
        if (rules.length && inside) {
          // Green marks terrain that the combined brush and layer rules allow.
          pixels[p] = 72;
          pixels[p + 1] = 213;
          pixels[p + 2] = 161;
          pixels[p + 3] = Math.round(eligible * 70);
        } else if (selection && !inside) {
          pixels[p] = 22;
          pixels[p + 1] = 34;
          pixels[p + 2] = 30;
          pixels[p + 3] = 55;
        }
      }
    if (selection)
      for (let y = 1; y < n - 1; y++)
        for (let x = 1; x < n - 1; x++) {
          const i = y * n + x;
          if (selected[i] && [i - 1, i + 1, i - n, i + n].some((next) => !selected[next])) {
            pixels.set([225, 255, 242, 230], i * 4);
          }
        }
    scope.postMessage({ pixels, resolution: n }, [pixels.buffer]);
  },
);
