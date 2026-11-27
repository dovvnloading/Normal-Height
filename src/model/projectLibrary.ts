import { parseProject } from './project';
import { serializeProjectFile } from './projectStorage';
import { resolveSurface } from '../materials/pbr';
import type { TerrainProject } from './types';
import {
  libraryBytes,
  planLibrarySave,
  ProjectLibraryConflictError,
  validateLibraryIndex,
  type LibraryIndex,
  type LibraryProject,
  type LibraryRevision,
  type ProjectLibraryBinding,
} from './projectLibraryPlan';

export { PROJECT_LIBRARY_LIMITS, ProjectLibraryConflictError } from './projectLibraryPlan';
export type { LibraryProject, LibraryRevision, ProjectLibraryBinding } from './projectLibraryPlan';

export const PROJECT_LIBRARY_DATABASE = 'normal-height.project-library.v1';
const STORES = ['projects', 'revisions', 'snapshots'] as const;
const encoder = new TextEncoder();

interface LibrarySnapshot {
  hash: string;
  json: string;
  bytes: number;
}

export interface ProjectLibraryEntry extends LibraryProject {
  revisions: LibraryRevision[];
}

export interface ProjectLibraryListing {
  projects: ProjectLibraryEntry[];
  bytes: number;
}

export interface SavedProjectRevision {
  entry: LibraryProject;
  revision: LibraryRevision;
  binding: ProjectLibraryBinding;
  unchanged: boolean;
}

function failureMessage(error: unknown): Error {
  if (error instanceof DOMException && error.name === 'QuotaExceededError')
    return new Error(
      'Browser storage is full. This checkpoint was not saved; your previous revisions are intact. Download your current project and free storage before retrying.',
    );
  return error instanceof Error
    ? error
    : new Error(
        'The project library is unavailable. Download your current project to keep a copy.',
      );
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      if (typeof indexedDB === 'undefined')
        throw new Error(
          'This browser does not provide project library storage. Download your project to keep a copy.',
        );
      request = indexedDB.open(PROJECT_LIBRARY_DATABASE, 1);
    } catch (error) {
      reject(failureMessage(error));
      return;
    }
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(failureMessage(error));
    };
    request.onblocked = () =>
      fail(
        new Error(
          'Project library storage is blocked by another tab. Close older Normal Height tabs, then retry.',
        ),
      );
    request.onerror = () => fail(request.error);
    request.onupgradeneeded = () => {
      if (settled) {
        request.transaction?.abort();
        request.result.close();
        return;
      }
      try {
        const database = request.result;
        database.createObjectStore('projects', { keyPath: 'id' });
        const revisions = database.createObjectStore('revisions', { keyPath: 'id' });
        revisions.createIndex('projectId', 'projectId');
        database.createObjectStore('snapshots', { keyPath: 'hash' });
      } catch (error) {
        fail(error);
        request.transaction?.abort();
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

/** No asynchronous hashing/JSON work is allowed inside a live IDB transaction. */
async function transaction<T>(
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction, result: (value: T) => void, fail: (error: unknown) => void) => void,
): Promise<T> {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = database.transaction([...STORES], mode);
    } catch (error) {
      database.close();
      reject(failureMessage(error));
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
      if (error !== undefined) reject(failureMessage(error));
      else if (!hasValue) reject(new Error('The project library operation did not complete.'));
      else resolve(value);
    };
    const fail = (error: unknown) => {
      failure ??= error ?? new Error('The project library transaction failed.');
      try {
        tx.abort();
      } catch {
        finish(failure);
      }
    };
    tx.oncomplete = () => finish(failure);
    tx.onabort = () =>
      finish(
        failure ??
          tx.error ??
          new Error('The project library transaction was aborted. No saved work was changed.'),
      );
    tx.onerror = (event) => {
      failure ??=
        (event.target as IDBRequest | null)?.error ??
        tx.error ??
        new Error('The project library transaction failed.');
    };
    try {
      run(
        tx,
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

function readIndex(
  tx: IDBTransaction,
  ready: (index: LibraryIndex) => void,
  fail: (error: unknown) => void,
) {
  const projects = tx.objectStore('projects').getAll();
  const revisions = tx.objectStore('revisions').getAll();
  let pending = 2;
  const done = () => {
    if (--pending) return;
    try {
      ready(validateLibraryIndex({ projects: projects.result, revisions: revisions.result }));
    } catch (error) {
      fail(error);
    }
  };
  projects.onsuccess = done;
  revisions.onsuccess = done;
  projects.onerror = () => fail(projects.error);
  revisions.onerror = () => fail(revisions.error);
}

async function hashSnapshot(json: string): Promise<string> {
  if (!globalThis.crypto?.subtle)
    throw new Error(
      'Verified project storage requires a secure browser context. Download your project to keep a copy.',
    );
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(json));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(
    '',
  );
}

export async function listProjectLibrary(): Promise<ProjectLibraryListing> {
  return transaction('readonly', (tx, result, fail) =>
    readIndex(
      tx,
      (index) => {
        result({
          bytes: libraryBytes(index),
          projects: index.projects
            .map((project) => ({
              ...project,
              revisions: index.revisions
                .filter((revision) => revision.projectId === project.id)
                .sort(
                  (a, b) =>
                    b.savedAt - a.savedAt ||
                    (a.id === project.headRevisionId
                      ? -1
                      : b.id === project.headRevisionId
                        ? 1
                        : 0),
                ),
            }))
            .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name)),
        });
      },
      fail,
    ),
  );
}

export async function saveProjectRevision(
  project: TerrainProject,
  options: { binding?: ProjectLibraryBinding; label?: string } = {},
): Promise<SavedProjectRevision> {
  // Validate both the downloadable form and the parser's restoration boundary
  // before opening a write transaction. No incomplete record is ever visible.
  const json = serializeProjectFile({ ...project, surface: resolveSurface(project.surface) });
  parseProject(JSON.parse(json));
  const hash = await hashSnapshot(json);
  const bytes = encoder.encode(json).byteLength;
  const projectId = options.binding?.projectId ?? crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  const label = (options.label ?? '').trim().slice(0, 100) || 'Checkpoint';
  return transaction('readwrite', (tx, result, fail) =>
    readIndex(
      tx,
      (index) => {
        const plan = planLibrarySave(index, {
          projectId,
          revisionId,
          name: project.name.slice(0, 100),
          label,
          savedAt: Date.now(),
          contentHash: hash,
          bytes,
          binding: options.binding,
        });
        const snapshots = tx.objectStore('snapshots');
        // Even an unchanged save repairs an absent/corrupt snapshot from the
        // caller's validated document, without replacing any other revision.
        snapshots.put({ hash, json, bytes } satisfies LibrarySnapshot);
        if (!plan.unchanged) {
          tx.objectStore('projects').put(plan.project);
          tx.objectStore('revisions').put(plan.revision);
          for (const id of plan.removedRevisionIds) tx.objectStore('revisions').delete(id);
          for (const contentHash of plan.removedContentHashes) snapshots.delete(contentHash);
        }
        result({
          entry: plan.project,
          revision: plan.revision,
          unchanged: plan.unchanged,
          binding: {
            projectId,
            headRevisionId: plan.revision.id,
            sourceRevisionId: plan.revision.id,
          },
        });
      },
      fail,
    ),
  );
}

export async function readProjectRevision(
  projectId: string,
  revisionId?: string,
): Promise<{
  project: TerrainProject;
  entry: LibraryProject;
  revision: LibraryRevision;
  binding: ProjectLibraryBinding;
}> {
  const stored = await transaction<{
    entry: LibraryProject;
    revision: LibraryRevision;
    snapshot: LibrarySnapshot;
  }>('readonly', (tx, result, fail) => {
    const entry = tx.objectStore('projects').get(projectId);
    entry.onerror = () => fail(entry.error);
    entry.onsuccess = () => {
      try {
        if (!entry.result)
          throw new Error('This project was removed in another tab. Refresh the project library.');
        const revision = tx.objectStore('revisions').get(revisionId ?? entry.result.headRevisionId);
        revision.onerror = () => fail(revision.error);
        revision.onsuccess = () => {
          try {
            if (!revision.result || revision.result.projectId !== projectId)
              throw new Error('This revision is no longer available. Refresh the project library.');
            // Validate a minimal complete index while preserving the actual
            // head in the returned entry (the selected revision may be older).
            validateLibraryIndex({
              projects: [{ ...entry.result, headRevisionId: revision.result.id }],
              revisions: [revision.result],
            });
            const snapshot = tx.objectStore('snapshots').get(revision.result.contentHash);
            snapshot.onerror = () => fail(snapshot.error);
            snapshot.onsuccess = () =>
              result({ entry: entry.result, revision: revision.result, snapshot: snapshot.result });
          } catch (error) {
            fail(error);
          }
        };
      } catch (error) {
        fail(error);
      }
    };
  });
  const { entry, revision, snapshot } = stored;
  if (
    !snapshot ||
    typeof snapshot.json !== 'string' ||
    snapshot.hash !== revision.contentHash ||
    snapshot.bytes !== revision.bytes ||
    encoder.encode(snapshot.json).byteLength !== revision.bytes ||
    (await hashSnapshot(snapshot.json)) !== revision.contentHash
  )
    throw new Error(
      'This revision failed its integrity check. Your current work is unchanged. Try a different revision or import a downloaded project.',
    );
  return {
    project: parseProject(JSON.parse(snapshot.json)),
    entry,
    revision,
    binding: { projectId, headRevisionId: entry.headRevisionId, sourceRevisionId: revision.id },
  };
}

/** Deletion is explicit, compare-and-swap guarded, and includes unshared blobs. */
export async function deleteLibraryProject(
  projectId: string,
  expectedHeadRevisionId: string,
): Promise<void> {
  return transaction('readwrite', (tx, result, fail) =>
    readIndex(
      tx,
      (index) => {
        const entry = index.projects.find((project) => project.id === projectId);
        if (!entry || entry.headRevisionId !== expectedHeadRevisionId)
          throw new ProjectLibraryConflictError();
        const retainedHashes = new Set(
          index.revisions
            .filter((revision) => revision.projectId !== projectId)
            .map((revision) => revision.contentHash),
        );
        for (const revision of index.revisions.filter(
          (revision) => revision.projectId === projectId,
        )) {
          tx.objectStore('revisions').delete(revision.id);
          if (!retainedHashes.has(revision.contentHash))
            tx.objectStore('snapshots').delete(revision.contentHash);
        }
        tx.objectStore('projects').delete(projectId);
        result(undefined);
      },
      fail,
    ),
  );
}
