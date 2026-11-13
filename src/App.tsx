import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  Download,
  FolderOpen,
  Save,
  Undo2,
  History,
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
  Moon,
  Sun,
} from 'lucide-react';
import { Library } from './components/Library';
import { Inspector } from './components/Inspector';
import { NodeGraph } from './components/NodeGraph';
import { TerrainViewport } from './components/TerrainViewport';
import { ExportDialog } from './components/ExportDialog';
import { HelpDialog } from './components/HelpDialog';
import { Modal } from './components/Modal';
import { TerrainIcon, PRESET_ICON_NAMES } from './components/TerrainIcon';
import { createNode } from './model/registry';
import { createProject, PRESETS } from './model/presets';
import { parseProject, saveProject, STORAGE_KEY } from './model/project';
import { loadViewSettings, saveViewSettings } from './model/viewSettings';
import type { SplinePoint } from './model/splines';
import { useTerrainEngine } from './hooks/useTerrainEngine';
import type {
  MapChannel,
  HeightField,
  NodeKind,
  ParamValue,
  TerrainGraph,
  TerrainProject,
  ViewMode,
  ViewSettings,
} from './model/types';

type ThemeMode = 'light' | 'dark';
const THEME_STORAGE_KEY = 'normal-height.theme.v1';
function savedTheme(): ThemeMode | null {
  try {
    const choice = localStorage.getItem(THEME_STORAGE_KEY);
    return choice === 'light' || choice === 'dark' ? choice : null;
  } catch {
    return null;
  }
}

// Every session opens the current default landscape. The autosave of the
// last session is offered (Restore last session), never loaded by itself:
// an old scene would hide newer presets and engine defaults.
function initialProject() {
  let lastSession: TerrainProject | null = null;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) lastSession = parseProject(JSON.parse(saved));
  } catch {
    lastSession = null;
  }
  return { project: createProject(), lastSession, message: '' };
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
  const [editingSplineId, setEditingSplineId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('3d');
  const [channel, setChannel] = useState<MapChannel>('height');
  const [settings, setSettings] = useState<ViewSettings>(loadViewSettings);
  const [automatic, setAutomatic] = useState(true);
  // No saved choice means follow the OS; a manual toggle becomes persistent.
  const [themeChoice, setThemeChoice] = useState<ThemeMode | null>(savedTheme);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false,
  );
  const theme: ThemeMode = themeChoice ?? (systemDark ? 'dark' : 'light');
  const [modal, setModal] = useState<'export' | 'help' | 'palette' | 'presets' | null>(null);
  const [leftOpen, setLeftOpen] = useState(() => window.innerWidth > 1050);
  const [rightOpen, setRightOpen] = useState(() => window.innerWidth > 760);
  // Sidebars become temporary overlays at different breakpoints. Close each
  // only when crossing into its overlay layout; otherwise a panel opened on
  // desktop can cover the viewport's toolbar after a browser resize.
  useEffect(() => {
    const libraryOverlay = window.matchMedia('(max-width: 1050px)');
    const bothOverlays = window.matchMedia('(max-width: 760px)');
    const hideLibrary = (event: MediaQueryListEvent) => {
      if (event.matches) setLeftOpen(false);
    };
    const hideBoth = (event: MediaQueryListEvent) => {
      if (event.matches) { setLeftOpen(false); setRightOpen(false); }
    };
    libraryOverlay.addEventListener('change', hideLibrary);
    bothOverlays.addEventListener('change', hideBoth);
    return () => {
      libraryOverlay.removeEventListener('change', hideLibrary);
      bothOverlays.removeEventListener('change', hideBoth);
    };
  }, []);
  const [graphRatio, setGraphRatio] = useState(36);
  const [viewportFocus, setViewportFocus] = useState(false);
  const [baseline, setBaseline] = useState<{
    field: HeightField;
    project: TerrainProject;
    label: string;
  } | null>(null);
  const [toast, setToast] = useState(initial.message);
  // The previous session's autosave, until the user restores it or edits.
  const [lastSession, setLastSession] = useState(initial.lastSession);
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
  // Editor settings can change while the last valid Float32 field remains on
  // screen. Keep its original physical extent, height scale and seed until a
  // matching worker result arrives. Visual-only surface controls stay live.
  const displayedProject = useMemo(() => {
    const built = engine.result && engine.completedProject;
    return built ? {
      ...project,
      worldSize: built.worldSize,
      heightScale: built.heightScale,
      seed: built.seed,
    } : project;
  }, [project, engine.result, engine.completedProject]);
  const selected = project.graph.nodes.find((n) => n.id === selectedId) ?? null;
  const selectedSpline = selected?.kind === 'spline' ? selected : null;
  const output = project.graph.nodes.find((n) => n.kind === 'output');
  const previewLabel =
    project.graph.nodes.find((n) => n.id === (previewNodeId ?? output?.id))?.label ??
    'Terrain output';
  const lastBuiltPreviewLabel = useMemo(() => {
    const built = engine.completedProject;
    if (!built) return null;
    const id = engine.completedPreviewNodeId ??
      built.graph.nodes.find((node) => node.kind === 'output')?.id;
    return built.graph.nodes.find((node) => node.id === id)?.label ?? 'Terrain output';
  }, [engine.completedProject, engine.completedPreviewNodeId]);
  const displayedPreviewLabel = engine.stale && engine.result && lastBuiltPreviewLabel
    ? `Last built: ${lastBuiltPreviewLabel}` : previewLabel;
  const notify = useCallback((message: string) => setToast(message), []);
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!query) return;
    const update = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      'content',
      theme === 'dark' ? '#292e30' : '#e9ebe7',
    );
  }, [theme]);
  useEffect(() => saveViewSettings(settings), [settings]);
  const toggleTheme = () => {
    const next: ThemeMode = theme === 'dark' ? 'light' : 'dark';
    setThemeChoice(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      notify('This browser cannot save appearance preferences; the switch still works.');
    }
  };
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
    // The untouched starting landscape is not saved over the last session;
    // the first edit (or a restore) starts autosaving and retires the offer.
    if (project === initial.project) return;
    setLastSession(null);
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
  }, [project, initial.project]);
  useEffect(() => {
    if (previewNodeId && !project.graph.nodes.some((n) => n.id === previewNodeId))
      setPreviewNodeId(undefined);
    if (selectedId && !project.graph.nodes.some((n) => n.id === selectedId)) setSelectedId(null);
    if (editingSplineId && (editingSplineId !== selectedId || !project.graph.nodes.some((n) => n.id === editingSplineId)))
      setEditingSplineId(null);
  }, [project, previewNodeId, selectedId, editingSplineId]);
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
      if (kind === 'spline') {
        // Insert the designer immediately before hydraulic erosion (or before
        // the final output), preserving the existing procedural pipeline.
        const target = p.graph.nodes.find((n) => n.kind === 'hydraulic') ??
          p.graph.nodes.find((n) => n.kind === 'output');
        const inputEdge = target && p.graph.edges.find(
          (e) => e.target === target.id && (e.targetHandle ?? 'in') === 'in',
        );
        if (target && inputEdge && !target.parentId) {
          node.position = { ...target.position };
          const affected = p.graph.nodes.map((n) =>
            !n.parentId && n.position.x >= target.position.x
              ? { ...n, position: { ...n.position, x: n.position.x + 240 } }
              : n,
          );
          apply({
            ...p,
            graph: {
              nodes: [...affected, node],
              edges: [
                ...p.graph.edges.filter((e) => e.id !== inputEdge.id),
                { ...inputEdge, id: crypto.randomUUID(), target: node.id, targetHandle: 'in' },
                {
                  id: crypto.randomUUID(),
                  source: node.id,
                  target: target.id,
                  sourceHandle: 'height',
                  targetHandle: 'in',
                },
              ],
            },
          });
        } else apply({ ...p, graph: { ...p.graph, nodes: [...p.graph.nodes, node] } });
        setEditingSplineId(node.id);
        setViewMode('2d');
        setChannel('terrain');
        notify('River / ridge designer added. Drag points on the 2D map; click to insert a point.');
      } else {
        apply({ ...p, graph: { ...p.graph, nodes: [...p.graph.nodes, node] } });
        notify(`${node.label} added. Connect its ports in the graph.`);
      }
      setSelectedId(node.id);
      setRightOpen(true);
      setModal(null);
    },
    [selectedId, apply, notify],
  );
  const changeSplinePath = useCallback((path: SplinePoint[]) => {
    const id = editingSplineId ?? (projectRef.current.graph.nodes.find(
      (node) => node.id === selectedId && node.kind === 'spline',
    )?.id);
    if (!id) return;
    const current = projectRef.current;
    apply({
      ...current,
      graph: {
        ...current.graph,
        nodes: current.graph.nodes.map((node) =>
          node.id === id ? { ...node, path: path.map((point) => ({ ...point })) } : node,
        ),
      },
    });
  }, [editingSplineId, selectedId, apply]);

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
    setEditingSplineId(null);
  }, [selectedId, apply]);
  const restoreLastSession = useCallback(() => {
    if (!lastSession) return;
    apply(lastSession);
    setEditingSplineId(null);
    setPreviewNodeId(undefined);
    setSelectedId(
      lastSession.graph.nodes.find((n) => n.kind === 'hydraulic')?.id ??
        lastSession.graph.nodes[0]?.id ??
        null,
    );
    notify(`Restored ${lastSession.name}.`);
  }, [apply, lastSession, notify]);
  const loadPreset = useCallback(
    (id: string) => {
      const next = createProject(id);
      apply(next);
      const designer = next.graph.nodes.find((node) => node.kind === 'spline');
      setSelectedId(designer?.id ?? next.graph.nodes.find((node) => node.kind === 'hydraulic')?.id ?? null);
      setPreviewNodeId(undefined);
      setEditingSplineId(designer?.id ?? null);
      if (designer) {
        setViewMode('2d');
        setChannel('terrain');
      }
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
      setEditingSplineId(null);
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
      if (command && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setModal('palette');
        return;
      }
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
      } else if (event.key.toLowerCase() === 'f' && !command &&
        event.target instanceof HTMLElement && event.target.closest('.nh-viewport')) {
        event.preventDefault();
        setViewportFocus((v) => !v);
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId) {
        event.preventDefault();
        remove();
      } else if (event.key === 'Escape') {
        if (viewportFocus) setViewportFocus(false);
        else setSelectedId(null);
      } else if (event.key === '?') {
        setModal('help');
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [modal, undo, redo, duplicate, remove, save, selectedId, viewportFocus]);
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
  const sedimentBudget = engine.result?.stats.sedimentBudget;
  return (
    <div
      className={`app-shell ${!leftOpen ? 'library-collapsed' : ''} ${!rightOpen ? 'inspector-collapsed' : ''} ${viewportFocus ? 'viewport-focus' : ''}`}
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
            <TerrainIcon name="normal-height-logo" height={24} />
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
          {lastSession && (
            <button
              type="button"
              className="button secondary restore-session"
              title={`Open "${lastSession.name}", autosaved in this browser`}
              onClick={restoreLastSession}
            >
              <History size={12} />
              Restore last session
            </button>
          )}
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
          <button
            type="button"
            className="icon-button theme-toggle"
            aria-label="Dark mode"
            aria-pressed={theme === 'dark'}
            title={theme === 'dark' ? 'Switch to light stone theme' : 'Switch to dark charcoal theme'}
            onClick={toggleTheme}
          >
            {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
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
              spline={selectedSpline}
              splineEditing={Boolean(selectedSpline && editingSplineId === selectedSpline.id)}
              onSplinePath={changeSplinePath}
              theme={theme}
              field={engine.result?.field ?? null}
              project={displayedProject}
              viewMode={viewMode}
              channel={channel}
              settings={settings}
              busy={engine.busy}
              progress={engine.progress}
              stage={engine.stage}
              stale={engine.stale}
              previewLabel={displayedPreviewLabel}
              onViewModeChange={setViewMode}
              onChannelChange={setChannel}
              onSettingsChange={setSettings}
              onCancel={engine.cancel}
              focusMode={viewportFocus}
              onFocusModeChange={setViewportFocus}
              baseline={baseline}
              onCaptureBaseline={() => {
                if (!engine.result || engine.stale || engine.busy) {
                  notify('Build the current terrain before pinning a comparison baseline.');
                  return;
                }
                setBaseline({ field: engine.result.field, project: structuredClone(project), label: previewLabel });
                notify('Comparison baseline pinned. Change your terrain, then open Compare.');
              }}
              onClearBaseline={() => setBaseline(null)}
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
              theme={theme}
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
            splineEditing={Boolean(selectedSpline && editingSplineId === selectedSpline.id)}
            onSplinePath={changeSplinePath}
            onSplineEdit={() => {
              if (!selectedSpline) return;
              const editing = editingSplineId === selectedSpline.id;
              setEditingSplineId(editing ? null : selectedSpline.id);
              if (!editing) {
                setViewMode('2d');
                setChannel('terrain');
              }
            }}
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
          {sedimentBudget && (
            <>
              <span>·</span>
              <span
                className="status-budget"
                title={[
                  'Simulation sediment transport (approximate physical volume):',
                  `Eroded: ${sedimentBudget.erodedVolumeM3.toLocaleString('en-US', { maximumFractionDigits: 0 })} m³`,
                  `Deposited: ${sedimentBudget.depositedVolumeM3.toLocaleString('en-US', { maximumFractionDigits: 0 })} m³`,
                  `Boundary export: ${sedimentBudget.exportedVolumeM3.toLocaleString('en-US', { maximumFractionDigits: 0 })} m³`,
                  `Still suspended: ${sedimentBudget.suspendedVolumeM3.toLocaleString('en-US', { maximumFractionDigits: 0 })} m³`,
                  `Balance residual: ${sedimentBudget.balanceErrorM3.toLocaleString('en-US', { maximumFractionDigits: 2 })} m³`,
                ].join('\n')}
              >
                Sediment out {new Intl.NumberFormat('en-US', {
                  notation: 'compact', maximumFractionDigits: 1,
                }).format(sedimentBudget.exportedVolumeM3)} m³
              </span>
            </>
          )}
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
                  <TerrainIcon name={PRESET_ICON_NAMES[p.id] ?? "mountain-range"} height={32} />
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
