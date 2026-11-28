import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import {
  deleteLibraryProject,
  listProjectLibrary,
  PROJECT_LIBRARY_DATABASE,
  readProjectRevision,
  saveProjectRevision,
} from '../src/model/projectLibrary';
import { createProject } from '../src/model/presets';
import { parseProject } from '../src/model/project';
import { resolveSurface } from '../src/materials/pbr';
import { createWorldDefinition } from '../src/model/world';

let factory: IDBFactory;
beforeEach(() => {
  factory = new IDBFactory();
  vi.stubGlobal('indexedDB', factory);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(PROJECT_LIBRARY_DATABASE, 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function snapshots(): Promise<{ hash: string; bytes: number; json: string }[]> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('snapshots', 'readonly');
    const request = tx.objectStore('snapshots').getAll();
    tx.oncomplete = () => {
      db.close();
      resolve(request.result);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error);
    };
  });
}

describe('project library IndexedDB transactions', () => {
  it('commits portable v1/v2 projects, verifies restores, and returns independent copies', async () => {
    const project = createProject('studio-dunes');
    const saved = await saveProjectRevision(project, { label: 'Approved composition' });
    const restored = await readProjectRevision(saved.entry.id);
    expect(restored.project).toEqual(
      parseProject({ ...project, surface: resolveSurface(project.surface) }),
    );
    expect(restored.revision.label).toBe('Approved composition');
    expect(restored.binding).toEqual(saved.binding);
    restored.project.seed = 1;
    expect((await readProjectRevision(saved.entry.id)).project.seed).toBe(project.seed);
    const world = createWorldDefinition(project);
    world.domain.depth = 5321;
    const worldProject = { ...project, version: 2 as const, world };
    const version2 = await saveProjectRevision(worldProject);
    expect((await readProjectRevision(version2.entry.id)).project.world).toEqual(world);
    expect((await listProjectLibrary()).projects).toHaveLength(2);
  });

  it('deduplicates copied snapshots and keeps shared payloads until the last project is removed', async () => {
    const project = createProject('studio-dunes');
    const first = await saveProjectRevision(project);
    const second = await saveProjectRevision(project);
    expect(await snapshots()).toHaveLength(1);
    await deleteLibraryProject(first.entry.id, first.revision.id);
    expect(await snapshots()).toHaveLength(1);
    expect((await readProjectRevision(second.entry.id)).project.name).toBe(project.name);
    await deleteLibraryProject(second.entry.id, second.revision.id);
    expect(await snapshots()).toHaveLength(0);
    expect((await listProjectLibrary()).projects).toHaveLength(0);
  });

  it('rolls back the entire transaction when quota fails after the snapshot was queued', async () => {
    const project = createProject('studio-dunes');
    const first = await saveProjectRevision(project);
    const before = await listProjectLibrary();
    const original = IDBObjectStore.prototype.put;
    const injected = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      ...args
    ) {
      if (this.name === 'revisions') throw new DOMException('Injected quota', 'QuotaExceededError');
      return original.apply(this, args);
    });
    await expect(
      saveProjectRevision({ ...project, seed: project.seed + 1 }, { binding: first.binding }),
    ).rejects.toThrow(/Browser storage is full/);
    injected.mockRestore();
    expect(await listProjectLibrary()).toEqual(before);
    expect(await snapshots()).toHaveLength(1);
    expect((await readProjectRevision(first.entry.id)).project.seed).toBe(project.seed);
    const recovered = await saveProjectRevision(
      { ...project, seed: project.seed + 1 },
      { binding: first.binding },
    );
    expect((await readProjectRevision(first.entry.id)).project.seed).toBe(project.seed + 1);
    expect(recovered.revision.parentRevisionId).toBe(first.revision.id);
  });

  it('serializes concurrent writers and rejects the losing expected head without overwriting either document', async () => {
    const project = createProject('studio-dunes');
    const first = await saveProjectRevision(project);
    const writes = await Promise.allSettled([
      saveProjectRevision({ ...project, name: 'First tab' }, { binding: first.binding }),
      saveProjectRevision({ ...project, name: 'Second tab' }, { binding: first.binding }),
    ]);
    expect(writes.filter((write) => write.status === 'fulfilled')).toHaveLength(1);
    const rejected = writes.find((write) => write.status === 'rejected')!;
    expect(rejected.status === 'rejected' && rejected.reason.message).toMatch(/another tab/);
    const listing = await listProjectLibrary();
    expect(listing.projects).toHaveLength(1);
    expect(listing.projects[0].revisions).toHaveLength(2);
    expect(await snapshots()).toHaveLength(2);
    await expect(deleteLibraryProject(first.entry.id, first.revision.id)).rejects.toThrow(
      /another tab/,
    );
    const recovered = await saveProjectRevision({ ...project, name: 'Preserved local document' });
    expect((await listProjectLibrary()).projects).toHaveLength(2);
    expect((await readProjectRevision(recovered.entry.id)).project.name).toBe(
      'Preserved local document',
    );
  });

  it('prunes revisions and orphaned snapshots atomically while preserving unrelated projects', async () => {
    const project = createProject('studio-dunes');
    const unrelated = await saveProjectRevision({ ...project, name: 'Keep this project' });
    let saved = await saveProjectRevision(project);
    for (let i = 1; i <= 23; i++)
      saved = await saveProjectRevision(
        { ...project, seed: project.seed + i },
        { binding: saved.binding },
      );
    const listing = await listProjectLibrary();
    expect(listing.projects).toHaveLength(2);
    expect(listing.projects.find((entry) => entry.id === saved.entry.id)?.revisions).toHaveLength(
      20,
    );
    expect(await snapshots()).toHaveLength(21);
    expect((await readProjectRevision(unrelated.entry.id)).project.name).toBe('Keep this project');
    expect((await readProjectRevision(saved.entry.id)).project.seed).toBe(project.seed + 23);
  });

  it('rejects modified payload bytes while permitting an older healthy revision to restore', async () => {
    const project = createProject('studio-dunes');
    const first = await saveProjectRevision(project, { label: 'Healthy revision' });
    const second = await saveProjectRevision(
      { ...project, name: 'Modified landscape' },
      { binding: first.binding },
    );
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('snapshots', 'readwrite');
      const store = tx.objectStore('snapshots');
      const request = store.get(second.revision.contentHash);
      request.onsuccess = () =>
        store.put({ ...request.result, json: request.result.json.replace('Modified', 'Corrupt!') });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error);
      };
    });
    await expect(readProjectRevision(first.entry.id)).rejects.toThrow(/integrity check/);
    const restored = await readProjectRevision(first.entry.id, first.revision.id);
    expect(restored.project.name).toBe(project.name);
    expect(restored.binding.headRevisionId).toBe(second.revision.id);
    expect(restored.binding.sourceRevisionId).toBe(first.revision.id);
    const recovery = await saveProjectRevision(restored.project, {
      binding: restored.binding,
      label: 'Recovered from healthy revision',
    });
    expect(recovery.revision.parentRevisionId).toBe(first.revision.id);
    expect((await readProjectRevision(first.entry.id)).project.name).toBe(project.name);
  });

  it('does not publish malformed documents, missing revisions, or unsupported storage', async () => {
    const project = createProject('studio-dunes');
    const saved = await saveProjectRevision(project);
    await expect(
      saveProjectRevision({ ...project, seed: Infinity }, { binding: saved.binding }),
    ).rejects.toThrow(/seed/);
    expect((await listProjectLibrary()).projects[0].revisions).toHaveLength(1);
    await expect(readProjectRevision(saved.entry.id, 'missing-revision')).rejects.toThrow(
      /no longer available/,
    );
    await expect(readProjectRevision('missing-project')).rejects.toThrow(/removed/);
    vi.stubGlobal('indexedDB', undefined);
    await expect(listProjectLibrary()).rejects.toThrow(/does not provide/);
  });

  it('reports a blocked upgrade, closes its late connection, and succeeds after the block is removed', async () => {
    await saveProjectRevision(createProject('studio-dunes'));
    const blocker = await database();
    const original = factory.open.bind(factory);
    let finished: Promise<void> | undefined;
    const intercepted = vi.spyOn(factory, 'open').mockImplementationOnce((name) => {
      // A future library version may need an upgrade while an older tab is
      // still alive. Exercise the same IDB blocked/late-open events today.
      const request = original(name, 2);
      finished = new Promise((resolve) => request.addEventListener('error', () => resolve()));
      return request;
    });
    await expect(listProjectLibrary()).rejects.toThrow(/blocked by another tab/);
    blocker.close();
    await finished;
    intercepted.mockRestore();
    expect((await listProjectLibrary()).projects).toHaveLength(1);
  });
});
