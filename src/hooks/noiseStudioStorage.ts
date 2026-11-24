import { useEffect, useState } from 'react';
import {
  decodeNoiseRecipe,
  encodeNoiseRecipe,
  resolveNoiseSeed,
  STUDIO_KERNELS,
} from '../model/noiseStudio';
import type { ParamValue } from '../model/types';

const STORAGE_KEY = 'normal-height-noise-studio-v1';
const LIMIT = 24;
export interface SavedNoiseLook {
  id: string;
  name: string;
  recipe: string;
  createdAt: number;
}
export interface NoiseCollection {
  favorites: SavedNoiseLook[];
  history: SavedNoiseLook[];
}
const empty = (): NoiseCollection => ({ favorites: [], history: [] });

/** Stored browser data is untrusted, bounded, and validated by the recipe parser. */
export function parseNoiseCollection(raw: string | null): NoiseCollection {
  if (!raw || raw.length > 1_000_000) return empty();
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1)
      return empty();
    const clean = (items: unknown): SavedNoiseLook[] => {
      if (!Array.isArray(items)) return [];
      const seen = new Set<string>();
      const identifiers = new Set<string>();
      return items.slice(0, LIMIT).flatMap((item) => {
        if (
          !item ||
          typeof item !== 'object' ||
          typeof item.id !== 'string' ||
          item.id.length > 100 ||
          typeof item.name !== 'string' ||
          item.name.length > 120 ||
          typeof item.recipe !== 'string' ||
          typeof item.createdAt !== 'number' ||
          !Number.isFinite(item.createdAt)
        )
          return [];
        try {
          const params = decodeNoiseRecipe(item.recipe);
          const recipe = encodeNoiseRecipe(params);
          if (seen.has(recipe) || identifiers.has(item.id)) return [];
          seen.add(recipe);
          identifiers.add(item.id);
          return [{ id: item.id, name: item.name, recipe, createdAt: item.createdAt }];
        } catch {
          return [];
        }
      });
    };
    return {
      favorites: clean('favorites' in value ? value.favorites : undefined),
      history: clean('history' in value ? value.history : undefined),
    };
  } catch {
    return empty();
  }
}

/** Captures the random stream, so a saved look survives a later world-seed change. */
export function frozenNoiseRecipe(params: Record<string, ParamValue>, projectSeed: number): string {
  return encodeNoiseRecipe({
    ...params,
    seedLocked: true,
    lockedSeed: resolveNoiseSeed(params, projectSeed),
  });
}

function snapshot(params: Record<string, ParamValue>, projectSeed: number): SavedNoiseLook {
  const seed = resolveNoiseSeed(params, projectSeed);
  const kernel = STUDIO_KERNELS.find(([value]) => value === params.kernel)?.[1] ?? 'Noise';
  return {
    id: crypto.randomUUID(),
    name: `${kernel} · ${seed}`,
    recipe: frozenNoiseRecipe(params, projectSeed),
    createdAt: Date.now(),
  };
}

export function useNoiseCollection() {
  const [collection, setCollection] = useState<NoiseCollection>(() => {
    try {
      return parseNoiseCollection(localStorage.getItem(STORAGE_KEY));
    } catch {
      return empty();
    }
  });
  const [storageNotice, setStorageNotice] = useState('');
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ...collection }));
      setStorageNotice('');
    } catch {
      // Quota or privacy restrictions must never prevent editing the terrain.
      setStorageNotice('Saved for this session. Browser storage is unavailable.');
    }
  }, [collection]);
  const update = (change: (before: NoiseCollection) => NoiseCollection) => {
    setCollection(change);
  };
  const remember = (params: Record<string, ParamValue>[], projectSeed: number) => {
    const entries = params.map((p) => snapshot(p, projectSeed));
    update((before) => {
      let history = before.history;
      for (const entry of entries)
        history = [entry, ...history.filter((item) => item.recipe !== entry.recipe)].slice(
          0,
          LIMIT,
        );
      return { ...before, history };
    });
  };
  const toggleFavorite = (params: Record<string, ParamValue>, projectSeed: number) => {
    const entry = snapshot(params, projectSeed);
    if (
      collection.favorites.length >= LIMIT &&
      !collection.favorites.some((item) => item.recipe === entry.recipe)
    ) {
      setStorageNotice('24 favorites saved. Remove a favorite to keep another.');
      return;
    }
    update((before) => ({
      ...before,
      favorites: before.favorites.some((item) => item.recipe === entry.recipe)
        ? before.favorites.filter((item) => item.recipe !== entry.recipe)
        : [entry, ...before.favorites].slice(0, LIMIT),
    }));
  };
  return { collection, storageNotice, remember, toggleFavorite };
}
