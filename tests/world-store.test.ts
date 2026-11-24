import { describe, expect, it } from 'vitest';
import { createWorldRegionStore, WORLD_REGION_CACHE_VERSION } from '../src/engine/worldStore';
import { MemoryWorldRegionStorage } from '../src/engine/worldStore/storage';
import type { StoredRegion, WorldRegionStorage } from '../src/engine/worldStore/storage';
import { regionBytes, regionChecksum } from '../src/engine/worldStore/codec';
import type { WorldRegionResult } from '../src/engine/world';

function region(offset = 0): WorldRegionResult {
  const zeros = new Float32Array(16);
  return { width: 4, height: 4, heights: Float32Array.from({ length: 16 }, (_, i) => i / 16 + offset),
    flow: zeros, wear: zeros, deposition: zeros, min: offset, max: offset + 15 / 16,
    spacingX: 10, spacingZ: 20, duration: 2, backend: 'cpu-reference', estimatedPeakBytes: 1024,
    stages: [{ nodeId: 'source', label: 'Source', kind: 'noise', scope: 'pointwise', mode: 'native',
      backend: 'cpu-reference', algorithmVersion: 'world-noise-1', samplesX: 4, samplesZ: 4,
      spacingX: 10, spacingZ: 20, simulationResolution: null, reason: 'Native sampling' }] };
}
class InspectableStorage extends MemoryWorldRegionStorage {
  corrupt(key: string, change: (record: StoredRegion) => void) { change(this.records.get(key)!); }
  inject(record: StoredRegion) { this.records.set(record.key, record); }
}

describe('bounded, rebuildable world region storage', () => {
  it('copies only owned snapshots, preserves aliases and survives transferred results', async () => {
    const store = await createWorldRegionStore({ storage: null });
    const source = region();
    await store.put('a', source);
    source.heights.fill(-200);
    const first = (await store.get('a'))!;
    expect(first.heights[0]).toBe(0);
    expect(first.flow).toBe(first.wear);
    expect(store.stats().bytes).toBe(regionBytes('a', region()));
    first.heights.fill(99);
    const second = (await store.get('a'))!;
    expect(second.heights[0]).toBe(0);
    structuredClone(second, { transfer: [...new Set([second.heights.buffer, second.flow.buffer])] });
    expect((await store.get('a'))!.heights).toEqual(region().heights);
    expect(store.stats()).toMatchObject({ hits: 3, misses: 0, entries: 1, backend: 'memory' });
    await store.close();
  });

  it('evicts the least recently used entries within the byte and count budgets', async () => {
    const bytes = regionBytes('a', region());
    const store = await createWorldRegionStore({ storage: null, maxBytes: bytes * 2 });
    await store.put('a', region());
    await store.put('b', region());
    await store.get('a');
    await store.put('c', region());
    expect(await store.get('b')).toBeNull();
    expect(await store.get('a')).not.toBeNull();
    expect(await store.get('c')).not.toBeNull();
    expect(store.stats()).toMatchObject({ entries: 2, evictions: 1, bytes: bytes * 2 });
    const limited = await createWorldRegionStore({ storage: null, maxEntries: 1 });
    await limited.put('a', region());
    await limited.put('b', region());
    expect(limited.stats().entries).toBe(1);
    expect(await limited.get('a')).toBeNull();
  });

  it('rejects oversized or unsupported writes without evicting the last complete CPU region', async () => {
    const store = await createWorldRegionStore({ storage: null, maxBytes: regionBytes('a', region()) });
    await store.put('a', region());
    await store.put('much-longer-key', region());
    await store.put('a', { ...region(), backend: 'webgpu' });
    const invalid = region();
    invalid.heights[0] = NaN;
    await store.put('a', invalid);
    expect(store.stats().rejectedWrites).toBe(3);
    expect((await store.get('a'))!.heights[0]).toBe(0);
  });

  it('checks channel content, metadata and schema version before returning cached data', async () => {
    const storage = new InspectableStorage();
    const store = await createWorldRegionStore({ storage });
    await store.put('a', region());
    storage.corrupt('a', (record) => { record.result.heights[3] += 1; });
    expect(await store.get('a')).toBeNull();
    await store.put('b', region());
    storage.corrupt('b', (record) => { record.result.spacingX = 21; });
    expect(await store.get('b')).toBeNull();
    await store.put('c', region());
    storage.corrupt('c', (record) => { record.version = 'obsolete'; });
    expect(await store.get('c')).toBeNull();
    expect(store.stats()).toMatchObject({ corruptEntries: 3, bytes: 0, entries: 0 });
  });

  it('cleans incompatible versions at open and restores complete compatible entries', async () => {
    const storage = new InspectableStorage();
    const result = region();
    storage.inject({ key: 'old', version: 'old-0', result, checksum: regionChecksum(result),
      bytes: regionBytes('old', result), lastUsed: 1 });
    storage.inject({ key: 'new', version: WORLD_REGION_CACHE_VERSION, result, checksum: regionChecksum(result),
      bytes: regionBytes('new', result), lastUsed: 2 });
    const store = await createWorldRegionStore({ storage });
    expect(await store.get('old')).toBeNull();
    expect((await store.get('new'))!.heights).toEqual(result.heights);
    expect(store.stats().entries).toBe(1);
  });

  it('falls back to bounded memory on quota failure and preserves the prior durable entry', async () => {
    const backing = new MemoryWorldRegionStorage();
    let fail = false;
    const adapter: WorldRegionStorage = {
      kind: 'indexeddb', list: () => backing.list(), read: (key) => backing.read(key),
      touch: (key, time) => backing.touch(key, time), remove: (keys) => backing.remove(keys),
      clear: () => backing.clear(), close() {},
      commit: async (record, limits) => {
        if (fail) throw new DOMException('Quota exhausted', 'QuotaExceededError');
        return backing.commit(record, limits);
      },
    };
    const store = await createWorldRegionStore({ storage: adapter });
    await store.put('a', region());
    fail = true;
    await store.put('b', region(1));
    expect(store.stats()).toMatchObject({ backend: 'memory', rejectedWrites: 1, lastError: 'Quota exhausted' });
    expect((await store.get('b'))!.heights[0]).toBe(1);
    expect(await backing.read('a')).not.toBeNull();
    expect(await backing.read('b')).toBeNull();
  });

  it('handles denied reads and clears only its rebuildable cache', async () => {
    const storage = new InspectableStorage();
    const store = await createWorldRegionStore({ storage });
    await store.put('a', region());
    storage.read = async () => { throw new Error('Storage denied'); };
    expect(await store.get('a')).toBeNull();
    expect(store.stats().backend).toBe('memory');
    await store.put('b', region());
    await store.clear();
    expect(store.stats()).toMatchObject({ entries: 0, bytes: 0 });
    await store.close();
    expect(await store.get('b')).toBeNull();
  });

  it('serializes writes and enforces atomic admission even across shared storage clients', async () => {
    const storage = new MemoryWorldRegionStorage();
    const maxBytes = regionBytes('a', region()) * 2;
    const first = await createWorldRegionStore({ storage, maxBytes });
    const second = await createWorldRegionStore({ storage, maxBytes });
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      (index % 2 ? first : second).put(String.fromCharCode(65 + index), region())));
    const actual = await storage.list();
    expect(actual).toHaveLength(2);
    expect(actual.reduce((total, value) => total + value.bytes, 0)).toBeLessThanOrEqual(maxBytes);
    expect((await second.get(actual[0].key))!.heights).toEqual(region().heights);
  });
});
