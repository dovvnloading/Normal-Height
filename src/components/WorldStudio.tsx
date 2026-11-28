import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  Bookmark,
  BookmarkPlus,
  Check,
  ChevronRight,
  Compass,
  Download,
  Focus,
  GitBranch,
  Globe2,
  HelpCircle,
  Layers3,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  Play,
  RotateCcw,
  Save,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import type { TerrainProject } from '../model/types';
import type { WorldDefinition } from '../model/world';
import { createWorldDefinition, validateWorldDefinition } from '../model/world';
import { BUILD_INFO } from '../model/buildInfo';
import { downloadBlob, slug } from '../model/project';
import { describeWorldGraph } from '../engine/world/capabilities';
import type { WorldRegionStoreStats } from '../engine/worldStore';
import { createWorldPreviewGrid, isWorldOverview, useWorldEngine } from '../hooks/useWorldEngine';
import {
  loadWorldBookmarks,
  loadWorldViewSettings,
  saveWorldBookmarks,
  saveWorldViewSettings,
  WORLD_VIEW_KEY,
  worldBookmarkScope,
  worldDomainKey,
} from '../model/worldViewSettings';
import type {
  WorldBookmark,
  WorldViewSettings,
  WorldWorkspaceMode,
} from '../model/worldViewSettings';
import { WorldViewport } from './world/WorldViewport';
import type { WorldLayer, WorldProbe, WorldRegion, WorldSnapshot } from './world/worldViewMath';
import {
  WORLD_LAYERS,
  canCompareWorldSnapshots,
  isGenesisLayer,
  worldGridBounds,
} from './world/worldViewMath';
import { snapshotContainsRegion } from './world/worldAnalysis';
import { WorldAnalysisPanel, WorldComparisonControls } from './world/WorldAnalysisPanel';
import { WorldSetupPanel } from './world/WorldSetupPanel';
import { WorldSimulationPanel } from './world/WorldSimulationPanel';
import { WorldExportPanel } from './world/WorldExportPanel';
import type { WorldExportActivity } from './world/WorldExportPanel';
import {
  WorldDisclosure,
  WorldMetric,
  WorldNotice,
  WorldPanelHeading,
  WorldSection,
  worldDistance,
  worldNumber,
} from './world/WorldControls';
import './WorldStudio.css';

const modes = [
  { id: 'explore', label: 'Explore', icon: Compass },
  { id: 'setup', label: 'Setup', icon: Globe2 },
  { id: 'simulate', label: 'Simulate', icon: SlidersHorizontal },
  { id: 'analyze', label: 'Analyze', icon: Activity },
  { id: 'deliver', label: 'Deliver', icon: Download },
] as const;
const isEditing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.matches('input,textarea,select') || target.isContentEditable);

export interface WorldStudioProps {
  project: TerrainProject;
  onSave(world: WorldDefinition, group?: string): boolean;
  onClose(): void;
  active?: boolean;
  graphEditor?: ReactNode;
  graphInspector?: ReactNode;
  previewNodeId?: string;
  onReturnOutput?(): void;
  onSelectNode?(id: string): void;
  deliverRequest?: number;
  onExportActivity?(activity: WorldExportActivity | null): void;
}

/** A persistent authoring workspace. Preview work can pause while hidden;
 * delivery owns a separate immutable job and survives workspace navigation. */
export function WorldStudio({
  project,
  onSave,
  onClose,
  active = true,
  graphEditor,
  graphInspector,
  previewNodeId,
  onReturnOutput,
  onSelectNode,
  deliverRequest = 0,
  onExportActivity,
}: WorldStudioProps) {
  const [world, setWorld] = useState<WorldDefinition>(() =>
    structuredClone(project.world ?? createWorldDefinition(project)),
  );
  const [view, setView] = useState<WorldViewSettings>(() => {
    const loaded = loadWorldViewSettings();
    try {
      if (!localStorage.getItem(WORLD_VIEW_KEY))
        loaded.automatic = describeWorldGraph(project, world).capability.native;
    } catch {
      /* A malformed graph is explained by the preview preflight. */
    }
    return loaded;
  });
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth >= 1000);
  const [graphOpen, setGraphOpen] = useState(false);
  const [graphHeight, setGraphHeight] = useState(280);
  const [guideOpen, setGuideOpen] = useState(false);
  const [region, setRegion] = useState<WorldRegion | null>(null);
  const [frameRequest, setFrameRequest] = useState(0);
  const [autoDetail, setAutoDetail] = useState(true);
  const [regionRequest, setRegionRequest] = useState(0);
  const [railHorizontal, setRailHorizontal] = useState(() => window.innerWidth <= 480);
  const [overview, setOverview] = useState<(WorldSnapshot & { revision: string }) | null>(null);
  const [pinned, setPinned] = useState<WorldSnapshot | null>(null);
  const [compareMode, setCompareMode] = useState<'off' | 'wipe' | 'difference'>('off');
  const [probe, setProbe] = useState<WorldProbe | null>(null);
  const [activity, setActivity] = useState<WorldExportActivity | null>(null);
  const [notice, setNotice] = useState('');
  const [saveError, setSaveError] = useState('');
  const [clearing, setClearing] = useState(false);
  const [clearedStats, setClearedStats] = useState<WorldRegionStoreStats | null>(null);
  const [bookmarkName, setBookmarkName] = useState('');
  const [bookmarks, setBookmarks] = useState<WorldBookmark[]>(() =>
    loadWorldBookmarks(worldBookmarkScope(project)),
  );
  const [now, setNow] = useState(() => performance.now());
  const shell = useRef<HTMLElement>(null);
  const alive = useRef(true);
  const authored = JSON.stringify(project.world);
  // Legacy projects derive their World domain from the Terrain dimensions.
  // Undo between two legacy presets must restore that domain as well as the graph.
  const authoredSync = authored ?? JSON.stringify([project.worldSize, project.heightScale]);
  const previousAuthored = useRef(authoredSync);
  const bookmarkScope = worldBookmarkScope(project);
  const domainKey = worldDomainKey(world);
  const previousDomain = useRef(domainKey);
  const engine = useWorldEngine(project, world, {
    enabled: active,
    automatic: view.automatic,
    cache: view.cache,
    previewNodeId,
  });
  const dirty = JSON.stringify(world) !== authored;
  const canPin = !!engine.result && !engine.stale && !engine.busy;
  const builtLabel =
    project.graph.nodes.find((n) => n.id === engine.builtPreviewNodeId)?.label ?? 'Terrain output';
  const snapshot = useMemo<WorldSnapshot | null>(
    () =>
      engine.result && engine.builtWorld && engine.builtGrid
        ? {
            result: engine.result,
            world: engine.builtWorld,
            grid: engine.builtGrid,
            label: builtLabel,
          }
        : null,
    [engine.result, engine.builtWorld, engine.builtGrid, engine.builtPreviewNodeId, builtLabel],
  );
  const matchingOverview = overview?.revision === engine.completedSignature ? overview : null;
  const geometryMatches = !engine.builtWorld || worldDomainKey(engine.builtWorld) === domainKey;
  const analysisSnapshot =
    region && snapshot && !snapshotContainsRegion(snapshot, region) ? matchingOverview : snapshot;
  const stageLabel = previewNodeId
    ? project.graph.nodes.find((n) => n.id === previewNodeId)?.label
    : undefined;
  const visibleBookmarks = bookmarks.filter((bookmark) => bookmark.domain === domainKey);
  const otherBookmarks = bookmarks.filter((bookmark) => bookmark.domain !== domainKey);
  const selectedBounds = region ? worldGridBounds(world, region) : null;
  const previewReady =
    snapshot && isWorldOverview(snapshot.world, snapshot.grid)
      ? 'World overview ready'
      : 'Region preview ready';
  const status = engine.validationError
    ? 'Settings need attention'
    : engine.error
      ? 'Preview needs attention'
      : engine.busy
        ? engine.stage
        : engine.stale && snapshot
          ? 'Changes ready to build'
          : engine.job?.status === 'cancelled'
            ? snapshot
              ? 'Preview cancelled · last complete terrain retained'
              : 'Preview cancelled'
            : snapshot
              ? previewReady
              : 'Preparing world overview';
  const elapsed = engine.job
    ? engine.busy
      ? now - engine.job.startedAt
      : engine.job.elapsedMs
    : 0;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    saveWorldViewSettings(view);
  }, [view]);
  useEffect(() => {
    onExportActivity?.(activity);
  }, [activity, onExportActivity]);
  useEffect(() => {
    if (active) shell.current?.focus({ preventScroll: true });
  }, [active]);
  useEffect(() => {
    setProbe(null);
  }, [engine.result]);
  useEffect(() => {
    if (compareMode !== 'off')
      setView((previous) =>
        previous.presentation === 'terrain' ? { ...previous, presentation: 'split' } : previous,
      );
  }, [compareMode, view.presentation]);
  useEffect(() => {
    setBookmarks(loadWorldBookmarks(bookmarkScope));
  }, [bookmarkScope]);
  useEffect(() => {
    if (previousAuthored.current === authoredSync) return;
    previousAuthored.current = authoredSync;
    setWorld(structuredClone(project.world ?? createWorldDefinition(project)));
    setSaveError('');
  }, [authoredSync, project]);
  useEffect(() => {
    if (previousDomain.current === domainKey) return;
    previousDomain.current = domainKey;
    setRegion(null);
    setProbe(null);
  }, [domainKey]);
  useEffect(() => {
    // Keep a probe when the pointer leaves the map to inspect the sidebar, but
    // never show measurements from an older field as part of a completed build.
    setProbe(null);
  }, [engine.result]);
  useEffect(() => {
    if (snapshot && isWorldOverview(snapshot.world, snapshot.grid))
      setOverview({ ...snapshot, revision: engine.completedSignature });
  }, [snapshot, engine.completedSignature]);
  useEffect(() => {
    setClearedStats(null);
  }, [engine.completedJob]);
  useEffect(() => {
    if (!engine.busy || !active) return;
    setNow(performance.now());
    const timer = window.setInterval(() => setNow(performance.now()), 250);
    return () => window.clearInterval(timer);
  }, [engine.busy, active]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const compact = window.matchMedia('(max-width: 999px)');
    const rail = window.matchMedia('(max-width: 480px)');
    const updateRail = () => setRailHorizontal(rail.matches);
    rail.addEventListener('change', updateRail);
    const change = () => {
      if (compact.matches) setPanelOpen(false);
    };
    compact.addEventListener('change', change);
    return () => {
      compact.removeEventListener('change', change);
      rail.removeEventListener('change', updateRail);
    };
  }, []);
  const lastDeliverRequest = useRef(deliverRequest);
  useEffect(() => {
    if (deliverRequest === lastDeliverRequest.current) return;
    lastDeliverRequest.current = deliverRequest;
    setView((previous) => ({ ...previous, mode: 'deliver' }));
    setPanelOpen(true);
  }, [deliverRequest]);

  const setMode = (mode: WorldWorkspaceMode) => {
    setView((previous) => ({ ...previous, mode }));
    setPanelOpen(true);
  };
  const setLayer = (layer: WorldLayer) => setView((previous) => ({ ...previous, layer }));
  const changeWorld = (next: WorldDefinition, group = 'world-settings') => {
    setWorld(next);
    setSaveError('');
    const invalid = validateWorldDefinition(next);
    if (invalid) return;
    if (!onSave(next, group))
      setSaveError(
        'These settings could not be saved to the project. Your draft is retained; free project space, then save settings again.',
      );
  };
  const pinCurrent = () => {
    if (!canPin || !snapshot) return;
    setPinned({ ...snapshot, label: `Build ${engine.completedJob?.id ?? 1} · ${snapshot.label}` });
    setCompareMode('off');
    setNotice('Terrain pinned. Change settings and build to compare the result.');
  };
  const refine = () => {
    if (!region || engine.validationError || engine.stale) return;
    engine.build(createWorldPreviewGrid(world, region, 'detail'));
    setFrameRequest((value) => value + 1);
  };
  const showOverview = () => {
    setRegion(null);
    engine.build(createWorldPreviewGrid(world));
  };
  const navigateRegion = useCallback(
    (visible: WorldRegion | null) => {
      if (!active || !autoDetail || engine.stale || compareMode !== 'off') return;
      engine.schedule(createWorldPreviewGrid(world, visible, visible ? 'detail' : 'draft'), 180);
    },
    [active, autoDetail, engine.stale, engine.schedule, compareMode, world],
  );
  const clearCache = async () => {
    if (clearing) return;
    setClearing(true);
    engine.invalidateCache();
    try {
      const { createWorldRegionStore } = await import('../engine/worldStore');
      const cache = await createWorldRegionStore();
      try {
        await cache.clear();
        if (!alive.current) return;
        const stats = cache.stats();
        setClearedStats(stats);
        setNotice(
          stats.lastError
            ? `Memory regions released. Stored cache could not be cleared: ${stats.lastError}`
            : 'Stored world regions cleared. Authored projects are preserved.',
        );
      } finally {
        await cache.close();
      }
    } catch (error) {
      if (alive.current)
        setNotice(error instanceof Error ? error.message : 'Could not clear stored regions.');
    } finally {
      if (alive.current) setClearing(false);
    }
  };
  const writeBookmarks = (next: WorldBookmark[]) => {
    setBookmarks(next);
    if (!saveWorldBookmarks(bookmarkScope, next))
      setNotice('Bookmark kept for this session. This browser could not save it locally.');
  };
  const addBookmark = () => {
    if (!region || !bookmarkName.trim()) return;
    if (bookmarks.length >= 20) {
      setNotice('The project has 20 bookmarks. Remove one to save another.');
      return;
    }
    writeBookmarks([
      ...bookmarks,
      {
        id: crypto.randomUUID(),
        name: bookmarkName.trim().slice(0, 60),
        region: { ...region },
        domain: domainKey,
      },
    ]);
    setBookmarkName('');
    setNotice('Region bookmarked in this browser.');
  };
  const report = () => {
    if (!snapshot) return;
    try {
      downloadBlob(
        new Blob(
          [
            JSON.stringify(
              {
                version: 1,
                application: 'Normal Height World Engine',
                build: BUILD_INFO,
                projectName: engine.builtProject?.name ?? project.name,
                world: snapshot.world,
                grid: snapshot.grid,
                backend: snapshot.result.backend,
                stages: snapshot.result.stages,
                transportBudget: snapshot.result.transportBudget,
                genesis: snapshot.result.genesis?.report,
                warnings: engine.warnings,
                compute: engine.compute,
                samplingDurationMs: snapshot.result.duration,
                totalPreviewDurationMs: engine.completedJob?.elapsedMs,
                cacheSource: engine.completedJob?.cacheSource ?? null,
                estimatedPeakBytes: snapshot.result.estimatedPeakBytes,
                stale: engine.stale,
              },
              null,
              2,
            ),
          ],
          { type: 'application/json' },
        ),
        `${slug(project.name)}-world-report.json`,
      );
      setNotice('Stage report download initiated.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not download the stage report.');
    }
  };
  const resizePanel = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX,
      width = view.panelWidth;
    handle.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) =>
      setView((previous) => ({
        ...previous,
        panelWidth: Math.max(272, Math.min(420, width + next.clientX - startX)),
      }));
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  };
  const resizeGraph = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget,
      startY = event.clientY,
      height = graphHeight;
    handle.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) =>
      setGraphHeight(
        Math.max(
          180,
          Math.min((shell.current?.clientHeight ?? 900) * 0.6, height + startY - next.clientY),
        ),
      );
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  };

  return (
    <section
      ref={shell}
      tabIndex={-1}
      className={`we-shell ${panelOpen ? 'is-panel-open' : ''} ${graphOpen ? 'is-graph-open' : ''}`}
      aria-label="World Studio"
      style={
        {
          '--we-panel-width': `${view.panelWidth}px`,
          '--we-graph-height': `${graphHeight}px`,
        } as CSSProperties
      }
      onKeyDown={(event) => {
        if (event.defaultPrevented || isEditing(event.target)) return;
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          engine.busy ? engine.cancel() : engine.build();
        }
        if (event.key.toLowerCase() === 'g' && !event.ctrlKey && !event.metaKey) {
          event.preventDefault();
          setGraphOpen((value) => !value);
        }
        if (event.altKey && /^[1-5]$/.test(event.key)) {
          event.preventDefault();
          setMode(modes[Number(event.key) - 1].id);
        }
        if (event.key === '?') {
          event.preventDefault();
          setGuideOpen((value) => !value);
        }
      }}
    >
      <header className="we-topbar">
        <div className="we-identity">
          <button
            type="button"
            className="we-icon-button"
            aria-label="Close World Studio"
            title="Return to Terrain workspace"
            onClick={onClose}
          >
            <ArrowLeft size={17} />
          </button>
          <span className="we-world-mark">
            <Globe2 size={22} strokeWidth={1.4} />
          </span>
          <div>
            <h1>World Engine</h1>
            <p>
              {worldDistance(world.domain.width)} × {worldDistance(world.domain.depth)}
              <span>·</span>
              {project.name}
            </p>
          </div>
        </div>
        <div className="we-top-actions">
          {dirty ? (
            <button
              type="button"
              className="we-button we-save-world"
              disabled={!!validateWorldDefinition(world)}
              onClick={() => changeWorld(world, 'world-enable')}
            >
              <Save size={13} />
              {project.world ? 'Save settings' : 'Enable world in project'}
            </button>
          ) : (
            <span className="we-saved">
              <Check size={13} />
              Project linked
            </span>
          )}
          {graphEditor && (
            <button
              type="button"
              className="we-button"
              aria-pressed={graphOpen}
              onClick={() => setGraphOpen(!graphOpen)}
              title="Open graph · G"
            >
              <GitBranch size={14} />
              <span>Graph</span>
              <kbd>G</kbd>
            </button>
          )}
          <button
            type="button"
            className="we-icon-button"
            aria-label="World navigation guide"
            aria-expanded={guideOpen}
            onClick={() => setGuideOpen(!guideOpen)}
          >
            <HelpCircle size={17} />
          </button>
        </div>
      </header>
      <div className="we-workspace">
        <nav className="we-mode-rail" aria-label="World workflow">
          <div
            role="tablist"
            aria-label="World workspace modes"
            aria-orientation={railHorizontal ? 'horizontal' : 'vertical'}
          >
            {modes.map(({ id, label, icon: Icon }, index) => (
              <button
                type="button"
                role="tab"
                id={`we-tab-${id}`}
                key={id}
                tabIndex={view.mode === id ? 0 : -1}
                onKeyDown={(event) => {
                  let next = index;
                  if (event.key === 'ArrowDown' || event.key === 'ArrowRight')
                    next = (index + 1) % modes.length;
                  else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft')
                    next = (index + modes.length - 1) % modes.length;
                  else if (event.key === 'Home') next = 0;
                  else if (event.key === 'End') next = modes.length - 1;
                  else return;
                  event.preventDefault();
                  setMode(modes[next].id);
                  document.getElementById(`we-tab-${modes[next].id}`)?.focus();
                }}
                aria-selected={view.mode === id}
                aria-controls={`we-panel-${id}`}
                title={`${label} · Alt ${index + 1}`}
                onClick={() => setMode(id)}
              >
                <Icon size={19} strokeWidth={1.6} />
                <span>{label}</span>
                {id === 'deliver' && activity?.busy && <i className="we-job-dot" />}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="we-collapse-panel"
            aria-label={panelOpen ? 'Hide world controls' : 'Show world controls'}
            aria-expanded={panelOpen}
            onClick={() => setPanelOpen(!panelOpen)}
          >
            {panelOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
          </button>
        </nav>
        {panelOpen && (
          <button
            className="we-panel-scrim"
            type="button"
            aria-label="Close world controls"
            onClick={() => setPanelOpen(false)}
          />
        )}
        <aside className="we-context" aria-label="World controls" hidden={!panelOpen}>
          <div className="we-context-mobile">
            <strong>{modes.find((mode) => mode.id === view.mode)?.label}</strong>
            <button
              type="button"
              className="we-icon-button"
              aria-label="Close controls panel"
              onClick={() => setPanelOpen(false)}
            >
              <X size={16} />
            </button>
          </div>
          <div
            role="tabpanel"
            id="we-panel-explore"
            aria-labelledby="we-tab-explore"
            hidden={view.mode !== 'explore'}
          >
            <WorldPanelHeading eyebrow="EXPLORE" title="A world worth getting lost in.">
              Inspect the whole landscape, then move closer. Everything stays in place.
            </WorldPanelHeading>
            <WorldSection title="At a glance">
              <div className="we-world-summary">
                <Globe2 size={42} strokeWidth={0.85} />
                <div>
                  <strong>
                    {worldDistance(world.domain.width)} × {worldDistance(world.domain.depth)}
                  </strong>
                  <span>
                    {worldNumber((world.domain.width * world.domain.depth) / 1e6, 2)} km² ·{' '}
                    {Math.ceil(world.domain.cellsX / world.tileCells) *
                      Math.ceil(world.domain.cellsZ / world.tileCells)}{' '}
                    tiles
                  </span>
                </div>
              </div>
              <p className="we-hint">
                {engine.capability?.native
                  ? 'Native world coordinates. Ready for automatic previews.'
                  : 'Global stages share one whole-domain simulation.'}
              </p>
            </WorldSection>
            <WorldSection title="Terrain layers">
              <div className="we-layer-list">
                {WORLD_LAYERS.map((layer) => (
                  <button
                    type="button"
                    key={layer.id}
                    aria-label={layer.label}
                    aria-pressed={view.layer === layer.id}
                    disabled={isGenesisLayer(layer.id) && !snapshot?.result.genesis}
                    onClick={() => setLayer(layer.id)}
                    title={
                      isGenesisLayer(layer.id) && !snapshot?.result.genesis
                        ? 'Enable World Genesis in Simulate and build to inspect this layer.'
                        : layer.description
                    }
                  >
                    <i className={`we-layer-swatch layer-${layer.id}`} />
                    <span>
                      <strong>{layer.label}</strong>
                      <small>{layer.description}</small>
                    </span>
                    {view.layer === layer.id && <Check size={14} />}
                  </button>
                ))}
              </div>
            </WorldSection>
            <WorldSection title="Selected region">
              {region && selectedBounds ? (
                <>
                  <div className="we-metrics">
                    <WorldMetric label="Width" value={worldDistance(selectedBounds.width)} />
                    <WorldMetric label="Depth" value={worldDistance(selectedBounds.depth)} />
                  </div>
                  <p className="we-hint">
                    Cells {region.startX}–{region.startX + region.cellsX} east · {region.startZ}–
                    {region.startZ + region.cellsZ} south
                  </p>
                  <div className="we-two">
                    <button
                      type="button"
                      className="we-button is-primary"
                      onClick={refine}
                      disabled={engine.busy || engine.stale || !!engine.validationError}
                    >
                      <Focus size={14} />
                      Refine region
                    </button>
                    <button
                      type="button"
                      className="we-button"
                      onClick={() => {
                        setRegionRequest((value) => value + 1);
                        setMode('deliver');
                      }}
                    >
                      <Download size={14} />
                      Deliver
                    </button>
                  </div>
                </>
              ) : (
                <div className="we-empty-inline">
                  <Focus size={23} />
                  <p>
                    Click a tile or drag across the map to select a region. Refine it without losing
                    the overview.
                  </p>
                </div>
              )}
            </WorldSection>
            <WorldSection title="Region bookmarks">
              <div className="we-bookmarks">
                {visibleBookmarks.map((bookmark) => (
                  <div key={bookmark.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setRegion(bookmark.region);
                        setFrameRequest((value) => value + 1);
                        if (window.innerWidth < 1000) setPanelOpen(false);
                      }}
                    >
                      <Bookmark size={14} />
                      <span>{bookmark.name}</span>
                      <ArrowUpRight size={13} />
                    </button>
                    <button
                      type="button"
                      className="we-icon-button"
                      aria-label={`Delete bookmark ${bookmark.name}`}
                      onClick={() =>
                        writeBookmarks(bookmarks.filter((item) => item.id !== bookmark.id))
                      }
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
              {!visibleBookmarks.length && (
                <p className="we-hint">
                  Save a region to return to it instantly. Bookmarks stay in this browser.
                </p>
              )}
              <form
                className="we-bookmark-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  addBookmark();
                }}
              >
                <input
                  aria-label="Bookmark name"
                  placeholder={region ? 'Name this region…' : 'Select a region to bookmark'}
                  value={bookmarkName}
                  maxLength={60}
                  disabled={!region}
                  onChange={(event) => setBookmarkName(event.target.value)}
                />
                <button
                  type="submit"
                  className="we-icon-button"
                  aria-label="Save region bookmark"
                  disabled={!region || !bookmarkName.trim()}
                >
                  <BookmarkPlus size={17} />
                </button>
              </form>
              {otherBookmarks.length > 0 && (
                <WorldDisclosure title={`Other world layouts · ${otherBookmarks.length}`}>
                  <p className="we-hint">
                    These regions belong to a different domain. Restore that domain to revisit them,
                    or remove a bookmark here.
                  </p>
                  <div className="we-bookmarks">
                    {otherBookmarks.map((bookmark) => (
                      <div key={bookmark.id}>
                        <span>{bookmark.name}</span>
                        <button
                          type="button"
                          className="we-icon-button"
                          aria-label={`Delete previous-layout bookmark ${bookmark.name}`}
                          onClick={() =>
                            writeBookmarks(bookmarks.filter((item) => item.id !== bookmark.id))
                          }
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                </WorldDisclosure>
              )}
            </WorldSection>
            <WorldDisclosure title="Preview behaviour">
              <label className="we-toggle-card">
                <span>
                  <strong>Refine as you explore</strong>
                  <small>Sample a bounded region after zooming</small>
                </span>
                <input
                  aria-label="Automatic regional refinement"
                  type="checkbox"
                  checked={autoDetail}
                  onChange={(event) => setAutoDetail(event.target.checked)}
                />
              </label>
              <p className="we-hint">
                Prepared global stages are reused. Panning and zooming stay responsive while detail
                arrives. Comparison mode holds its current footprint.
              </p>
            </WorldDisclosure>
          </div>
          <div
            role="tabpanel"
            id="we-panel-setup"
            aria-labelledby="we-tab-setup"
            hidden={view.mode !== 'setup'}
          >
            <WorldSetupPanel
              world={world}
              onChange={changeWorld}
              capability={engine.capability}
              error={validateWorldDefinition(world) ?? saveError}
              onOpenGraph={() => setGraphOpen(true)}
            />
          </div>
          <div
            role="tabpanel"
            id="we-panel-simulate"
            aria-labelledby="we-tab-simulate"
            hidden={view.mode !== 'simulate'}
          >
            <WorldSimulationPanel
              world={world}
              onChange={changeWorld}
              result={engine.result}
              compute={engine.compute ?? null}
              cacheEnabled={view.cache}
              onCacheChange={(cache) => setView((previous) => ({ ...previous, cache }))}
              storeStats={clearedStats ?? engine.storeStats ?? null}
              cacheHit={engine.cacheHit && !clearedStats}
              onClearCache={() => void clearCache()}
              onBuild={() => engine.build()}
              onPin={pinCurrent}
              canPin={canPin}
              busy={engine.busy || clearing}
              stale={engine.stale}
              error={engine.validationError}
            />
            <WorldComparisonControls
              snapshot={snapshot}
              pinned={pinned}
              onPin={pinCurrent}
              onClear={() => {
                setPinned(null);
                setCompareMode('off');
              }}
              mode={compareMode}
              onModeChange={setCompareMode}
              canPin={canPin}
            />
          </div>
          <div
            role="tabpanel"
            id="we-panel-analyze"
            aria-labelledby="we-tab-analyze"
            hidden={view.mode !== 'analyze'}
          >
            {view.mode === 'analyze' && (
              <WorldAnalysisPanel
                snapshot={analysisSnapshot}
                region={geometryMatches ? region : null}
                probe={probe}
                pinned={pinned}
                onPin={pinCurrent}
                onClear={() => {
                  setPinned(null);
                  setCompareMode('off');
                }}
                compareMode={compareMode}
                onCompareMode={setCompareMode}
                canPin={canPin}
                stale={engine.stale}
                onFocusNode={(id) => {
                  onSelectNode?.(id);
                  setGraphOpen(true);
                }}
                onReport={report}
              />
            )}
          </div>
          <div
            role="tabpanel"
            id="we-panel-deliver"
            aria-labelledby="we-tab-deliver"
            hidden={view.mode !== 'deliver'}
          >
            <WorldExportPanel
              project={project}
              world={world}
              region={region}
              regionRequest={regionRequest}
              onActivity={setActivity}
            />
          </div>
        </aside>
        <div
          className="we-panel-resizer"
          role="separator"
          aria-label="Resize world controls"
          aria-orientation="vertical"
          aria-valuemin={272}
          aria-valuemax={420}
          aria-valuenow={Math.round(view.panelWidth)}
          tabIndex={panelOpen ? 0 : -1}
          onPointerDown={resizePanel}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              setView((previous) => ({
                ...previous,
                panelWidth: Math.max(
                  272,
                  Math.min(420, previous.panelWidth + (event.key === 'ArrowLeft' ? -16 : 16)),
                ),
              }));
            }
          }}
        />
        <main className="we-main" aria-label="World terrain workspace">
          <div className="we-preview-controls">
            <div className="we-output-label">
              <Layers3 size={14} />
              <strong>{stageLabel ?? 'Terrain output'}</strong>
              {stageLabel && (
                <button className="we-text-button" type="button" onClick={onReturnOutput}>
                  Return to output <X size={12} />
                </button>
              )}
              {pinned && (
                <span className="we-pinned-badge" title={pinned.label}>
                  <Pin size={11} />
                  Baseline pinned
                </span>
              )}
            </div>
            <div>
              <label className="we-auto">
                <input
                  type="checkbox"
                  aria-label="Automatic world previews"
                  checked={view.automatic}
                  onChange={(event) =>
                    setView((previous) => ({ ...previous, automatic: event.target.checked }))
                  }
                />
                <span>Auto preview</span>
              </label>
              <button
                type="button"
                className={`we-button ${engine.stale && !engine.busy ? 'is-primary' : ''}`}
                disabled={!engine.busy && !!engine.validationError}
                onClick={engine.busy ? engine.cancel : () => engine.build()}
                title="Build preview · Ctrl/⌘ Enter"
              >
                {engine.busy ? <X size={14} /> : <Play size={13} />}
                {engine.busy ? 'Cancel preview' : 'Build preview'}
              </button>
            </div>
          </div>
          <div className="we-viewport-container">
            <WorldViewport
              materialProject={engine.stale ? engine.builtProject : project}
              result={engine.result}
              world={engine.builtWorld ?? world}
              grid={engine.builtGrid}
              overview={matchingOverview}
              region={geometryMatches ? region : null}
              onRegionChange={(next) => {
                if (geometryMatches) setRegion(next);
              }}
              layer={view.layer}
              onLayerChange={setLayer}
              mode={view.presentation}
              onModeChange={(presentation) =>
                setView((previous) => ({ ...previous, presentation }))
              }
              busy={engine.busy}
              stale={engine.stale}
              onRefine={refine}
              onOverview={showOverview}
              comparison={pinned}
              compareMode={
                pinned && snapshot && canCompareWorldSnapshots(snapshot, pinned)
                  ? compareMode
                  : 'off'
              }
              onProbe={(next) => {
                if (next) setProbe(next);
              }}
              frameRequest={frameRequest}
              active={active}
              onViewRegionChange={navigateRegion}
            />
            {(engine.validationError || engine.error || saveError) && (
              <div className="we-canvas-notice">
                <WorldNotice error>
                  <strong>
                    {engine.validationError
                      ? 'This world needs an adjustment'
                      : saveError
                        ? 'Settings need saving'
                        : 'The preview could not finish'}
                  </strong>
                  <p>{engine.validationError ?? saveError ?? engine.error}</p>
                  <div>
                    <button
                      type="button"
                      className="we-text-button"
                      onClick={() => setMode('setup')}
                    >
                      Review settings <ChevronRight size={13} />
                    </button>
                    {!engine.validationError && (
                      <button
                        type="button"
                        className="we-text-button"
                        onClick={() => engine.build()}
                      >
                        <RotateCcw size={12} />
                        Retry preview
                      </button>
                    )}
                  </div>
                </WorldNotice>
              </div>
            )}
            {guideOpen && (
              <section className="we-guide" aria-label="World navigation guide">
                <div>
                  <h2>Move through your world</h2>
                  <button
                    type="button"
                    className="we-icon-button"
                    aria-label="Close navigation guide"
                    onClick={() => setGuideOpen(false)}
                  >
                    <X size={15} />
                  </button>
                </div>
                <dl>
                  <dt>Zoom at the cursor</dt>
                  <dd>Scroll / pinch</dd>
                  <dt>Pan the map</dt>
                  <dd>Space + drag / middle drag</dd>
                  <dt>Select tiles</dt>
                  <dd>Click / drag · Shift to extend</dd>
                  <dt>Move the selection</dt>
                  <dd>Arrow keys</dd>
                  <dt>Frame selection / world</dt>
                  <dd>
                    <kbd>F</kbd> / <kbd>Home</kbd>
                  </dd>
                  <dt>Refine / clear selection</dt>
                  <dd>
                    <kbd>Enter</kbd> / <kbd>Esc</kbd>
                  </dd>
                  <dt>Toggle graph</dt>
                  <dd>
                    <kbd>G</kbd>
                  </dd>
                  <dt>Build / cancel preview</dt>
                  <dd>
                    <kbd>Ctrl / ⌘ Enter</kbd>
                  </dd>
                </dl>
                <p>
                  In 3D, drag to orbit; right-drag to pan. All measurements use real world units.
                </p>
              </section>
            )}
            {notice && (
              <div className="we-toast" role="status">
                <Check size={14} />
                <span>{notice}</span>
                <button
                  type="button"
                  className="we-icon-button"
                  aria-label="Dismiss world notification"
                  onClick={() => setNotice('')}
                >
                  <X size={13} />
                </button>
              </div>
            )}
          </div>
          {graphOpen && graphEditor && active && (
            <section className="we-graph-dock" aria-label="World graph editor">
              <div
                role="separator"
                className="we-graph-resizer"
                aria-label="Resize world graph"
                aria-orientation="horizontal"
                aria-valuemin={180}
                aria-valuemax={600}
                aria-valuenow={Math.round(graphHeight)}
                tabIndex={0}
                onPointerDown={resizeGraph}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                    event.preventDefault();
                    setGraphHeight((value) =>
                      Math.max(180, Math.min(600, value + (event.key === 'ArrowUp' ? 24 : -24))),
                    );
                  }
                }}
              />
              <header>
                <span>
                  <GitBranch size={13} />
                  Procedural graph
                </span>
                <span>
                  Edits update this world{view.automatic ? ' automatically' : ' on build'}
                </span>
                <button
                  type="button"
                  className="we-icon-button"
                  aria-label="Close world graph"
                  onClick={() => setGraphOpen(false)}
                >
                  <X size={15} />
                </button>
              </header>
              <div className="we-graph-content">
                <div className="we-graph-canvas">{graphEditor}</div>
                {graphInspector && <div className="we-graph-inspector">{graphInspector}</div>}
              </div>
            </section>
          )}
        </main>
      </div>
      <footer className="we-statusbar">
        <div className="we-status-main">
          <span
            className={`we-status-light ${engine.busy ? 'is-busy' : engine.error || engine.validationError ? 'is-error' : engine.stale && snapshot ? 'is-stale' : ''}`}
          />
          {engine.busy && <LoaderCircle size={13} className="spin" />}
          <span role="status" aria-live="polite">
            {status}
          </span>
          {engine.busy && engine.job && (
            <>
              <span className="we-job-phase">{engine.job.phase}</span>
              {engine.job.total !== undefined && (
                <span className="we-status-count">
                  {worldNumber(engine.job.completed ?? 0, 0)} / {worldNumber(engine.job.total, 0)}{' '}
                  {engine.job.unit}
                </span>
              )}
              {engine.job.progress !== null && (
                <progress
                  aria-label={`${engine.job.phase} progress`}
                  max={1}
                  value={engine.job.progress}
                />
              )}
              <span className="we-elapsed">{worldNumber(elapsed / 1000)} s</span>
            </>
          )}
        </div>
        <div className="we-status-secondary">
          {activity?.busy ? (
            <>
              <button type="button" className="we-text-button" onClick={() => setMode('deliver')}>
                <Download size={12} />
                {activity.stage}
              </button>
              <button
                type="button"
                className="we-text-button"
                aria-label="Cancel background world export"
                onClick={activity.cancel}
              >
                Cancel export
              </button>
            </>
          ) : snapshot ? (
            <>
              <span>
                {snapshot.result.width} × {snapshot.result.height} preview
              </span>
              <span>{worldNumber(snapshot.result.spacingX, 2)} m / sample</span>
              <span>
                {worldNumber((engine.completedJob?.elapsedMs ?? 0) / 1000, 2)} s{' '}
                {engine.completedJob?.cacheSource ? 'restore' : 'total'}
              </span>
            </>
          ) : (
            <span>World coordinates · metres</span>
          )}
        </div>
      </footer>
    </section>
  );
}
