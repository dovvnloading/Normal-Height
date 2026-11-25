import { describe, expect, it } from 'vitest';
import { noisePreviewKey } from '../src/hooks/noisePreviewProtocol';
import { frozenNoiseRecipe, parseNoiseCollection } from '../src/hooks/noiseStudioStorage';
import {
  decodeNoiseRecipe,
  encodeNoiseRecipe,
  resolveNoiseSeed,
  STUDIO_DEFAULTS,
} from '../src/model/noiseStudio';
import type { ParamValue } from '../src/model/types';

const params: Record<string, ParamValue> = {
  ...STUDIO_DEFAULTS,
  noiseModel: 'v3',
  seed: 87654,
  seedText: 'northern-ridge',
};
const saved = (id: string, value = params) => ({
  id,
  name: 'Northern ridge',
  createdAt: 1234,
  recipe: encodeNoiseRecipe(value),
});

describe('Noise Studio preview identity', () => {
  it('reuses a preview for equivalent parameter ordering but distinguishes physical extent, resolution, and world seed', () => {
    const request = { id: 'thumbnail', params, projectSeed: 42, worldSize: 4000, resolution: 96 };
    const reordered = Object.fromEntries(Object.entries(params).reverse());
    expect(noisePreviewKey({ ...request, id: 'another-card', params: reordered })).toBe(
      noisePreviewKey(request),
    );
    expect(noisePreviewKey({ ...request, worldSize: 8000 })).not.toBe(noisePreviewKey(request));
    expect(noisePreviewKey({ ...request, resolution: 160 })).not.toBe(noisePreviewKey(request));
    expect(noisePreviewKey({ ...request, projectSeed: 43 })).not.toBe(noisePreviewKey(request));
    expect(
      noisePreviewKey({ ...request, params: { ...params, seedText: 'Northern-ridge' } }),
    ).not.toBe(noisePreviewKey(request));
  });
});

describe('Noise Studio saved looks', () => {
  it('captures a world-linked stream without changing the source recipe', () => {
    const before = structuredClone(params);
    const restored = decodeNoiseRecipe(frozenNoiseRecipe(params, 42));
    expect(restored.seedLocked).toBe(true);
    expect(resolveNoiseSeed(restored, 100000)).toBe(resolveNoiseSeed(params, 42));
    expect(params).toEqual(before);
  });

  it('retains an already locked stream rather than recomputing it', () => {
    const locked = { ...params, seedLocked: true, lockedSeed: 4294967295 };
    const restored = decodeNoiseRecipe(frozenNoiseRecipe(locked, 17));
    expect(resolveNoiseSeed(restored, 99)).toBe(4294967295);
  });

  it('recovers cleanly from malformed, unsupported, or oversized browser storage', () => {
    for (const raw of [
      null,
      '{',
      'null',
      '[]',
      JSON.stringify({ version: 99, favorites: [saved('one')] }),
      ' '.repeat(1_000_001),
    ]) {
      expect(parseNoiseCollection(raw)).toEqual({ favorites: [], history: [] });
    }
  });

  it('validates each saved recipe and removes duplicate looks and identifiers', () => {
    const valid = saved('one');
    const corrupted = {
      ...saved('bad'),
      recipe: JSON.stringify({
        format: 'normal-height-noise',
        version: 1,
        engine: 3,
        params: { seed: -5 },
      }),
    };
    const duplicateId = saved('one', { ...params, seed: 999 });
    const duplicateRecipe = { ...valid, id: 'duplicate' };
    const collection = parseNoiseCollection(
      JSON.stringify({
        version: 1,
        favorites: [
          corrupted,
          valid,
          duplicateRecipe,
          duplicateId,
          { ...valid, id: 'bad-name', name: 'x'.repeat(121) },
        ],
        history: 'invalid',
      }),
    );
    expect(collection.favorites).toHaveLength(1);
    expect(collection.favorites[0].id).toBe('one');
    expect(collection.history).toEqual([]);
    expect(decodeNoiseRecipe(collection.favorites[0].recipe).seed).toBe(87654);
  });

  it('bounds each list independently to 24 validated records', () => {
    const entries = Array.from({ length: 80 }, (_, seed) =>
      saved(`seed-${seed}`, { ...params, seed }),
    );
    const collection = parseNoiseCollection(
      JSON.stringify({ version: 1, favorites: entries, history: entries }),
    );
    expect(collection.favorites).toHaveLength(24);
    expect(collection.history).toHaveLength(24);
    expect(decodeNoiseRecipe(collection.history.at(-1)!.recipe).seed).toBe(23);
  });
});
