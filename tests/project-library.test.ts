import { describe, expect, it } from 'vitest';
import {
  libraryBytes,
  planLibrarySave,
  ProjectLibraryConflictError,
  validateLibraryIndex,
  type LibraryIndex,
  type LibrarySavePlan,
  type ProjectLibraryBinding,
} from '../src/model/projectLibraryPlan';

const hash = (n: number) => n.toString(16).padStart(64, '0');
const limits = { projects: 50, revisionsPerProject: 20, bytes: 256 * 1048576 };
function save(
  index: LibraryIndex,
  sequence: number,
  binding?: ProjectLibraryBinding,
  content = sequence,
  bytes = 4096,
) {
  return planLibrarySave(
    index,
    {
      projectId: binding?.projectId ?? `project-${sequence}`,
      revisionId: `revision-${sequence}`,
      name: `Landscape ${sequence}`,
      label: `Checkpoint ${sequence}`,
      savedAt: 1000 + sequence,
      contentHash: hash(content),
      bytes,
      binding,
    },
    limits,
  );
}
function commit(index: LibraryIndex, plan: LibrarySavePlan): LibraryIndex {
  if (plan.unchanged) return index;
  return {
    projects: [...index.projects.filter((entry) => entry.id !== plan.project.id), plan.project],
    revisions: [
      ...index.revisions.filter((entry) => !plan.removedRevisionIds.includes(entry.id)),
      plan.revision,
    ],
  };
}
const bindingOf = (plan: LibrarySavePlan): ProjectLibraryBinding => ({
  projectId: plan.project.id,
  headRevisionId: plan.revision.id,
  sourceRevisionId: plan.revision.id,
});
const empty = (): LibraryIndex => ({ projects: [], revisions: [] });

describe('durable project revision transaction contract', () => {
  it('creates a complete head, stores ancestry, and never edits its input', () => {
    const first = save(empty(), 1);
    const index = commit(empty(), first);
    const before = structuredClone(index);
    const second = save(index, 2, bindingOf(first));
    expect(second.revision.parentRevisionId).toBe(first.revision.id);
    expect(second.project.createdAt).toBe(first.project.createdAt);
    expect(second.project.headRevisionId).toBe(second.revision.id);
    expect(validateLibraryIndex(commit(index, second))).toBeTruthy();
    expect(index).toEqual(before);
  });

  it('rejects stale, removed, and unbound overwrites instead of accepting last-writer-wins', () => {
    const first = save(empty(), 1);
    const initial = commit(empty(), first);
    const second = save(initial, 2, bindingOf(first));
    const updated = commit(initial, second);
    expect(() => save(updated, 3, bindingOf(first))).toThrow(ProjectLibraryConflictError);
    expect(() => save(empty(), 3, bindingOf(first))).toThrow(ProjectLibraryConflictError);
    expect(() => save(initial, 1)).toThrow(ProjectLibraryConflictError);
    expect(updated.revisions).toHaveLength(2);
  });

  it('does not generate redundant checkpoints but restores old revisions as new heads', () => {
    const first = save(empty(), 1);
    let index = commit(empty(), first);
    const unchanged = save(index, 2, bindingOf(first), 1);
    expect(unchanged.unchanged).toBe(true);
    expect(unchanged.revision).toEqual(first.revision);
    const second = save(index, 3, bindingOf(first));
    index = commit(index, second);
    const restored = save(
      index,
      4,
      { ...bindingOf(second), sourceRevisionId: first.revision.id },
      1,
    );
    expect(restored.unchanged).toBe(false);
    expect(restored.revision.parentRevisionId).toBe(first.revision.id);
    expect(restored.project.headRevisionId).toBe(restored.revision.id);
  });

  it('rejects cross-project ancestry while allowing a previously verified pruned parent', () => {
    const first = save(empty(), 1);
    let index = commit(empty(), first);
    const second = save(index, 2);
    index = commit(index, second);
    expect(() =>
      save(index, 3, { ...bindingOf(first), sourceRevisionId: second.revision.id }),
    ).toThrow(/different saved project/);
    expect(
      save(index, 4, { ...bindingOf(first), sourceRevisionId: 'previously-pruned-revision' })
        .revision.parentRevisionId,
    ).toBe('previously-pruned-revision');
  });

  it('retains the newest 20 revisions and prunes only the saved project', () => {
    const unrelated = save(empty(), 100);
    let index = commit(empty(), unrelated);
    let current = save(index, 1);
    index = commit(index, current);
    for (let i = 2; i <= 25; i++) {
      current = save(index, i, bindingOf(current));
      index = commit(index, current);
    }
    expect(
      index.revisions.filter((revision) => revision.projectId === current.project.id),
    ).toHaveLength(20);
    expect(index.revisions.some((revision) => revision.id === 'revision-6')).toBe(true);
    expect(index.revisions.some((revision) => revision.id === 'revision-5')).toBe(false);
    expect(index.projects.find((project) => project.id === unrelated.project.id)).toEqual(
      unrelated.project,
    );
    expect(index.revisions.find((revision) => revision.id === unrelated.revision.id)).toEqual(
      unrelated.revision,
    );
  });

  it('deduplicates snapshots across project copies without deleting shared content', () => {
    const first = save(empty(), 1, undefined, 1);
    let index = commit(empty(), first);
    const copy = save(index, 2, undefined, 1);
    index = commit(index, copy);
    expect(libraryBytes(index)).toBe(4096 + 4 * 1024);
    const plan = planLibrarySave(
      index,
      {
        projectId: first.project.id,
        revisionId: 'revision-3',
        name: 'Edited',
        label: 'Edit',
        savedAt: 2000,
        contentHash: hash(3),
        bytes: 4096,
        binding: bindingOf(first),
      },
      { ...limits, revisionsPerProject: 1 },
    );
    expect(plan.removedRevisionIds).toEqual([first.revision.id]);
    expect(plan.removedContentHashes).toEqual([]);
    expect(libraryBytes(commit(index, plan))).toBe(8192 + 4 * 1024);
  });

  it('releases a snapshot only when its final retained revision is pruned', () => {
    const first = save(empty(), 1);
    const index = commit(empty(), first);
    const plan = planLibrarySave(
      index,
      {
        projectId: first.project.id,
        revisionId: 'revision-2',
        name: 'Edited',
        label: 'Edit',
        savedAt: 2000,
        contentHash: hash(2),
        bytes: 4096,
        binding: bindingOf(first),
      },
      { ...limits, revisionsPerProject: 1 },
    );
    expect(plan.removedContentHashes).toEqual([first.revision.contentHash]);
  });

  it('rejects an over-budget save before any proposed deletion is applied', () => {
    const first = save(empty(), 1);
    const index = commit(empty(), first);
    const before = structuredClone(index);
    expect(() =>
      planLibrarySave(
        index,
        {
          projectId: first.project.id,
          revisionId: 'revision-2',
          name: 'Large',
          label: 'Edit',
          savedAt: 2000,
          contentHash: hash(2),
          bytes: 16384,
          binding: bindingOf(first),
        },
        { ...limits, revisionsPerProject: 1, bytes: 8192 },
      ),
    ).toThrow(/No saved work was removed/);
    expect(index).toEqual(before);
  });

  it('bounds the number of projects without evicting a different document', () => {
    const first = save(empty(), 1);
    const index = commit(empty(), first);
    expect(() =>
      planLibrarySave(
        index,
        {
          projectId: 'new-project',
          revisionId: 'new-revision',
          name: 'New',
          label: 'Edit',
          savedAt: 2000,
          contentHash: hash(2),
          bytes: 4096,
        },
        { ...limits, projects: 1 },
      ),
    ).toThrow(/1 projects/);
    expect(index.projects).toHaveLength(1);
  });

  it('keeps revision ordering monotonic when the system clock moves backwards', () => {
    const first = save(empty(), 1);
    const plan = planLibrarySave(commit(empty(), first), {
      projectId: first.project.id,
      revisionId: 'revision-2',
      name: 'Edited',
      label: 'Edit',
      savedAt: 0,
      contentHash: hash(2),
      bytes: 4096,
      binding: bindingOf(first),
    });
    expect(plan.project.updatedAt).toBe(first.project.updatedAt + 1);
    expect(plan.revision.savedAt).toBe(plan.project.updatedAt);
  });

  it('rejects damaged metadata and disconnected heads before mutations', () => {
    const first = save(empty(), 1);
    const index = commit(empty(), first);
    expect(() => validateLibraryIndex({ ...index, revisions: [] })).toThrow(/complete revision/);
    expect(() =>
      validateLibraryIndex({ ...index, revisions: [{ ...first.revision, bytes: NaN }] }),
    ).toThrow(/invalid revision/);
    expect(() =>
      validateLibraryIndex({ ...index, revisions: [{ ...first.revision, contentHash: 'broken' }] }),
    ).toThrow(/invalid revision/);
    expect(() =>
      validateLibraryIndex({ ...index, projects: [{ ...first.project, updatedAt: -1 }] }),
    ).toThrow(/invalid project/);
    expect(() =>
      validateLibraryIndex({ ...index, revisions: [first.revision, first.revision] }),
    ).toThrow(/invalid revision/);
  });
});
