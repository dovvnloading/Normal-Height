import { describe, expect, it } from 'vitest';
import {
  terrainAspectResize,
  terrainAspectScale,
} from '../src/components/world/worldTerrainCamera';

describe('world terrain aspect framing', () => {
  it('keeps the limiting orthographic dimension large enough in wide and narrow panes', () => {
    for (const aspect of [0.3, 0.6, 1, 1.5, 2.4]) {
      const halfHeight = 0.9 * terrainAspectScale(aspect);
      expect(Math.min(halfHeight, aspect * halfHeight)).toBeCloseTo(0.9, 12);
    }
  });

  it('preserves relative perspective zoom across a narrower split and back', () => {
    const userDistance = 3.7;
    const narrowerDistance = userDistance * terrainAspectResize(1.8, 0.6);
    expect(narrowerDistance / terrainAspectScale(0.6)).toBeCloseTo(userDistance, 12);
    expect(narrowerDistance * terrainAspectResize(0.6, 1.8)).toBeCloseTo(userDistance, 12);
  });

  it('does not compound aspect compensation after restoring a saved narrow view', () => {
    expect(terrainAspectResize(0.6, 0.6)).toBe(1);
    expect(terrainAspectScale(0)).toBe(1);
    expect(terrainAspectScale(NaN)).toBe(1);
  });
});
