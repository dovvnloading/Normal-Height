import type { WorldRegionResult } from '../world';

export interface StoredRegionMetadata {
  key: string;
  version: string;
  bytes: number;
  lastUsed: number;
}
export interface StoredRegion extends StoredRegionMetadata {
  checksum: string;
  result: WorldRegionResult;
}
export interface StorageLimits {
  maxBytes: number;
  maxEntries: number;
}
export interface RegionCommit {
  entries: StoredRegionMetadata[];
  evicted: string[];
}
/** read() returns an independent owned snapshot; commit is atomic with evictions. */
export interface WorldRegionStorage {
  readonly kind: 'memory' | 'indexeddb';
  list(): Promise<StoredRegionMetadata[]>;
  read(key: string): Promise<StoredRegion | null>;
  commit(record: StoredRegion, limits: StorageLimits): Promise<RegionCommit>;
  touch(key: string, lastUsed: number): Promise<void>;
  remove(keys: string[]): Promise<void>;
  clear(): Promise<void>;
  close(): void;
}

function admission(
  current: StoredRegionMetadata[],
  record: StoredRegion,
  limits: StorageLimits,
): RegionCommit {
  if (record.bytes > limits.maxBytes) throw new Error('The region exceeds its cache budget.');
  const entries = current
    .filter((value) => value.key !== record.key)
    .sort((a, b) => a.lastUsed - b.lastUsed || a.key.localeCompare(b.key));
  let bytes = entries.reduce((sum, value) => sum + value.bytes, record.bytes);
  const evicted: string[] = [];
  while (entries.length && (bytes > limits.maxBytes || entries.length + 1 > limits.maxEntries)) {
    const oldest = entries.shift()!;
    bytes -= oldest.bytes;
    evicted.push(oldest.key);
  }
  entries.push({
    key: record.key,
    version: record.version,
    bytes: record.bytes,
    lastUsed: record.lastUsed,
  });
  return { entries, evicted };
}

/** Cache-owned snapshots. Native structuredClone preserves shared-buffer aliases. */
export class MemoryWorldRegionStorage implements WorldRegionStorage {
  readonly kind = 'memory' as const;
  protected records = new Map<string, StoredRegion>();
  async list(): Promise<StoredRegionMetadata[]> {
    return [...this.records.values()].map(({ key, version, bytes, lastUsed }) => ({
      key,
      version,
      bytes,
      lastUsed,
    }));
  }
  async read(key: string): Promise<StoredRegion | null> {
    const record = this.records.get(key);
    return record ? structuredClone(record) : null;
  }
  async commit(record: StoredRegion, limits: StorageLimits): Promise<RegionCommit> {
    const result = admission([...this.records.values()], record, limits);
    for (const key of result.evicted) this.records.delete(key);
    this.records.set(record.key, record);
    return result;
  }
  async touch(key: string, lastUsed: number): Promise<void> {
    const record = this.records.get(key);
    if (record) record.lastUsed = lastUsed;
  }
  async remove(keys: string[]): Promise<void> {
    for (const key of keys) this.records.delete(key);
  }
  async clear(): Promise<void> {
    this.records.clear();
  }
  close(): void {
    this.records.clear();
  }
}

const REGIONS = 'regions';
const INDEX = 'index';

class IndexedDBWorldRegionStorage implements WorldRegionStorage {
  readonly kind = 'indexeddb' as const;
  constructor(private readonly database: IDBDatabase) {}

  private transaction<T>(
    mode: IDBTransactionMode,
    perform: (
      regions: IDBObjectStore,
      index: IDBObjectStore,
      setResult: (result: T) => void,
    ) => void,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      let result: T;
      const transaction = this.database.transaction([REGIONS, INDEX], mode);
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () =>
        reject(transaction.error || new Error('World cache transaction failed.'));
      transaction.onabort = () =>
        reject(transaction.error || new Error('World cache transaction was aborted.'));
      try {
        perform(transaction.objectStore(REGIONS), transaction.objectStore(INDEX), (value) => {
          result = value;
        });
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    });
  }

  list(): Promise<StoredRegionMetadata[]> {
    return this.transaction('readonly', (_regions, index, setResult) => {
      const request = index.getAll();
      request.onsuccess = () => setResult(request.result as StoredRegionMetadata[]);
    });
  }
  read(key: string): Promise<StoredRegion | null> {
    return this.transaction('readonly', (regions, _index, setResult) => {
      const request = regions.get(key);
      request.onsuccess = () => setResult((request.result as StoredRegion | undefined) || null);
    });
  }
  commit(record: StoredRegion, limits: StorageLimits): Promise<RegionCommit> {
    return this.transaction('readwrite', (regions, index, setResult) => {
      // Read the current index inside the same readwrite transaction as the
      // admission. Concurrent tabs cannot both allocate against stale totals.
      const request = index.getAll();
      request.onsuccess = () => {
        try {
          const result = admission(request.result as StoredRegionMetadata[], record, limits);
          for (const key of result.evicted) {
            regions.delete(key);
            index.delete(key);
          }
          regions.put(record, record.key);
          index.put(
            {
              key: record.key,
              version: record.version,
              bytes: record.bytes,
              lastUsed: record.lastUsed,
            },
            record.key,
          );
          setResult(result);
        } catch {
          index.transaction.abort();
        }
      };
    });
  }
  touch(key: string, lastUsed: number): Promise<void> {
    return this.transaction('readwrite', (_regions, index) => {
      const request = index.get(key);
      request.onsuccess = () => {
        if (request.result) index.put({ ...request.result, lastUsed }, key);
      };
    });
  }
  remove(keys: string[]): Promise<void> {
    return this.transaction('readwrite', (regions, index) => {
      for (const key of keys) {
        regions.delete(key);
        index.delete(key);
      }
    });
  }
  clear(): Promise<void> {
    return this.transaction('readwrite', (regions, index) => {
      regions.clear();
      index.clear();
    });
  }
  close(): void {
    this.database.close();
  }
}

/** Dedicated rebuildable database; never shares stores with imported source/session data. */
export function openWorldRegionStorage(
  factory: IDBFactory,
  name = 'normal-height.world-cache',
): Promise<WorldRegionStorage> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = factory.open(name, 1);
    const fail = (reason: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(reason);
    };
    const timeout = setTimeout(
      () => fail(new Error('World cache storage did not open in time.')),
      3000,
    );
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(REGIONS)) database.createObjectStore(REGIONS);
      if (!database.objectStoreNames.contains(INDEX)) database.createObjectStore(INDEX);
    };
    request.onblocked = () => fail(new Error('Another tab is blocking the world cache upgrade.'));
    request.onerror = () => fail(request.error || new Error('World cache storage is unavailable.'));
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      clearTimeout(timeout);
      request.result.onversionchange = () => request.result.close();
      resolve(new IndexedDBWorldRegionStorage(request.result));
    };
  });
}
