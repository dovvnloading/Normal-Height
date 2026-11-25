import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EvaluationResult, TerrainProject } from '../model/types';
import { TerrainComputeClient } from '../engine/compute/client';
import { semanticProjectSignature } from '../engine/plan/graph';

export function evaluationSignature(project: TerrainProject, previewNodeId?: string) {
  return semanticProjectSignature(project, previewNodeId);
}
export function createTerrainWorker() {
  return new Worker(new URL('../engine/terrain.worker.ts', import.meta.url), { type: 'module' });
}
export function useTerrainEngine(
  project: TerrainProject,
  previewNodeId: string | undefined,
  automatic: boolean,
  enabled = true,
) {
  const [result, setResult] = useState<EvaluationResult | null>(null);
  // Preserve the physical parameters of the field currently on screen. Project
  // edits can arrive before its replacement worker finishes (or after Cancel).
  const [completedProject, setCompletedProject] = useState<TerrainProject | null>(null);
  const [completedPreviewNodeId, setCompletedPreviewNodeId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState('Preparing terrain');
  const [error, setError] = useState<string | null>(null);
  const [completedSignature, setCompletedSignature] = useState('');
  const clientRef = useRef<TerrainComputeClient | null>(null);
  if (!clientRef.current) clientRef.current = new TerrainComputeClient(createTerrainWorker);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projectRef = useRef(project);
  projectRef.current = project;
  const previewRef = useRef(previewNodeId);
  previewRef.current = previewNodeId;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const first = useRef(true);
  const previousPreview = useRef(previewNodeId);
  const completedSignatureRef = useRef('');
  const signature = useMemo(
    () => evaluationSignature(project, previewNodeId),
    [project, previewNodeId],
  );
  const build = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    if (!enabledRef.current) return;
    const snapshot = projectRef.current;
    const preview = previewRef.current;
    const key = evaluationSignature(snapshot, preview);
    first.current = false;
    previousPreview.current = preview;
    setBusy(true);
    setProgress(0);
    setStage('Building terrain');
    setError(null);
    clientRef.current!.generate(snapshot, preview, {
      progress: (value, label) => {
        if (!enabledRef.current) return;
        setProgress(value);
        setStage(label);
      },
      result: (next) => {
        if (!enabledRef.current) return;
        setBusy(false);
        // A project edit can arrive during the automatic-build debounce. The
        // old computation may populate the cache but cannot publish stale UI.
        if (key !== evaluationSignature(projectRef.current, previewRef.current)) {
          setStage('Settings changed — build again');
          return;
        }
        setResult(next);
        setCompletedProject(snapshot);
        setCompletedPreviewNodeId(preview);
        setCompletedSignature(key);
        completedSignatureRef.current = key;
        setProgress(1);
        setStage('Terrain ready');
      },
      error: (message) => {
        if (!enabledRef.current) return;
        setError(message);
        setBusy(false);
        setStage('Graph needs attention');
      },
    });
  }, []);
  useEffect(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    if (!enabled) {
      clientRef.current?.cancel();
      setBusy(false);
      setStage('Terrain preview paused');
      return;
    }
    const changedPreview = previousPreview.current !== previewNodeId;
    // Keep the last requested target while hidden, so returning to Terrain can
    // honor an explicit graph preview selected from the World workspace.
    if (!first.current && completedSignatureRef.current === signature && !changedPreview) {
      clientRef.current?.cancel();
      setBusy(false);
      setStage('Terrain ready');
      return;
    }
    if (!automatic && !first.current && !changedPreview) return;
    timerRef.current = setTimeout(build, 360);
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [signature, automatic, build, previewNodeId, enabled]);
  useEffect(
    () => () => {
      clientRef.current?.dispose();
    },
    [],
  );
  const cancel = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    clientRef.current?.cancel();
    setBusy(false);
    setStage('Build cancelled');
  }, []);
  const clearCache = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    clientRef.current?.clearCache();
    setBusy(false);
    setStage('Compute cache cleared');
  }, []);
  return {
    result,
    completedProject,
    completedPreviewNodeId,
    busy,
    progress,
    stage,
    error,
    stale: completedSignature !== signature,
    build,
    cancel,
    clearCache,
  };
}
