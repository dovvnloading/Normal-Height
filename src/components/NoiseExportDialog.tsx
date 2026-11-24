import { useEffect, useRef, useState } from 'react';
import { Check, Download, LoaderCircle } from 'lucide-react';
import { Modal } from './Modal';
import { downloadBlob } from '../model/project';
import { resolveNoiseSeed, resolveStudioSettings, STUDIO_KERNELS } from '../model/noiseStudio';
import type { ParamValue } from '../model/types';
import type { NoiseExportFormat } from '../export/noiseExport';

type ExportMessage = { id: number } & (
  | { type: 'chunk'; bytes: ArrayBuffer }
  | { type: 'progress'; progress: number; stage: string }
  | { type: 'done'; filename: string }
  | { type: 'error'; message: string }
);
export function NoiseExportDialog({
  params,
  projectSeed,
  worldSize,
  heightScale,
  onClose,
}: {
  params: Record<string, ParamValue>;
  projectSeed: number;
  worldSize: number;
  heightScale: number;
  onClose: () => void;
}) {
  const [resolution, setResolution] = useState(2048);
  const [format, setFormat] = useState<NoiseExportFormat>('png16');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const worker = useRef<Worker | null>(null);
  const generation = useRef(0);
  const chunks = useRef<ArrayBuffer[]>([]);
  const s = resolveStudioSettings(params);
  useEffect(
    () => () => {
      ++generation.current;
      worker.current?.terminate();
      chunks.current = [];
    },
    [],
  );
  const stop = () => {
    ++generation.current;
    worker.current?.terminate();
    worker.current = null;
    chunks.current = [];
    setBusy(false);
  };
  const run = () => {
    stop();
    setError('');
    setSuccess('');
    setProgress(0);
    setStage('Preparing source export');
    // The generator is bounded by strip size; the final ZIP must still fit in
    // browser memory. Keep 8K available on desktop, and limit small devices.
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    if (resolution > 4096 && memory !== undefined && memory <= 2) {
      setError('Choose 4K or smaller on this device so the completed archive fits in memory.');
      return;
    }
    const id = ++generation.current;
    let w: Worker;
    try {
      w = new Worker(new URL('../workers/noiseExport.worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to start export worker.');
      return;
    }
    worker.current = w;
    setBusy(true);
    w.onmessage = (event: MessageEvent<ExportMessage>) => {
      const m = event.data;
      if (m.id !== generation.current) return;
      if (m.type === 'chunk') chunks.current.push(m.bytes);
      else if (m.type === 'progress') {
        setProgress(m.progress);
        setStage(m.stage);
      } else if (m.type === 'error') {
        stop();
        setError(m.message);
      } else {
        try {
          const blob = new Blob(chunks.current, { type: 'application/zip' });
          stop();
          downloadBlob(blob, m.filename);
          setSuccess(m.filename);
          setProgress(1);
          setStage('Export downloaded');
        } catch (e) {
          stop();
          setError(
            e instanceof Error
              ? e.message
              : 'The completed archive could not be downloaded. Try a smaller resolution.',
          );
        }
      }
    };
    w.onerror = (e) => {
      if (id === generation.current) {
        stop();
        setError(e.message || 'Noise export failed.');
      }
    };
    try {
      w.postMessage({
        id,
        options: { params, projectSeed, worldSize, heightScale, resolution, format },
      });
    } catch (e) {
      stop();
      setError(e instanceof Error ? e.message : 'Could not start source export.');
    }
  };
  return (
    <Modal
      title="Export noise source"
      eyebrow="NOISE STUDIO / HIGH RESOLUTION"
      onClose={onClose}
      className="export-modal"
    >
      <div className="modal-body">
        <div className="export-project">
          <Download size={24} />
          <div>
            <strong>{STUDIO_KERNELS.find(([id]) => id === s.kernel)?.[1]}</strong>
            <small>Studio v3 · resolved seed {resolveNoiseSeed(s, projectSeed)}</small>
          </div>
        </div>
        <p className="parameter-hint">
          Exports this source at the selected resolution, before downstream graph operations. Every
          bundle contains the map, a recipe with its resolved seed locked, and scale and seed
          metadata.
        </p>
        <div className="export-grid">
          <label>
            Format
            <select
              aria-label="Noise export format"
              value={format}
              disabled={busy}
              onChange={(e) => setFormat(e.target.value as NoiseExportFormat)}
            >
              <option value="png16">Height · 16-bit PNG + recipe</option>
              <option value="raw32">Scalar · Float32 RAW + recipe</option>
            </select>
          </label>
          <label>
            Resolution
            <select
              aria-label="Noise export resolution"
              value={resolution}
              disabled={busy}
              onChange={(e) => setResolution(Number(e.target.value))}
            >
              {[256, 512, 1024, 2048, 4096, 8192].map((n) => (
                <option key={n} value={n}>
                  {n.toLocaleString()} × {n.toLocaleString()}
                  {n >= 1024 ? ` · ${n / 1024}K` : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
        <dl className="export-spec">
          <div>
            <dt>Sampling</dt>
            <dd>
              {s.sampling === 'point'
                ? 'Unfiltered reference'
                : s.sampling === 'supersample4'
                  ? 'Filtered · 16 samples'
                  : s.sampling === 'supersample2'
                    ? 'Filtered · 4 samples'
                    : 'Filtered'}
            </dd>
          </div>
          <div>
            <dt>Sample spacing</dt>
            <dd>{(worldSize / (resolution - 1)).toFixed(3)} m</dd>
          </div>
          <div>
            <dt>Uncompressed map</dt>
            <dd>{((resolution ** 2 * (format === 'png16' ? 2 : 4)) / 1048576).toFixed(1)} MiB</dd>
          </div>
          <div>
            <dt>Source units</dt>
            <dd>Scalar · multiply by {heightScale.toLocaleString()} m</dd>
          </div>
        </dl>
        <p className="parameter-hint">
          {format === 'png16'
            ? 'PNG measures the actual range in a first pass, then encodes 65,536 levels without clipping. Metadata gives the exact decoding range.'
            : 'RAW preserves the Float32 source values, including values outside 0–1. It uses little-endian, row-major storage without a header.'}{' '}
          Generation uses strips; the completed archive still uses browser memory. Large maps and
          supersampling take longer. You can cancel at any time.
        </p>
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
        <button
          className="button secondary"
          onClick={
            busy
              ? () => {
                  stop();
                  setStage('Export cancelled');
                }
              : onClose
          }
        >
          {busy ? 'Cancel export' : 'Close'}
        </button>
        <button className="button primary" onClick={run} disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}
          {busy ? 'Generating source…' : 'Export source bundle'}
        </button>
      </footer>
    </Modal>
  );
}
