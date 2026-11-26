import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TerrainProject } from '../model/types';
import type { WorldDefinition } from '../model/world';
import { validateWorldDefinition } from '../model/world';
import { describeWorldGraph } from '../engine/world/capabilities';
import { validateWorldGrid } from '../engine/world/grid';
import type { WorldCapability, WorldRegionResult } from '../engine/world';
import type { ComputeCapability } from '../engine/gpu/pointwise';
import type { WorldRegionStoreStats } from '../engine/worldStore';
import { WorldPreviewClient } from '../engine/worldPreviewClient';
import { createWorldPreviewGrid, worldEvaluationSignature } from '../engine/worldPreviewPlan';
import type { WorldGridRequest, WorldPreviewProgress } from './worldProtocol';

export {
  createWorldPreviewGrid,
  isWorldOverview,
  worldEvaluationSignature,
} from '../engine/worldPreviewPlan';
export type { WorldPreviewQuality, WorldPreviewRegion } from '../engine/worldPreviewPlan';

export interface WorldPreviewJob extends WorldPreviewProgress {
  id: number;
  revision: string;
  status: 'running' | 'complete' | 'cancelled' | 'error';
  startedAt: number;
  finishedAt?: number;
  elapsedMs: number;
  cacheHit?: boolean;
  cacheSource?: 'memory' | 'persistent';
  preparedReused?: boolean;
}

export interface WorldEngineOptions {
  enabled?: boolean;
  /** First entry builds once; expensive edits can then remain manual. */
  automatic?: boolean;
  cache?: boolean;
  debounceMs?: number;
  previewNodeId?: string;
}

interface State {
  result: WorldRegionResult | null;
  builtWorld: WorldDefinition | null;
  builtProject: TerrainProject | null;
  builtGrid: WorldGridRequest | null;
  builtPreviewNodeId?: string;
  completedSignature: string;
  job: WorldPreviewJob | null;
  /** Provenance of the retained field, independent of a later failed/cancelled attempt. */
  completedJob: WorldPreviewJob | null;
  error: string | null;
  compute?: ComputeCapability;
  warnings: string[];
  cacheHit: boolean;
  storeStats?: WorldRegionStoreStats;
}

export function createWorldWorker() {
  return new Worker(new URL('../engine/world.worker.ts', import.meta.url), { type: 'module' });
}

function preflight(project: TerrainProject, world: WorldDefinition, previewNodeId?: string) {
  let capability: WorldCapability | null = null;
  let error = validateWorldDefinition(world);
  if (!error) {
    try {
      capability = describeWorldGraph(project, world, previewNodeId).capability;
      if (!capability.supported)
        error = capability.reason ?? 'This graph cannot be built as a World.';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'The World graph needs attention.';
    }
  }
  return { capability, error };
}

/** World fields remain visible while replacement work runs. Every publication
 * must match the current semantic graph, domain, and inspected output target. */
export function useWorldEngine(
  project: TerrainProject,
  world: WorldDefinition,
  options: WorldEngineOptions = {},
) {
  const {
    enabled = true,
    automatic = true,
    cache = false,
    debounceMs = 280,
    previewNodeId,
  } = options;
  const signature = useMemo(
    () => worldEvaluationSignature(project, world, previewNodeId),
    [project, world, previewNodeId],
  );
  const validation = useMemo(
    () => preflight(project, world, previewNodeId),
    [project, world, previewNodeId],
  );
  const latest = useRef({ project, world, signature, enabled, cache, previewNodeId });
  latest.current = { project, world, signature, enabled, cache, previewNodeId };
  const [state, setState] = useState<State>({
    result: null,
    builtWorld: null,
    builtProject: null,
    builtGrid: null,
    completedSignature: '',
    job: null,
    completedJob: null,
    error: null,
    warnings: [],
    cacheHit: false,
  });
  const client = useRef<WorldPreviewClient | null>(null);
  if (!client.current) client.current = new WorldPreviewClient(createWorldWorker);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = useRef(false);
  const startedOnce = useRef(false);
  const previousTarget = useRef(previewNodeId);
  const activeSignature = useRef('');
  const queued = useRef<{ grid: WorldGridRequest; signature: string } | null>(null);
  const buildRef = useRef<(grid?: WorldGridRequest) => void>(() => {});

  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const drain = useCallback(() => {
    const pending = queued.current;
    queued.current = null;
    if (!pending || !latest.current.enabled || pending.signature !== latest.current.signature)
      return;
    clearTimer();
    timer.current = setTimeout(() => {
      timer.current = null;
      if (mounted.current && pending.signature === latest.current.signature)
        buildRef.current(pending.grid);
    }, 0);
  }, [clearTimer]);

  const build = useCallback(
    (requestedGrid?: WorldGridRequest) => {
      clearTimer();
      queued.current = null;
      const current = latest.current;
      if (!current.enabled) return;
      const startedAt = performance.now();
      let snapshot: TerrainProject;
      let snapshotWorld: WorldDefinition;
      let grid: WorldGridRequest;
      try {
        const validation = preflight(current.project, current.world, current.previewNodeId);
        if (validation.error) throw new Error(validation.error);
        snapshot = structuredClone(current.project);
        snapshotWorld = structuredClone(current.world);
        grid = requestedGrid ? { ...requestedGrid } : createWorldPreviewGrid(snapshotWorld);
        validateWorldGrid(snapshotWorld.domain, grid);
      } catch (cause) {
        client.current!.cancel();
        busy.current = false;
        const message =
          cause instanceof Error ? cause.message : 'These World settings cannot be built.';
        setState((previous) => ({
          ...previous,
          error: message,
          job: {
            id: previous.job?.id ?? 0,
            revision: current.signature,
            status: 'error',
            phase: 'preparing',
            stage: 'Settings need attention',
            progress: null,
            startedAt,
            finishedAt: performance.now(),
            elapsedMs: performance.now() - startedAt,
          },
        }));
        return;
      }
      const revision = current.signature;
      const target = current.previewNodeId;
      activeSignature.current = revision;
      startedOnce.current = true;
      const publishable = () =>
        mounted.current && latest.current.enabled && latest.current.signature === revision;
      client.current!.preview(
        {
          project: snapshot,
          world: snapshotWorld,
          grid,
          cache: current.cache,
          previewNodeId: target,
        },
        {
          start: (id) => {
            busy.current = true;
            setState((previous) => ({
              ...previous,
              error: null,
              job: {
                id,
                revision,
                status: 'running',
                phase: 'preparing',
                stage: 'Preparing world preview',
                progress: null,
                startedAt,
                elapsedMs: 0,
              },
            }));
          },
          progress: (detail) => {
            if (!publishable()) return;
            const label = detail.nodeId
              ? latest.current.project.graph.nodes.find((node) => node.id === detail.nodeId)?.label
              : undefined;
            setState((previous) => ({
              ...previous,
              job: previous.job && {
                ...previous.job,
                ...detail,
                stage: label ?? detail.stage,
                elapsedMs: performance.now() - startedAt,
              },
            }));
          },
          result: (message) => {
            if (!publishable()) return;
            busy.current = false;
            const finishedAt = performance.now();
            // Metadata can change without invalidating numerical work.
            const labels = new Map(
              latest.current.project.graph.nodes.map((node) => [node.id, node.label]),
            );
            const result = {
              ...message.result,
              stages: message.result.stages.map((stage) => ({
                ...stage,
                label: labels.get(stage.nodeId) ?? stage.label,
              })),
            };
            const completedJob: WorldPreviewJob = {
              id: message.id,
              revision,
              status: 'complete',
              phase: 'sampling',
              progress: 1,
              stage: message.cacheHit ? 'Preview restored' : 'World preview ready',
              startedAt,
              finishedAt,
              elapsedMs: finishedAt - startedAt,
              cacheHit: message.cacheHit,
              cacheSource: message.cacheSource,
              preparedReused: message.preparedReused,
            };
            setState((previous) => ({
              ...previous,
              result,
              builtWorld: snapshotWorld,
              builtProject: snapshot,
              builtGrid: grid,
              builtPreviewNodeId: target,
              completedSignature: revision,
              error: null,
              compute: message.compute,
              warnings: message.warnings ?? [],
              cacheHit: message.cacheHit,
              storeStats: message.store,
              job: completedJob,
              completedJob,
            }));
            drain();
          },
          error: (message) => {
            if (!publishable()) return;
            busy.current = false;
            const finishedAt = performance.now();
            setState((previous) => ({
              ...previous,
              error: message,
              job: previous.job && {
                ...previous.job,
                status: 'error',
                stage: 'Preview needs attention',
                finishedAt,
                elapsedMs: finishedAt - startedAt,
              },
            }));
            drain();
          },
        },
      );
    },
    [clearTimer, drain],
  );
  buildRef.current = build;

  const cancel = useCallback(() => {
    clearTimer();
    queued.current = null;
    client.current!.cancel();
    busy.current = false;
    const finishedAt = performance.now();
    setState((previous) => ({
      ...previous,
      job:
        previous.job?.status === 'running'
          ? {
              ...previous.job,
              status: 'cancelled',
              stage: 'Preview cancelled',
              finishedAt,
              elapsedMs: finishedAt - previous.job.startedAt,
            }
          : previous.job,
    }));
  }, [clearTimer]);

  /** Camera requests coalesce while navigating. A running world preparation is
   * allowed to finish; only the latest visible region is sampled next. */
  const schedule = useCallback(
    (grid: WorldGridRequest, delayMs = 180) => {
      clearTimer();
      queued.current = null;
      if (!latest.current.enabled) return;
      const revision = latest.current.signature;
      timer.current = setTimeout(
        () => {
          timer.current = null;
          if (!mounted.current || revision !== latest.current.signature) return;
          if (busy.current) queued.current = { grid: { ...grid }, signature: revision };
          else buildRef.current(grid);
        },
        Math.max(0, delayMs),
      );
    },
    [clearTimer],
  );

  const invalidateCache = useCallback(() => {
    cancel();
    client.current!.clearCache();
  }, [cancel]);

  useEffect(() => {
    clearTimer();
    queued.current = null;
    const targetChanged = previousTarget.current !== previewNodeId;
    previousTarget.current = previewNodeId;
    if (!enabled || (busy.current && activeSignature.current !== signature)) cancel();
    if (!enabled || (!automatic && startedOnce.current && !targetChanged)) return;
    timer.current = setTimeout(build, Math.max(0, debounceMs));
    return clearTimer;
  }, [signature, enabled, automatic, debounceMs, previewNodeId, build, cancel, clearTimer]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimer();
      queued.current = null;
      client.current?.dispose();
    };
  }, [clearTimer]);

  const presentedResult = useMemo(() => {
    if (!state.result) return null;
    const labels = new Map(project.graph.nodes.map((node) => [node.id, node.label]));
    if (
      !state.result.stages.some(
        (stage) => labels.has(stage.nodeId) && labels.get(stage.nodeId) !== stage.label,
      )
    )
      return state.result;
    return {
      ...state.result,
      stages: state.result.stages.map((stage) => ({
        ...stage,
        label: labels.get(stage.nodeId) ?? stage.label,
      })),
    };
  }, [state.result, project]);

  return {
    ...state,
    result: presentedResult,
    capability: validation.capability,
    validationError: validation.error,
    signature,
    stale: state.completedSignature !== signature,
    busy: state.job?.status === 'running',
    progress: state.job?.progress ?? 0,
    stage: state.job?.stage ?? 'Ready to explore',
    build,
    schedule,
    cancel,
    invalidateCache,
  };
}
