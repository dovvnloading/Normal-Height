/** Durable user work is never evicted to make room for a different project. */
export const PROJECT_LIBRARY_LIMITS = {
  projects: 50,
  revisionsPerProject: 20,
  bytes: 256 * 1024 * 1024,
} as const;

export interface LibraryProject {
  version: 1;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  headRevisionId: string;
}

export interface LibraryRevision {
  version: 1;
  id: string;
  projectId: string;
  parentRevisionId: string | null;
  label: string;
  savedAt: number;
  contentHash: string;
  bytes: number;
}

/** The expected head provides compare-and-swap protection against another tab. */
export interface ProjectLibraryBinding {
  projectId: string;
  headRevisionId: string;
  sourceRevisionId: string;
}

export interface LibraryIndex {
  projects: LibraryProject[];
  revisions: LibraryRevision[];
}

export class ProjectLibraryConflictError extends Error {
  constructor() {
    super(
      'This project changed in another tab or was removed. Your current work is unchanged. Save as a new project, or reopen the latest revision before saving over it.',
    );
    this.name = 'ProjectLibraryConflictError';
  }
}

const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const validTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
const validHash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Metadata is small and validated independently of large snapshot payloads. */
export function validateLibraryIndex(index: LibraryIndex): LibraryIndex {
  const projects = new Map<string, LibraryProject>();
  const revisions = new Map<string, LibraryRevision>();
  const hashes = new Map<string, number>();
  for (const project of index.projects) {
    if (
      !project ||
      project.version !== 1 ||
      !validId(project.id) ||
      projects.has(project.id) ||
      typeof project.name !== 'string' ||
      project.name.length > 100 ||
      !validTime(project.createdAt) ||
      !validTime(project.updatedAt) ||
      project.updatedAt < project.createdAt ||
      !validId(project.headRevisionId)
    )
      throw new Error('The project library contains invalid project metadata.');
    projects.set(project.id, project);
  }
  for (const revision of index.revisions) {
    if (
      !revision ||
      revision.version !== 1 ||
      !validId(revision.id) ||
      revisions.has(revision.id) ||
      !projects.has(revision.projectId) ||
      (revision.parentRevisionId !== null && !validId(revision.parentRevisionId)) ||
      typeof revision.label !== 'string' ||
      revision.label.length > 100 ||
      !validTime(revision.savedAt) ||
      !validHash(revision.contentHash) ||
      !Number.isSafeInteger(revision.bytes) ||
      revision.bytes <= 0 ||
      revision.bytes > 32 * 1024 * 1024 ||
      (hashes.has(revision.contentHash) && hashes.get(revision.contentHash) !== revision.bytes)
    )
      throw new Error('The project library contains invalid revision metadata.');
    revisions.set(revision.id, revision);
    hashes.set(revision.contentHash, revision.bytes);
  }
  for (const project of projects.values()) {
    if (revisions.get(project.headRevisionId)?.projectId !== project.id)
      throw new Error('A project library head does not refer to a complete revision.');
  }
  return index;
}

/** Includes a conservative fixed allowance for metadata; snapshots deduplicate by content. */
export function libraryBytes(index: LibraryIndex): number {
  const snapshots = new Map(
    index.revisions.map((revision) => [revision.contentHash, revision.bytes]),
  );
  return (
    [...snapshots.values()].reduce((total, bytes) => total + bytes, 0) +
    index.projects.length * 1024 +
    index.revisions.length * 1024
  );
}

export interface LibrarySavePlan {
  project: LibraryProject;
  revision: LibraryRevision;
  removedRevisionIds: string[];
  removedContentHashes: string[];
  unchanged: boolean;
}

/** Pure transaction planner. Admission happens before deletion, even when at quota. */
export function planLibrarySave(
  rawIndex: LibraryIndex,
  input: {
    projectId: string;
    revisionId: string;
    name: string;
    label: string;
    savedAt: number;
    contentHash: string;
    bytes: number;
    binding?: ProjectLibraryBinding;
  },
  limits: { projects: number; revisionsPerProject: number; bytes: number } = PROJECT_LIBRARY_LIMITS,
): LibrarySavePlan {
  const index = validateLibraryIndex(rawIndex);
  const previous = index.projects.find((project) => project.id === input.projectId);
  if (input.binding) {
    if (
      input.binding.projectId !== input.projectId ||
      !previous ||
      previous.headRevisionId !== input.binding.headRevisionId
    )
      throw new ProjectLibraryConflictError();
  } else if (previous) {
    throw new ProjectLibraryConflictError();
  }
  const sourceRevision =
    input.binding &&
    index.revisions.find((revision) => revision.id === input.binding!.sourceRevisionId);
  if (sourceRevision && sourceRevision.projectId !== input.projectId)
    throw new Error('The selected source revision belongs to a different saved project.');
  if (index.revisions.some((revision) => revision.id === input.revisionId))
    throw new Error('A revision with this identifier already exists. Please save again.');
  const head = index.revisions.find((revision) => revision.id === previous?.headRevisionId);
  // Restoring an older revision creates a new head, even if its content happens
  // to match the latest one, so the explicit lineage is retained.
  if (head?.contentHash === input.contentHash && input.binding?.sourceRevisionId === head.id)
    return {
      project: previous!,
      revision: head,
      removedRevisionIds: [],
      removedContentHashes: [],
      unchanged: true,
    };
  if (!previous && index.projects.length >= limits.projects)
    throw new Error(
      `The project library is full (${limits.projects} projects). Download and remove an unused project before adding another.`,
    );
  const savedAt = Math.max(input.savedAt, previous ? previous.updatedAt + 1 : 0);
  const revision: LibraryRevision = {
    version: 1,
    id: input.revisionId,
    projectId: input.projectId,
    parentRevisionId: input.binding?.sourceRevisionId ?? null,
    label: input.label,
    savedAt,
    contentHash: input.contentHash,
    bytes: input.bytes,
  };
  const project: LibraryProject = {
    version: 1,
    id: input.projectId,
    name: input.name,
    createdAt: previous?.createdAt ?? savedAt,
    updatedAt: savedAt,
    headRevisionId: revision.id,
  };
  // Project timestamps are strictly monotonic even when the clock moves back,
  // so random UUID key order never decides which revision is pruned.
  const own = index.revisions
    .filter((item) => item.projectId === project.id)
    .sort((a, b) => a.savedAt - b.savedAt);
  const removedRevisionIds = own
    .slice(0, Math.max(0, own.length + 1 - Math.max(1, limits.revisionsPerProject)))
    .map((item) => item.id);
  const removed = new Set(removedRevisionIds);
  const next: LibraryIndex = {
    projects: [...index.projects.filter((item) => item.id !== project.id), project],
    revisions: [...index.revisions.filter((item) => !removed.has(item.id)), revision],
  };
  validateLibraryIndex(next);
  if (libraryBytes(next) > limits.bytes)
    throw new Error(
      `This checkpoint exceeds the project library's ${Math.round(limits.bytes / 1024 / 1024)} MiB budget. Download and remove unused projects first. No saved work was removed.`,
    );
  const retainedHashes = new Set(next.revisions.map((item) => item.contentHash));
  return {
    project,
    revision,
    removedRevisionIds,
    removedContentHashes: [...new Set(index.revisions.map((item) => item.contentHash))].filter(
      (hash) => !retainedHashes.has(hash),
    ),
    unchanged: false,
  };
}
