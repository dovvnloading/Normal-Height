import { parseProject } from './project';
import type { TerrainProject } from './types';

const DATABASE_NAME = 'normal-height-studio-v1';
const STORE_NAME = 'session';
const SESSION_KEY = 'latest';

export interface SessionBackup {
  project: TerrainProject;
  savedAt: number;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      if (typeof indexedDB === 'undefined')
        throw new Error('Session backup storage is unavailable.');
      request = indexedDB.open(DATABASE_NAME, 1);
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.onblocked = () =>
      fail(new Error('Session backup storage is blocked by another open tab.'));
    request.onerror = () =>
      fail(request.error ?? new Error('Could not open session backup storage.'));
    request.onupgradeneeded = () => {
      const database = request.result;
      // An open request cannot be cancelled. A blocked request may proceed
      // later, after its caller has already received an error.
      if (settled) {
        try {
          request.transaction?.abort();
        } catch {
          /* Already ending. */
        }
        database.close();
        return;
      }
      try {
        if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
      } catch (error) {
        fail(error);
        try {
          request.transaction?.abort();
        } catch {
          /* Already ending. */
        }
        database.close();
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      // Do not hold a stale connection open across an upgrade in another tab.
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

/** Resolve only after commit, and close the connection on every terminal path. */
async function sessionTransaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, result: (value: T) => void, fail: (error: unknown) => void) => void,
): Promise<T> {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(STORE_NAME, mode);
    } catch (error) {
      database.close();
      reject(error);
      return;
    }
    let value: T;
    let hasValue = false;
    let failure: unknown;
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      database.close();
      if (error !== undefined) reject(error);
      else if (!hasValue) reject(new Error('Session backup transaction returned no result.'));
      else resolve(value);
    };
    const fail = (error: unknown) => {
      failure ??= error ?? new Error('Session backup transaction failed.');
      try {
        transaction.abort();
      } catch {
        finish(failure);
      }
    };
    transaction.oncomplete = () => finish(failure);
    transaction.onabort = () =>
      finish(failure ?? transaction.error ?? new Error('Session backup transaction was aborted.'));
    transaction.onerror = () => {
      failure ??= transaction.error ?? new Error('Session backup transaction failed.');
      // IndexedDB aborts a transaction after an unhandled request error.
      // Keep that default behavior; onabort is the single rejection path.
    };
    try {
      run(
        transaction.objectStore(STORE_NAME),
        (next) => {
          value = next;
          hasValue = true;
        },
        fail,
      );
    } catch (error) {
      fail(error);
    }
  });
}

/** Restore a validated project; a missing backup is represented by null. */
export function readSessionBackup(): Promise<SessionBackup | null> {
  return sessionTransaction<SessionBackup | null>('readonly', (store, result, fail) => {
    const request = store.get(SESSION_KEY);
    request.onerror = () => fail(request.error ?? new Error('Could not read the session backup.'));
    request.onsuccess = () => {
      try {
        const raw: unknown = request.result;
        if (raw === undefined) {
          result(null);
          return;
        }
        if (
          !raw ||
          typeof raw !== 'object' ||
          !('savedAt' in raw) ||
          !validTimestamp(raw.savedAt) ||
          !('project' in raw)
        ) {
          throw new Error('The session backup has invalid metadata.');
        }
        result({ project: parseProject(raw.project), savedAt: raw.savedAt });
      } catch (error) {
        fail(error);
      }
    };
  });
}

/** Write the structured-cloned project only if it is at least as recent as the
 * current backup. The comparison and write share one readwrite transaction,
 * so an older autosave completing late cannot replace a newer edit. */
export function writeSessionBackup(project: TerrainProject, savedAt: number): Promise<void> {
  if (!validTimestamp(savedAt))
    return Promise.reject(new Error('Session backup timestamp is invalid.'));
  return sessionTransaction<void>('readwrite', (store, result, fail) => {
    const request = store.get(SESSION_KEY);
    request.onerror = () =>
      fail(request.error ?? new Error('Could not check the previous session backup.'));
    request.onsuccess = () => {
      try {
        const previous: unknown = request.result;
        const previousTimestamp =
          previous && typeof previous === 'object' && 'savedAt' in previous
            ? previous.savedAt
            : undefined;
        if (!validTimestamp(previousTimestamp) || savedAt >= previousTimestamp) {
          // IDB performs the structured clone synchronously when put is called.
          const write = store.put({ project, savedAt } satisfies SessionBackup, SESSION_KEY);
          write.onerror = () =>
            fail(write.error ?? new Error('Could not save the session backup.'));
        }
        result(undefined);
      } catch (error) {
        fail(error);
      }
    };
  });
}
