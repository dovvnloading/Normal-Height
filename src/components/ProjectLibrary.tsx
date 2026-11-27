import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Download,
  FolderOpen,
  History,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { Modal } from './Modal';
import { saveProject } from '../model/project';
import {
  deleteLibraryProject,
  listProjectLibrary,
  PROJECT_LIBRARY_LIMITS,
  readProjectRevision,
  saveProjectRevision,
  type ProjectLibraryBinding,
  type ProjectLibraryListing,
} from '../model/projectLibrary';
import type { TerrainProject } from '../model/types';
import './ProjectLibrary.css';

const date = (time: number) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(time);
const size = (bytes: number) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MiB` : `${Math.ceil(bytes / 1024)} KiB`;

export function ProjectLibrary({
  project,
  binding,
  onCheckpoint,
  onOpen,
  onDelete,
  onClose,
}: {
  project: TerrainProject;
  binding?: ProjectLibraryBinding;
  onCheckpoint: (binding: ProjectLibraryBinding) => void;
  onOpen: (project: TerrainProject, binding: ProjectLibraryBinding) => boolean;
  onDelete: (projectId: string) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<ProjectLibraryListing>({ projects: [], bytes: 0 });
  const [selectedId, setSelectedId] = useState(binding?.projectId ?? '');
  const [revisionId, setRevisionId] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState('Loading projects…');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [persistent, setPersistent] = useState<boolean | null>(null);
  const mounted = useRef(true);
  const pending = useRef(false);
  const selected = listing.projects.find((entry) => entry.id === selectedId);
  const chosenRevision =
    selected?.revisions.find((revision) => revision.id === revisionId) ?? selected?.revisions[0];
  const refresh = useCallback(async (preferred?: string) => {
    const next = await listProjectLibrary();
    if (!mounted.current) return;
    setListing(next);
    setSelectedId((current) =>
      next.projects.some((entry) => entry.id === (preferred ?? current))
        ? (preferred ?? current)
        : (next.projects[0]?.id ?? ''),
    );
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh()
      .catch((reason: unknown) => {
        if (mounted.current)
          setError(
            reason instanceof Error ? reason.message : 'Could not load the project library.',
          );
      })
      .finally(() => {
        if (mounted.current) setBusy('');
      });
    void navigator.storage
      ?.persisted?.()
      .then((value) => {
        if (mounted.current) setPersistent(value);
      })
      .catch(() => {});
    return () => {
      mounted.current = false;
    };
  }, [refresh]);
  const run = async (message: string, work: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(message);
    setError('');
    setNotice('');
    setConfirmDelete(false);
    try {
      await work();
    } catch (reason) {
      if (mounted.current)
        setError(
          reason instanceof Error ? reason.message : 'This operation could not be completed.',
        );
    } finally {
      pending.current = false;
      if (mounted.current) setBusy('');
    }
  };
  const checkpoint = (copy: boolean) =>
    run('Saving verified checkpoint…', async () => {
      const saved = await saveProjectRevision(project, {
        binding: copy ? undefined : binding,
        label,
      });
      onCheckpoint(saved.binding);
      await refresh(saved.entry.id);
      setRevisionId(saved.revision.id);
      setLabel('');
      setNotice(
        saved.unchanged
          ? 'This document already matches its latest checkpoint.'
          : `Checkpoint saved for ${saved.entry.name}.`,
      );
    });
  const open = () => {
    if (!selected || !chosenRevision) return;
    void run('Verifying revision and preserving current work…', async () => {
      // Verify the destination first. A failed integrity check must not mutate
      // the library or replace the document that is still on screen.
      const target = await readProjectRevision(selected.id, chosenRevision.id);
      const preserved = await saveProjectRevision(project, {
        binding,
        label: 'Before opening another revision',
      });
      onCheckpoint(preserved.binding);
      if (preserved.entry.id === target.entry.id)
        target.binding.headRevisionId = preserved.binding.headRevisionId;
      if (!onOpen(target.project, target.binding))
        throw new Error(
          'The revision could not be opened. Your current work has been checkpointed.',
        );
    });
  };
  return (
    <Modal
      title="Projects & revisions"
      eyebrow="YOUR WORK, RECOVERABLE"
      className="project-library-modal"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="project-library-body" aria-busy={Boolean(busy)}>
        <section className="project-library-current" aria-label="Current project checkpoint">
          <div className="project-library-current-heading">
            <div>
              <small>CURRENT DOCUMENT</small>
              <h3>{project.name || 'Untitled landscape'}</h3>
            </div>
            <span>{binding ? 'Linked to saved project' : 'New document'}</span>
          </div>
          <label htmlFor="checkpoint-label">
            Checkpoint note <span>(optional)</span>
          </label>
          <input
            id="checkpoint-label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Before erosion changes, approved composition…"
            maxLength={100}
            disabled={Boolean(busy)}
          />
          <div className="project-library-actions">
            <button
              type="button"
              className="button primary"
              disabled={Boolean(busy)}
              onClick={() => void checkpoint(false)}
            >
              <Save size={14} />
              Save checkpoint
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={Boolean(busy)}
              onClick={() => void checkpoint(true)}
            >
              <Plus size={14} />
              Save as new project
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={Boolean(busy)}
              onClick={() => {
                try {
                  saveProject(project);
                  setNotice('Current project download started.');
                } catch (reason) {
                  setError(
                    reason instanceof Error ? reason.message : 'Could not download the project.',
                  );
                }
              }}
            >
              <Download size={14} />
              Download current project
            </button>
          </div>
        </section>
        {error && (
          <div className="project-library-error" role="alert">
            {error}
          </div>
        )}
        <div className="project-library-status" role="status" aria-live="polite">
          {busy ? (
            <>
              <LoaderCircle className="spin" size={14} />
              {busy}
            </>
          ) : (
            notice
          )}
        </div>
        <div className="project-library-browser">
          <section className="project-library-projects" aria-label="Saved projects">
            <div className="project-library-section-heading">
              <h3>
                Saved projects <span>{listing.projects.length}</span>
              </h3>
              <button
                type="button"
                className="icon-button small"
                aria-label="Refresh saved projects"
                title="Refresh saved projects"
                disabled={Boolean(busy)}
                onClick={() =>
                  void run('Refreshing projects…', async () => {
                    await refresh();
                  })
                }
              >
                <RefreshCw size={14} />
              </button>
            </div>
            {listing.projects.length === 0 && !busy ? (
              <p className="project-library-empty">
                Save a checkpoint to keep this landscape and its revision history here.
              </p>
            ) : (
              <ul>
                {listing.projects.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      aria-pressed={selectedId === entry.id}
                      disabled={Boolean(busy)}
                      onClick={() => {
                        setSelectedId(entry.id);
                        setRevisionId('');
                        setConfirmDelete(false);
                      }}
                    >
                      <FolderOpen size={16} />
                      <span>
                        <strong>{entry.name || 'Untitled landscape'}</strong>
                        <small>
                          {entry.revisions.length}{' '}
                          {entry.revisions.length === 1 ? 'revision' : 'revisions'} ·{' '}
                          {date(entry.updatedAt)}
                        </small>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="project-library-revisions" aria-label="Saved revisions">
            {selected ? (
              <>
                <div className="project-library-section-heading">
                  <h3>{selected.name || 'Untitled landscape'}</h3>
                  <button
                    type="button"
                    className="icon-button small"
                    aria-label="Remove saved project"
                    title="Remove saved project"
                    disabled={Boolean(busy)}
                    onClick={() => setConfirmDelete(!confirmDelete)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <fieldset disabled={Boolean(busy)}>
                  <legend className="visually-hidden">Select a saved revision</legend>
                  {selected.revisions.map((revision) => (
                    <label className="project-library-revision" key={revision.id}>
                      <input
                        type="radio"
                        name="saved-revision"
                        value={revision.id}
                        checked={chosenRevision?.id === revision.id}
                        onChange={() => setRevisionId(revision.id)}
                      />
                      <History size={15} />
                      <span>
                        <strong>
                          {revision.label}
                          {revision.id === selected.headRevisionId && <em>Latest</em>}
                        </strong>
                        <small>
                          {date(revision.savedAt)} · {size(revision.bytes)}
                        </small>
                      </span>
                    </label>
                  ))}
                </fieldset>
                {confirmDelete ? (
                  <div
                    className="project-library-delete"
                    role="group"
                    aria-label="Confirm project removal"
                  >
                    <p>
                      Remove “{selected.name}” and all {selected.revisions.length} saved revisions
                      from this browser? The current document stays open. Download a copy first if
                      you need it.
                    </p>
                    <div className="project-library-actions">
                      <button
                        type="button"
                        className="button secondary"
                        disabled={Boolean(busy)}
                        onClick={() => setConfirmDelete(false)}
                      >
                        Keep project
                      </button>
                      <button
                        type="button"
                        className="button secondary"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void run('Removing saved project…', async () => {
                            await deleteLibraryProject(selected.id, selected.headRevisionId);
                            onDelete(selected.id);
                            await refresh();
                            setNotice('Saved project removed. The current document is unchanged.');
                          })
                        }
                      >
                        Delete project and revisions
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="project-library-open-note">
                      Opening a revision first saves a checkpoint of your current document. If that
                      save fails, your document stays open.
                    </p>
                    <div className="project-library-actions">
                      <button
                        type="button"
                        className="button primary"
                        disabled={Boolean(busy) || !chosenRevision}
                        onClick={open}
                      >
                        <FolderOpen size={14} />
                        Open selected revision
                      </button>
                      <button
                        type="button"
                        className="button secondary"
                        disabled={Boolean(busy) || !chosenRevision}
                        onClick={() =>
                          void run('Verifying project download…', async () => {
                            const restored = await readProjectRevision(
                              selected.id,
                              chosenRevision!.id,
                            );
                            saveProject(restored.project);
                            setNotice('Verified revision download started.');
                          })
                        }
                      >
                        <Download size={14} />
                        Download revision
                      </button>
                    </div>
                  </>
                )}
              </>
            ) : (
              <div className="project-library-empty">
                <History size={28} />
                <p>Choose a project to inspect and restore its saved revisions.</p>
              </div>
            )}
          </section>
        </div>
        <footer className="project-library-footer">
          <p>
            {size(listing.bytes)} of {size(PROJECT_LIBRARY_LIMITS.bytes)} · Latest{' '}
            {PROJECT_LIBRARY_LIMITS.revisionsPerProject} revisions per project ·{' '}
            {PROJECT_LIBRARY_LIMITS.projects} projects maximum.
            <br />
            Saved in this browser on this device. Download projects for backups and transfers.
          </p>
          {persistent ? (
            <span>
              <ShieldCheck size={14} />
              Browser storage protected
            </span>
          ) : (
            navigator.storage?.persist && (
              <button
                type="button"
                className="button secondary"
                disabled={Boolean(busy)}
                onClick={() =>
                  void run('Requesting durable browser storage…', async () => {
                    const protectedStorage = await navigator.storage.persist();
                    setPersistent(protectedStorage);
                    setNotice(
                      protectedStorage
                        ? 'The browser granted persistent storage. Keep downloaded backups as well.'
                        : 'The browser did not grant persistent storage. Your saved projects remain available, but keep downloaded backups.',
                    );
                  })
                }
              >
                <ShieldCheck size={14} />
                Protect browser storage
              </button>
            )
          )}
        </footer>
      </div>
    </Modal>
  );
}
