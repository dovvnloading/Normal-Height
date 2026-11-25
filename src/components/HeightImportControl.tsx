import { useLayoutEffect, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import type { HeightRaster } from '../model/heightRaster';
import type { ImportReply } from '../import/heightmap.worker';

export function HeightImportControl({
  raster,
  onImport,
}: {
  raster?: HeightRaster;
  onImport: (raster: HeightRaster) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const worker = useRef<Worker | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useLayoutEffect(
    () => () => {
      worker.current?.terminate();
      worker.current = null;
    },
    [],
  );

  const load = (file: File) => {
    worker.current?.terminate();
    setError('');
    const task = new Worker(new URL('../import/heightmap.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.current = task;
    setBusy(true);
    const finish = () => {
      task.terminate();
      worker.current = null;
      setBusy(false);
    };
    task.onmessage = (event: MessageEvent<ImportReply>) => {
      if (worker.current !== task) return;
      finish();
      if ('error' in event.data) setError(event.data.error);
      else {
        try {
          onImport(event.data.raster);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : 'The heightmap could not be imported.');
        }
      }
    };
    task.onerror = () => {
      if (worker.current !== task) return;
      finish();
      setError('The heightmap could not be read. Try a smaller file.');
    };
    task.postMessage(file);
  };
  return (
    <section className="spline-editor" aria-label="Heightmap source file">
      <div className="spline-editor-heading">
        <strong>Source file</strong>
        {raster && (
          <span>
            {raster.width} × {raster.height}
          </span>
        )}
      </div>
      {raster && (
        <p className="spline-help" style={{ overflowWrap: 'anywhere' }}>
          {raster.name} · {raster.format === 'f32le' ? 'Float32 meters' : 'Unsigned 16-bit samples'}
        </p>
      )}
      <input
        ref={input}
        aria-label="Import heightmap file"
        type="file"
        hidden
        accept=".png,.raw,.r16,.r32"
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (file) load(file);
        }}
      />
      <button
        type="button"
        className="button secondary spline-edit-button"
        onClick={() => input.current?.click()}
      >
        <Upload size={14} />{' '}
        {busy ? 'Reading heightmap…' : raster ? 'Replace heightmap' : 'Choose heightmap'}
      </button>
      {error && (
        <p className="parameter-hint" role="alert">
          {error}
        </p>
      )}
      <p className="spline-help">
        Use an 8/16-bit non-interlaced grayscale PNG, or a square little-endian RAW grid. R16 and
        .raw use unsigned 16-bit samples. R32 and *-f32le.raw use Float32 meters. Images up to 2048
        × 2048 fill the tile edge to edge.
      </p>
    </section>
  );
}
