import type { WorldRegionResult } from '../world';
import { regionBytes, regionChecksum, validRegion, WORLD_REGION_CACHE_VERSION } from './codec';
import { MemoryWorldRegionStorage, openWorldRegionStorage } from './storage';
import type { StoredRegion, StoredRegionMetadata, WorldRegionStorage } from './storage';

export { WORLD_REGION_CACHE_VERSION } from './codec';
export type { WorldRegionStorage, StoredRegion, StoredRegionMetadata } from './storage';
export interface WorldRegionStoreStats {
  backend: 'memory' | 'indexeddb';
  bytes: number;
  budgetBytes: number;
  entries: number;
  hits: number;
  misses: number;
  evictions: number;
  rejectedWrites: number;
  corruptEntries: number;
  lastError: string | null;
}
export interface WorldRegionStore {
  get(key: string): Promise<WorldRegionResult | null>;
  put(key: string, result: WorldRegionResult): Promise<void>;
  clear(): Promise<void>;
  close(): Promise<void>;
  stats(): WorldRegionStoreStats;
}
export interface WorldRegionStoreOptions {
  maxBytes?: number;
  maxEntries?: number;
  /** null forces the bounded in-memory profile; omitted capability-detects IndexedDB. */
  storage?: WorldRegionStorage | null;
  databaseName?: string;
}

/** Atomic, versioned CPU-region cache with bounded LRU and recoverable storage failures. */
export async function createWorldRegionStore(options: WorldRegionStoreOptions = {}): Promise<WorldRegionStore> {
  const requested = options.maxBytes ?? 64 * 1024 * 1024;
  const maxBytes = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 0;
  const maxEntries = Math.max(1, Math.min(1024, Math.floor(options.maxEntries ?? 128) || 128));
  let storage: WorldRegionStorage = options.storage || new MemoryWorldRegionStorage();
  let records = new Map<string, StoredRegionMetadata>();
  let closed = false;
  let clock = Date.now();
  let queue = Promise.resolve();
  const state: WorldRegionStoreStats = { backend: storage.kind, bytes: 0, budgetBytes: maxBytes,
    entries: 0, hits: 0, misses: 0, evictions: 0, rejectedWrites: 0, corruptEntries: 0, lastError: null };
  const tick = () => (clock = Math.max(clock + 1, Date.now()));
  const recount = () => {
    state.bytes = [...records.values()].reduce((total, record) => total + record.bytes, 0);
    state.entries = records.size;
  };
  const fallback = (error: unknown) => {
    storage.close();
    storage = new MemoryWorldRegionStorage();
    records.clear();
    state.backend = 'memory';
    state.lastError = error instanceof Error ? error.message : 'World cache storage is unavailable.';
    recount();
  };
  const enqueue = <T>(operation: () => Promise<T>) => {
    const pending = queue.then(operation);
    queue = pending.then(() => undefined, () => undefined);
    return pending;
  };
  const evictionKeys = (incomingBytes = 0, replacing?: string) => {
    const candidates = [...records.values()].filter((record) => record.key !== replacing)
      .sort((a, b) => a.lastUsed - b.lastUsed || a.key.localeCompare(b.key));
    let bytes = candidates.reduce((total, record) => total + record.bytes, incomingBytes);
    let count = candidates.length + (replacing === undefined ? 0 : 1);
    const removed: string[] = [];
    for (const record of candidates) {
      if (bytes <= maxBytes && count <= maxEntries) break;
      removed.push(record.key); bytes -= record.bytes; count--;
    }
    return removed;
  };

  try {
    if (options.storage === undefined && typeof indexedDB !== 'undefined')
      storage = await openWorldRegionStorage(indexedDB, options.databaseName);
    state.backend = storage.kind;
    const metadata = await storage.list();
    const invalid = metadata.filter((record) => !record || record.version !== WORLD_REGION_CACHE_VERSION ||
      typeof record.key !== 'string' || !Number.isSafeInteger(record.bytes) || record.bytes < 0 ||
      !Number.isFinite(record.lastUsed)).map((record) => record?.key).filter((key): key is string => typeof key === 'string');
    records = new Map(metadata.filter((record) => record && !invalid.includes(record.key)).map((record) => [record.key, record]));
    const remove = [...invalid, ...evictionKeys()];
    if (remove.length) {
      await storage.remove(remove);
      for (const key of remove) records.delete(key);
      state.evictions += remove.length;
    }
    recount();
  } catch (error) { fallback(error); }

  return {
    get(key) {
      return enqueue(async () => {
        if (closed) { state.misses++; return null; }
        try {
          const record = await storage.read(key);
          if (!record) { records.delete(key); recount(); state.misses++; return null; }
          if (record.version !== WORLD_REGION_CACHE_VERSION || record.key !== key ||
            !validRegion(record.result) || record.bytes !== regionBytes(key, record.result) ||
            record.checksum !== regionChecksum(record.result)) {
            await storage.remove([key]);
            records.delete(key); recount(); state.corruptEntries++; state.misses++;
            return null;
          }
          const lastUsed = tick();
          await storage.touch(key, lastUsed);
          records = new Map((await storage.list()).map((value) => [value.key, value]));
          recount();
          state.hits++;
          return record.result;
        } catch (error) { fallback(error); state.misses++; return null; }
      });
    },
    put(key, result) {
      return enqueue(async () => {
        if (closed) return;
        if (typeof key !== 'string' || key.length > 1024 * 1024 || !validRegion(result)) {
          state.rejectedWrites++; return;
        }
        const bytes = regionBytes(key, result);
        if (bytes > maxBytes) { state.rejectedWrites++; return; }
        // Copy once before admission. IDB performs its own structured clone;
        // memory storage keeps this cache-owned snapshot and copies only reads.
        const record: StoredRegion = { key, version: WORLD_REGION_CACHE_VERSION, bytes,
          lastUsed: tick(), checksum: regionChecksum(result), result: structuredClone(result) };
        let committed;
        try { committed = await storage.commit(record, { maxBytes, maxEntries }); }
        catch (error) {
          state.rejectedWrites++;
          fallback(error);
          committed = await storage.commit(record, { maxBytes, maxEntries });
        }
        records = new Map(committed.entries.map((value) => [value.key, value]));
        state.evictions += committed.evicted.length;
        recount();
      });
    },
    clear() {
      return enqueue(async () => {
        if (closed) return;
        try { await storage.clear(); } catch (error) { fallback(error); }
        records.clear(); recount();
      });
    },
    close() {
      return enqueue(async () => { closed = true; storage.close(); records.clear(); recount(); });
    },
    stats() { return { ...state }; },
  };
}
