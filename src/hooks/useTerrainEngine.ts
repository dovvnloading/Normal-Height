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
  const signature = useMemo(
    () => evaluationSignature(project, previewNodeId),
    [project, previewNodeId],
  );
  const build = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    const snapshot = projectRef.current;
    const preview = previewRef.current;
    const key = evaluationSignature(snapshot, preview);
    setBusy(true);
    setProgress(0);
    setStage('Building terrain');
    setError(null);
    clientRef.current!.generate(snapshot, preview, {
      progress: (value, label) => {
        setProgress(value);
        setStage(label);
      },
      result: (next) => {
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
        setProgress(1);
        setStage('Terrain ready');
      },
      error: (message) => {
        setError(message);
        setBusy(false);
        setStage('Graph needs attention');
      },
    });
  }, []);
  const first = useRef(true);
  const previousPreview = useRef(previewNodeId);
  useEffect(() => {
    const changedPreview = previousPreview.current !== previewNodeId;
    previousPreview.current = previewNodeId;
    if (!automatic && !first.current && !changedPreview) return;
    first.current = false;
    timerRef.current = setTimeout(build, 360);
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [signature, automatic, build, previewNodeId]);
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
