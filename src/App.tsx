import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MountainSnow,
  ChevronDown,
  Download,
  FolderOpen,
  Save,
  Undo2,
  Redo2,
  Play,
  LoaderCircle,
  Check,
  HelpCircle,
  PanelLeftClose,
  PanelLeftOpen,
  SlidersHorizontal,
  X,
  AlertCircle,
  Plus,
  GitBranch,
  CheckCircle2,
} from 'lucide-react';
import { Library } from './components/Library';
import { Inspector } from './components/Inspector';
import { NodeGraph } from './components/NodeGraph';
import { TerrainViewport } from './components/TerrainViewport';
import { ExportDialog } from './components/ExportDialog';
import { HelpDialog } from './components/HelpDialog';
import { Modal } from './components/Modal';
import { createNode } from './model/registry';
import { createProject, PRESETS } from './model/presets';
import { parseProject, saveProject, STORAGE_KEY } from './model/project';
import { useTerrainEngine } from './hooks/useTerrainEngine';
import type {
  MapChannel,
  NodeKind,
  ParamValue,
  TerrainGraph,
  TerrainProject,
  ViewMode,
  ViewSettings,
} from './model/types';

const DEFAULT_SETTINGS: ViewSettings = {
  material: 'alpine',
  sunAzimuth: 315,
  sunElevation: 38,
  exaggeration: 1,
  contours: false,
  wireframe: false,
  autoRotate: false,
};
function initialProject() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return { project: saved ? parseProject(JSON.parse(saved)) : createProject(), message: '' };
  } catch {
    return {
      project: createProject(),
      message: 'The previous autosave could not be restored. A fresh landscape is ready.',
    };
  }
}
const isEditing = (element: EventTarget | null) =>
  element instanceof HTMLElement &&
  (element.matches('input,textarea,select') || element.isContentEditable);

export default function App() {
  const [initial] = useState(initialProject);
  const [project, setProject] = useState(initial.project);
  const projectRef = useRef(project);
  projectRef.current = project;
  const [selectedId, setSelectedId] = useState<string | null>(
    initial.project.graph.nodes.find((n) => n.kind === 'hydraulic')?.id ?? null,
  );
  const [previewNodeId, setPreviewNodeId] = useState<string | undefined>();
  const [viewMode, setViewMode] = useState<ViewMode>('3d');
  const [channel, setChannel] = useState<MapChannel>('height');
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [automatic, setAutomatic] = useState(true);
  const [modal, setModal] = useState<'export' | 'help' | 'palette' | 'presets' | null>(null);
  const [leftOpen, setLeftOpen] = useState(() => window.innerWidth > 1050);
  const [rightOpen, setRightOpen] = useState(() => window.innerWidth > 760);
  const [graphRatio, setGraphRatio] = useState(36);
  const [toast, setToast] = useState(initial.message);
  const [saved, setSaved] = useState(true);
  const [storageError, setStorageError] = useState(false);
  const [historyTick, setHistoryTick] = useState(0);
  const past = useRef<TerrainProject[]>([]);
  const future = useRef<TerrainProject[]>([]);
  const pendingMove = useRef<TerrainProject | null>(null);
  const lastEdit = useRef({ group: '', time: 0 });
  const fileInput = useRef<HTMLInputElement>(null);
  const centerRef = useRef<HTMLElement>(null);
  const engine = useTerrainEngine(project, previewNodeId, automatic);
  const selected = project.graph.nodes.find((n) => n.id === selectedId) ?? null;
  const output = project.graph.nodes.find((n) => n.kind === 'output');
  const previewLabel =
    project.graph.nodes.find((n) => n.id === (previewNodeId ?? output?.id))?.label ??
    'Terrain output';
  const notify = useCallback((message: string) => setToast(message), []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 6500);
    return () => clearTimeout(timer);
  }, [toast]);
  const apply = useCallback((next: TerrainProject, group = '', record = true) => {
    const previous = projectRef.current;
    const changed = JSON.stringify(next) !== JSON.stringify(previous);
    if (!changed && !pendingMove.current) return;
    if (!record) {
      pendingMove.current ??= previous;
    } else {
      const now = performance.now();
      if (
        pendingMove.current ||
        !group ||
        lastEdit.current.group !== group ||
        now - lastEdit.current.time > 900
      ) {
        past.current = [...past.current.slice(-59), pendingMove.current ?? previous];
        future.current = [];
        setHistoryTick((n) => n + 1);
      }
      pendingMove.current = null;
      lastEdit.current = { group, time: now };
    }
    projectRef.current = next;
    setProject(next);
  }, []);
  const undo = useCallback(() => {
    const previous = past.current.pop();
    if (!previous) return;
    future.current.push(projectRef.current);
    pendingMove.current = null;
    lastEdit.current = { group: '', time: 0 };
    projectRef.current = previous;
    setProject(previous);
    setHistoryTick((n) => n + 1);
  }, []);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(projectRef.current);
    pendingMove.current = null;
    lastEdit.current = { group: '', time: 0 };
    projectRef.current = next;
    setProject(next);
    setHistoryTick((n) => n + 1);
  }, []);
  useEffect(() => {
    setSaved(false);
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
        setSaved(true);
        setStorageError(false);
      } catch {
        setStorageError(true);
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [project]);
  useEffect(() => {
    if (previewNodeId && !project.graph.nodes.some((n) => n.id === previewNodeId))
      setPreviewNodeId(undefined);
    if (selectedId && !project.graph.nodes.some((n) => n.id === selectedId)) setSelectedId(null);
  }, [project, previewNodeId, selectedId]);
  const updateGraph = useCallback(
    (graph: TerrainGraph, history = true) => apply({ ...projectRef.current, graph }, '', history),
    [apply],
  );
  const updateProject = useCallback(
    (patch: Partial<TerrainProject>) =>
      apply({ ...projectRef.current, ...patch }, Object.keys(patch).join('-')),
    [apply],
  );
  const updateNode = useCallback(
    (patch: Partial<NonNullable<typeof selected>>, group = '') => {
      if (!selectedId) return;
      const current = projectRef.current;
      apply(
        {
          ...current,
          graph: {
            ...current.graph,
            nodes: current.graph.nodes.map((n) => (n.id === selectedId ? { ...n, ...patch } : n)),
          },
        },
        group,
      );
    },
    [selectedId, apply],
  );
  const addNode = useCallback(
    (kind: NodeKind, params?: Record<string, ParamValue>) => {
      const p = projectRef.current;
      if (p.graph.nodes.length >= 128) {
        notify('This project has reached the 128-node limit.');
        return;
      }
      const anchor = p.graph.nodes.find((n) => n.id === selectedId);
      let position = { x: anchor?.position.x ?? 100, y: (anchor?.position.y ?? 100) + 230 };
      if (anchor?.parentId) {
        const parent = p.graph.nodes.find((n) => n.id === anchor.parentId);
        position = {
          x: position.x + (parent?.position.x ?? 0),
          y: position.y + (parent?.position.y ?? 0),
        };
      }
      const node = createNode(kind, position);
      if (params) node.params = { ...node.params, ...params };
      if (kind === 'noise' && params?.mode)
        node.label =
          String(params.mode)
            .replace(/-/g, ' ')
            .replace(/^./, (s) => s.toUpperCase()) + ' noise';
      apply({ ...p, graph: { ...p.graph, nodes: [...p.graph.nodes, node] } });
      setSelectedId(node.id);
      setRightOpen(true);
      setModal(null);
      notify(`${node.label} added. Connect its ports in the graph.`);
    },
    [selectedId, apply, notify],
  );
  const duplicate = useCallback(() => {
    const p = projectRef.current;
    const n = p.graph.nodes.find((n) => n.id === selectedId);
    if (!n || n.kind === 'output' || n.kind === 'group') return;
    const copy = {
      ...structuredClone(n),
      id: crypto.randomUUID(),
      label: `${n.label} copy`,
      position: { x: n.position.x + 35, y: n.position.y + 180 },
    };
    apply({ ...p, graph: { ...p.graph, nodes: [...p.graph.nodes, copy] } });
    setSelectedId(copy.id);
  }, [selectedId, apply]);
  const remove = useCallback(() => {
    if (!selectedId) return;
    const p = projectRef.current;
    const removed = p.graph.nodes.find((n) => n.id === selectedId);
    apply({
      ...p,
      graph: {
        nodes: p.graph.nodes
          .filter((n) => n.id !== selectedId)
          .map((n) =>
            n.parentId === selectedId
              ? {
                  ...n,
                  parentId: undefined,
                  position: {
                    x: n.position.x + (removed?.position.x ?? 0),
                    y: n.position.y + (removed?.position.y ?? 0),
                  },
                }
              : n,
          ),
        edges: p.graph.edges.filter((e) => e.source !== selectedId && e.target !== selectedId),
      },
    });
    setSelectedId(null);
  }, [selectedId, apply]);
  const loadPreset = useCallback(
    (id: string) => {
      apply(createProject(id));
      setSelectedId('erosion');
      setPreviewNodeId(undefined);
      setModal(null);
      notify(
        `${PRESETS.find((p) => p.id === id)?.name ?? 'Landscape'} loaded. Undo restores your previous graph.`,
      );
    },
    [apply, notify],
  );
  const preview = useCallback(
    (id: string) =>
      setPreviewNodeId(
        id === projectRef.current.graph.nodes.find((n) => n.kind === 'output')?.id ? undefined : id,
      ),
    [],
  );
  const save = useCallback(() => {
    saveProject(projectRef.current);
    notify('Project downloaded. Your graph, parameters, and seeds are included.');
  }, [notify]);
  const openFile = async (file: File) => {
    try {
      if (file.size > 3_000_000)
        throw new Error('This project is too large. The maximum file size is 3 MB.');
      const loaded = parseProject(JSON.parse(await file.text()));
      apply(loaded);
      setPreviewNodeId(undefined);
      setSelectedId(
        loaded.graph.nodes.find((n) => n.kind === 'hydraulic')?.id ??
          loaded.graph.nodes[0]?.id ??
          null,
      );
      notify(`Opened ${loaded.name}.`);
    } catch (e) {
      notify(e instanceof Error ? e.message : 'This project could not be opened.');
    }
    if (fileInput.current) fileInput.current.value = '';
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.defaultPrevented || modal) return;
      const command = event.ctrlKey || event.metaKey;
      if (command && event.key.toLowerCase() === 's') {
        event.preventDefault();
        save();
        return;
      }
      if (isEditing(event.target)) return;
      if (command && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
      } else if (command && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
      } else if (command && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        duplicate();
      } else if (event.key === '/' && !command) {
        event.preventDefault();
        setLeftOpen(true);
        setTimeout(
          () =>
            document
              .querySelector<HTMLInputElement>('.library input[aria-label="Search nodes"]')
              ?.focus(),
          0,
        );
      } else if (
        event.key === 'Tab' &&
        !event.shiftKey &&
        (document.activeElement === document.body ||
          (event.target instanceof HTMLElement && Boolean(event.target.closest('.react-flow'))))
      ) {
        event.preventDefault();
        setModal('palette');
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId) {
        event.preventDefault();
        remove();
      } else if (event.key === 'Escape') {
        setSelectedId(null);
      } else if (event.key === '?') {
        setModal('help');
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [modal, undo, redo, duplicate, remove, save, selectedId]);
  const resizeGraph = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      const rect = centerRef.current?.getBoundingClientRect();
      if (rect)
        setGraphRatio(Math.max(22, Math.min(65, ((rect.bottom - e.clientY) / rect.height) * 100)));
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  };
  const graphHeight = useMemo(() => `${graphRatio}%`, [graphRatio]);
  return (
    <div
      className={`app-shell ${!leftOpen ? 'library-collapsed' : ''} ${!rightOpen ? 'inspector-collapsed' : ''}`}
    >
      <header className="app-header">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setModal('help');
          }}
          aria-label="Normal Height field guide"
        >
          <span className="brand-mark">
            <MountainSnow size={24} strokeWidth={1.6} />
          </span>
          <span>
            NORMAL<span className="brand-divider">/</span>HEIGHT
            <small>PROCEDURAL TERRAIN STUDIO</small>
          </span>
        </a>
        <div className="project-heading">
          <button
            className="project-name"
            onClick={() => setModal('presets')}
            title="Choose a landscape"
          >
            <span className="project-type-mark" />
            <span>{project.name}</span>
            <ChevronDown size={13} />
          </button>
          <span className={`save-state ${storageError ? 'error' : ''}`}>
            {storageError ? (
              <AlertCircle size={11} />
            ) : saved ? (
              <Check size={11} />
            ) : (
              <span className="tiny-dot" />
            )}
            {storageError ? 'Save unavailable' : saved ? 'Saved locally' : 'Saving…'}
          </span>
        </div>
        <div className="header-actions">
          <button
            className="icon-button"
            aria-label="Undo"
            title="Undo · Ctrl/⌘ Z"
            onClick={undo}
            disabled={past.current.length === 0}
            data-history={historyTick}
          >
            <Undo2 size={16} />
          </button>
          <button
            className="icon-button"
            aria-label="Redo"
            title="Redo · Ctrl/⌘ Shift Z"
            onClick={redo}
            disabled={future.current.length === 0}
          >
            <Redo2 size={16} />
          </button>
          <span className="toolbar-separator" />
          <button
            className="icon-button"
            aria-label="Open project"
            title="Open a terrain project"
            onClick={() => fileInput.current?.click()}
          >
            <FolderOpen size={17} />
          </button>
          <button
            className="icon-button"
            aria-label="Save project"
            title="Download project · Ctrl/⌘ S"
            onClick={save}
          >
            <Save size={16} />
          </button>
          <button
            className="icon-button header-help"
            aria-label="Open field guide"
            title="Field guide & shortcuts"
            onClick={() => setModal('help')}
          >
            <HelpCircle size={17} />
          </button>
          <span className="toolbar-separator" />
          <button className="button primary export-button" onClick={() => setModal('export')}>
            <Download size={15} />
            <span>Export maps</span>
            <ChevronDown size={12} />
          </button>
        </div>
      </header>
      <div className="workspace-toolbar">
        <div className="workspace-title">
          <button
            className="icon-button small"
            aria-label={leftOpen ? 'Hide node library' : 'Show node library'}
            title="Toggle node library"
            onClick={() => setLeftOpen(!leftOpen)}
          >
            {leftOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
          </button>
          <span className="workspace-label">Terrain workspace</span>
          <ChevronDown size={10} />
        </div>
        <div className="workspace-build">
          <label className="working-resolution">
            <span>Working grid</span>
            <select
              aria-label="Working resolution"
              value={project.resolution}
              onChange={(e) => updateProject({ resolution: Number(e.target.value) })}
            >
              {[128, 256, 512, 768, 1024].map((n) => (
                <option key={n} value={n}>
                  {n} × {n}
                </option>
              ))}
            </select>
          </label>
          <label className="auto-build">
            <input
              type="checkbox"
              checked={automatic}
              onChange={(e) => setAutomatic(e.target.checked)}
            />
            <span className="auto-indicator" />
            Auto build
          </label>
          <button
            className="button build-button"
            onClick={engine.busy ? engine.cancel : engine.build}
          >
            {engine.busy ? (
              <LoaderCircle size={13} className="spin" />
            ) : (
              <Play size={12} fill="currentColor" />
            )}
            {engine.busy ? 'Cancel' : 'Build terrain'}
          </button>
          <button
            className={`icon-button small ${rightOpen ? 'active' : ''}`}
            aria-label={rightOpen ? 'Hide inspector' : 'Show inspector'}
            title="Toggle inspector"
            onClick={() => setRightOpen(!rightOpen)}
          >
            <SlidersHorizontal size={15} />
          </button>
        </div>
      </div>
      <div className="workspace-body">
        {leftOpen && (
          <Library
            seed={project.seed}
            onSeed={(seed) => updateProject({ seed })}
            onAdd={addNode}
            onPreset={loadPreset}
            activePreset={project.presetId}
          />
        )}
        <main className="work-area" ref={centerRef} aria-label="Terrain workspace">
          <section className="preview-area">
            <TerrainViewport
              field={engine.result?.field ?? null}
              project={project}
              viewMode={viewMode}
              channel={channel}
              settings={settings}
              busy={engine.busy}
              progress={engine.progress}
              stage={engine.stage}
              stale={engine.stale}
              previewLabel={previewLabel}
              onViewModeChange={setViewMode}
              onChannelChange={setChannel}
              onSettingsChange={setSettings}
              onCancel={engine.cancel}
            />
            {previewNodeId && (
              <button className="return-output" onClick={() => setPreviewNodeId(undefined)}>
                <ArrowOutput />
                Return to Terrain output
                <X size={12} />
              </button>
            )}
            {engine.error && (
              <div className="graph-error" role="alert">
                <AlertCircle size={16} />
                <div>
                  <strong>Check your graph</strong>
                  <p>{engine.error}</p>
                  {engine.result && <small>The last successful terrain remains visible.</small>}
                </div>
              </div>
            )}
          </section>
          <div
            className="workspace-divider"
            role="separator"
            aria-label="Resize graph"
            aria-orientation="horizontal"
            aria-valuemin={22}
            aria-valuemax={65}
            aria-valuenow={Math.round(graphRatio)}
            tabIndex={0}
            onPointerDown={resizeGraph}
            onKeyDown={(e) => {
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setGraphRatio((v) => Math.min(65, v + 3));
              }
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setGraphRatio((v) => Math.max(22, v - 3));
              }
            }}
          >
            <span />
          </div>
          <section
            className="graph-area"
            style={{ height: graphHeight }}
            aria-label="Procedural node graph"
          >
            <NodeGraph
              graph={project.graph}
              onChange={updateGraph}
              selectedId={selectedId}
              onSelect={setSelectedId}
              previewNodeId={previewNodeId ?? output?.id}
              onPreview={preview}
              thumbnails={engine.result?.thumbnails}
              nodeTimings={engine.result?.nodeTimings}
              onAdd={() => setModal('palette')}
              onError={notify}
            />
          </section>
        </main>
        {rightOpen && (
          <Inspector
            node={selected}
            project={project}
            previewNodeId={previewNodeId ?? output?.id}
            onParam={(key, value) => {
              if (selected)
                updateNode(
                  { params: { ...selected.params, [key]: value } },
                  `${selected.id}-${key}`,
                );
            }}
            onRename={(label) => updateNode({ label }, `${selectedId}-label`)}
            onBypass={() => selected && updateNode({ bypassed: !selected.bypassed })}
            onPreview={preview}
            onDuplicate={duplicate}
            onDelete={remove}
            onProjectChange={updateProject}
            settings={settings}
            onSettingsChange={setSettings}
          />
        )}
      </div>
      <footer className="status-bar">
        <div>
          <span
            className={`status-dot ${engine.busy ? 'working' : engine.error ? 'error' : engine.stale ? 'stale' : ''}`}
          />
          <span>
            {engine.busy
              ? engine.stage
              : engine.error
                ? 'Graph needs attention'
                : engine.stale
                  ? 'Preview out of date'
                  : 'Terrain ready'}
          </span>
          {engine.busy && (
            <span className="status-progress">{Math.round(engine.progress * 100)}%</span>
          )}
        </div>
        <div className="status-center">
          <GitBranch size={11} />
          {project.graph.nodes.filter((n) => n.kind !== 'group' && n.kind !== 'note').length} nodes
          <span>·</span>
          {project.graph.edges.length} connections
        </div>
        <div>
          <span>
            {engine.result ? `${engine.result.field.resolution}² samples` : 'Float32 terrain'}
          </span>
          <span>·</span>
          <span>
            {engine.result ? `${(engine.result.duration / 1000).toFixed(2)} s` : 'Worker ready'}
          </span>
          <span>·</span>
          <span>{(project.worldSize / 1000).toFixed(1)} km tile</span>
          <button
            className="status-help"
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts"
            onClick={() => setModal('help')}
          >
            ?
          </button>
        </div>
      </footer>
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={16} />
          <span>{toast}</span>
          <button
            className="icon-button small"
            aria-label="Dismiss notification"
            onClick={() => setToast('')}
          >
            <X size={13} />
          </button>
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        accept=".json,.nhterrain"
        className="visually-hidden"
        aria-label="Import terrain project file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void openFile(file);
        }}
      />
      {modal === 'export' && <ExportDialog project={project} onClose={() => setModal(null)} />}
      {modal === 'help' && <HelpDialog onClose={() => setModal(null)} />}
      {modal === 'palette' && (
        <Modal
          title="Add to your process"
          eyebrow="NODE LIBRARY"
          onClose={() => setModal(null)}
          className="palette-modal"
        >
          <Library
            seed={project.seed}
            onSeed={(seed) => updateProject({ seed })}
            onAdd={addNode}
            onPreset={loadPreset}
            activePreset={project.presetId}
            compact
          />
        </Modal>
      )}
      {modal === 'presets' && (
        <Modal
          title="Begin with a landscape"
          eyebrow="EDITABLE STARTING POINTS"
          onClose={() => setModal(null)}
          className="presets-modal"
        >
          <div className="modal-body">
            <label className="project-name-field">
              Project name
              <input
                value={project.name}
                onChange={(e) => updateProject({ name: e.target.value })}
                aria-label="Project name"
                maxLength={100}
              />
            </label>
            <p className="preset-dialog-intro">
              Each landscape is a complete, editable graph. Loading one adds an undo step, so you
              can return to your work.
            </p>
            <div className="preset-dialog-list">
              {PRESETS.map((p) => (
                <button key={p.id} onClick={() => loadPreset(p.id)}>
                  <MountainSnow size={24} style={{ color: p.color }} />
                  <span>
                    <strong>{p.name}</strong>
                    <small>{p.description}</small>
                  </span>
                  {project.presetId === p.id ? <Check size={17} /> : <Plus size={17} />}
                </button>
              ))}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
function ArrowOutput() {
  return <GitBranch size={13} />;
}
