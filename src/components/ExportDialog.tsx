import { useEffect, useRef, useState } from 'react';
import { Download, FileImage, Package, Check, LoaderCircle, ArrowUpRight } from 'lucide-react';
import { Modal } from './Modal';
import { createTerrainWorker } from '../hooks/useTerrainEngine';
import { makeExport } from '../export/heightmap';
import type { ExportFormat } from '../export/heightmap';
import { downloadBlob } from '../model/project';
import type { TerrainProject, WorkerResponse } from '../model/types';

export function ExportDialog({
  project,
  onClose,
}: {
  project: TerrainProject;
  onClose: () => void;
}) {
  const [resolution, setResolution] = useState(Math.max(512, project.resolution));
  const [format, setFormat] = useState<ExportFormat>('png16');
  const [bundle, setBundle] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const workerRef = useRef<Worker | null>(null);
  useEffect(() => () => workerRef.current?.terminate(), []);
  const cancel = () => {
    workerRef.current?.terminate();
    workerRef.current = null;
    setBusy(false);
    setStage('Export cancelled');
  };
  const run = () => {
    setBusy(true);
    setProgress(0);
    setError('');
    setSuccess('');
    setStage('Preparing full-resolution terrain');
    const worker = createTerrainWorker();
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const m = event.data;
      if (m.type === 'progress') {
        setProgress(m.progress * 0.92);
        setStage(m.stage);
      } else if (m.type === 'error') {
        setError(m.message);
        setBusy(false);
        worker.terminate();
        workerRef.current = null;
      } else if (m.type === 'result') {
        setProgress(0.94);
        setStage('Encoding your maps');
        worker.terminate();
        workerRef.current = null;
        setTimeout(() => {
          try {
            const file = makeExport(m.result.field, project, format, bundle);
            downloadBlob(new Blob([file.bytes.slice().buffer], { type: file.mime }), file.filename);
            setSuccess(file.filename);
            setProgress(1);
            setStage('Export ready');
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not encode the export.');
          } finally {
            setBusy(false);
          }
        }, 30);
      }
    };
    worker.onerror = (e) => {
      setError(e.message || 'Export failed. Try a lower resolution.');
      setBusy(false);
      worker.terminate();
      workerRef.current = null;
    };
    worker.postMessage({ type: 'generate', id: 1, project, resolution });
  };
  return (
    <Modal
      title="Export your landscape"
      eyebrow="FROM GRAPH TO HEIGHTFIELD"
      onClose={onClose}
      className="export-modal"
    >
      <div className="modal-body">
        <div className="export-project">
          <span>
            <FileImage size={23} />
          </span>
          <div>
            <strong>{project.name}</strong>
            <small>Connected Terrain output · seed {project.seed}</small>
          </div>
        </div>
        <div className="export-grid">
          <label>
            Format
            <select
              aria-label="Export format"
              value={format}
              disabled={busy}
              onChange={(e) => setFormat(e.target.value as ExportFormat)}
            >
              <option value="png16">Heightmap · 16-bit PNG</option>
              <option value="raw32">Elevation · Float32 RAW</option>
              <option value="normal">Normal map · 8-bit PNG</option>
              <option value="flow">Flow visualization · 8-bit PNG</option>
              <option value="wear">Erosion wear · 8-bit PNG</option>
              <option value="deposition">Deposition · 8-bit PNG</option>
            </select>
          </label>
          <label>
            Resolution
            <select
              aria-label="Export resolution"
              value={resolution}
              disabled={busy}
              onChange={(e) => setResolution(Number(e.target.value))}
            >
              {[256, 512, 1024, 2048].map((n) => (
                <option value={n} key={n}>
                  {n} × {n}
                  {n === 1024 ? ' · 1K' : n === 2048 ? ' · 2K' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="export-detail">
          <ArrowUpRight size={16} />
          <p>
            The complete graph is simulated at{' '}
            <strong>
              {resolution.toLocaleString()} × {resolution.toLocaleString()}
            </strong>
            . Larger grids take longer and create new erosion detail.
          </p>
        </div>
        <label className="export-bundle">
          <Package size={19} />
          <span>
            <strong>Include project & elevation metadata</strong>
            <small>ZIP bundle with the map, reproducible graph, and scale information.</small>
          </span>
          <input
            type="checkbox"
            checked={bundle}
            disabled={busy}
            onChange={(e) => setBundle(e.target.checked)}
          />
        </label>
        <dl className="export-spec">
          <div>
            <dt>Terrain extent</dt>
            <dd>
              {(project.worldSize / 1000).toFixed(2)} × {(project.worldSize / 1000).toFixed(2)} km
            </dd>
          </div>
          <div>
            <dt>Sample spacing</dt>
            <dd>{(project.worldSize / (resolution - 1)).toFixed(2)} m / sample</dd>
          </div>
          <div>
            <dt>Precision</dt>
            <dd>
              {format === 'png16'
                ? '65,536 elevation levels'
                : format === 'raw32'
                  ? '32-bit float · meters'
                  : '8-bit per channel'}
            </dd>
          </div>
          <div>
            <dt>Orientation</dt>
            <dd>North at top · row-major</dd>
          </div>
        </dl>
        {format === 'png16' && (
          <p className="parameter-hint">
            PNG uses the terrain’s actual minimum and maximum elevation. The metadata records the
            values needed to restore elevation in meters.
          </p>
        )}
        {format === 'normal' && (
          <p className="parameter-hint">
            Tangent-space normals, OpenGL +Y convention. Uses physical terrain dimensions,
            independent of viewport exaggeration.
          </p>
        )}
        {error && (
          <div className="error-notice" role="alert">
            {error}
          </div>
        )}
        {busy && (
          <div className="export-progress" role="status">
            <div>
              <span>{stage}</span>
              <span>{Math.round(progress * 100)}%</span>
            </div>
            <progress max={1} value={progress} />
          </div>
        )}
        {success && (
          <div className="success-notice" role="status">
            <Check size={16} />
            <span>Downloaded {success}</span>
          </div>
        )}
      </div>
      <footer className="modal-footer">
        <button className="button secondary" onClick={busy ? cancel : onClose}>
          {busy ? 'Cancel export' : 'Close'}
        </button>
        <button className="button primary" onClick={run} disabled={busy}>
          {busy ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}{' '}
          {busy
            ? 'Building export…'
            : success
              ? 'Export again'
              : `Export ${bundle ? 'bundle' : 'map'}`}
        </button>
      </footer>
    </Modal>
  );
}
