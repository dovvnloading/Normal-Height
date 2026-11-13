import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EvaluationResult, TerrainProject, WorkerResponse } from '../model/types';

export function evaluationSignature(project: TerrainProject, previewNodeId?: string) {
  return JSON.stringify({
    seed: project.seed,
    resolution: project.resolution,
    worldSize: project.worldSize,
    heightScale: project.heightScale,
    previewNodeId,
    nodes: project.graph.nodes
      .filter((n) => n.kind !== 'note' && n.kind !== 'group')
      .map((n) => ({ id: n.id, kind: n.kind, params: n.params, bypassed: n.bypassed, path: n.path })),
    edges: project.graph.edges,
  });
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
  const workerRef = useRef<Worker | null>(null);
  const jobRef = useRef(0);
  const projectRef = useRef(project);
  projectRef.current = project;
  const previewRef = useRef(previewNodeId);
  previewRef.current = previewNodeId;
  const signature = useMemo(
    () => evaluationSignature(project, previewNodeId),
    [project, previewNodeId],
  );
  const build = useCallback(() => {
    workerRef.current?.terminate();
    const worker = createTerrainWorker();
    workerRef.current = worker;
    const id = ++jobRef.current;
    const snapshot = projectRef.current;
    const preview = previewRef.current;
    const key = evaluationSignature(snapshot, preview);
    setBusy(true);
    setProgress(0);
    setStage('Building terrain');
    setError(null);
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.id !== jobRef.current) return;
      if (message.type === 'progress') {
        setProgress(message.progress);
        setStage(message.stage);
      } else if (message.type === 'result') {
        setResult(message.result);
        setCompletedProject(snapshot);
        setCompletedPreviewNodeId(preview);
        setCompletedSignature(key);
        setBusy(false);
        setProgress(1);
        setStage('Terrain ready');
        worker.terminate();
        workerRef.current = null;
      } else {
        setError(message.message);
        setBusy(false);
        setStage('Graph needs attention');
        worker.terminate();
        workerRef.current = null;
      }
    };
    worker.onerror = (event) => {
      if (id !== jobRef.current) return;
      setError(
        event.message || 'The terrain worker stopped unexpectedly. Try a lower working resolution.',
      );
      setBusy(false);
      worker.terminate();
      workerRef.current = null;
    };
    worker.postMessage({
      type: 'generate',
      id,
      project: snapshot,
      resolution: snapshot.resolution,
      previewNodeId: preview,
    });
  }, []);
  const first = useRef(true);
  const previousPreview = useRef(previewNodeId);
  useEffect(() => {
    const changedPreview = previousPreview.current !== previewNodeId;
    previousPreview.current = previewNodeId;
    if (!automatic && !first.current && !changedPreview) return;
    first.current = false;
    const timer = setTimeout(build, 360);
    return () => clearTimeout(timer);
  }, [signature, automatic, build, previewNodeId]);
  useEffect(
    () => () => {
      workerRef.current?.terminate();
    },
    [],
  );
  const cancel = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    ++jobRef.current;
    setBusy(false);
    setStage('Build cancelled');
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
  };
}
