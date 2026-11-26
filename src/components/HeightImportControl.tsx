import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import {
  MAX_PROJECT_RASTER_BYTES,
  MAX_RASTER_SIDE,
  type HeightRaster,
} from '../model/heightRaster';
import { createHeightImportClient } from '../import/heightImportClient';
import {
  defaultRawEncoding,
  isRawHeightmap,
  rawSampleBytes,
  suggestedRawSide,
  validateRawLayout,
  type RawEncoding,
  type RawLayout,
} from '../import/rawLayout';
import './HeightImportControl.css';

interface RawDraft extends RawEncoding {
  file: File;
  width: string;
  height: string;
}

function rawDraft(file: File): RawDraft {
  const encoding = defaultRawEncoding(file.name);
  const side = suggestedRawSide(file.size, encoding.sampleType);
  return { file, ...encoding, width: side === null ? '' : String(side), height: side === null ? '' : String(side) };
}

function draftLayout(draft: RawDraft): RawLayout {
  return {
    sampleType: draft.sampleType,
    byteOrder: draft.byteOrder,
    width: Number(draft.width),
    height: Number(draft.height),
  };
}

function layoutError(draft: RawDraft, availableBytes: number): string {
  try {
    if (!draft.width || !draft.height) throw new Error('Enter the original grid width and height.');
    validateRawLayout(draft.file.size, draftLayout(draft));
    if (draft.file.size > availableBytes)
      throw new Error('Not enough remaining project sample space. Remove another imported raster or use a smaller grid.');
    return '';
  } catch (cause) {
    return cause instanceof Error ? cause.message : 'Invalid RAW layout.';
  }
}

const mib = (bytes: number) => (bytes / 1048576).toFixed(1) + ' MiB';

export function HeightImportControl({
  raster,
  availableBytes,
  onImport,
}: {
  raster?: HeightRaster;
  availableBytes: number;
  onImport: (raster: HeightRaster, previous?: HeightRaster) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const layoutHint = useId();
  const client = useMemo(
    () => createHeightImportClient(() => new Worker(
      new URL('../import/heightmap.worker.ts', import.meta.url),
      { type: 'module' },
    )),
    [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<RawDraft | null>(null);

  // A different source (including Undo/Redo) or inspector unmount invalidates
  // the pending import. A worker must never overwrite the newly restored source.
  useLayoutEffect(() => {
    setBusy(false);
    setDraft(null);
    setError('');
    setNotice('');
    return client.cancel;
  }, [client, raster]);

  const read = (file: File, rawLayout?: RawLayout) => {
    setError('');
    setNotice('');
    setBusy(true);
    client.start(
      { file, rawLayout },
      (result) => {
        setBusy(false);
        try {
          onImport(result, raster);
          setDraft(null);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : 'The heightmap could not be imported.');
        }
      },
      (message) => {
        setBusy(false);
        setError(message);
      },
    );
  };

  const choose = (file: File) => {
    client.cancel();
    setBusy(false);
    setDraft(null);
    setError('');
    setNotice('');
    if (file.size > MAX_PROJECT_RASTER_BYTES) {
      setError('Choose a heightmap file of 16 MiB or less.');
      return;
    }
    if (isRawHeightmap(file.name)) {
      setDraft(rawDraft(file));
    } else if (/\.png$/i.test(file.name)) {
      read(file);
    } else {
      setError('Choose a grayscale PNG, R16, R32, or RAW file.');
    }
  };

  const patchDraft = (patch: Partial<Omit<RawDraft, 'file'>>) => {
    setDraft((current) => current && { ...current, ...patch });
    setError('');
    setNotice('');
  };

  const validation = draft ? layoutError(draft, availableBytes) : '';
  const square = draft ? suggestedRawSide(draft.file.size, draft.sampleType) : null;
  const cancel = () => {
    client.cancel();
    setBusy(false);
    setError('');
    setNotice('Import cancelled. The current source is unchanged.');
  };

  return (
    <section className="spline-editor height-import" aria-label="Heightmap source file">
      <div className="spline-editor-heading">
        <strong>Source file</strong>
        {raster && <span>{raster.width} × {raster.height}</span>}
      </div>
      {raster ? (
        <div className="height-import-current">
          <strong>{raster.name}</strong>
          <span>{raster.format === 'f32le' ? 'Float32 meters' : 'Unsigned 16-bit samples'}</span>
        </div>
      ) : (
        <p className="spline-help">No heightmap loaded. Choose a file to create a source.</p>
      )}
      <input
        ref={input}
        aria-label="Import heightmap file"
        type="file"
        hidden
        accept=".png,.raw,.r16,.r32"
        disabled={busy}
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (file) choose(file);
        }}
      />
      <button
        type="button"
        className="button secondary spline-edit-button"
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        <Upload size={14} />
        {draft ? 'Choose another file' : raster ? 'Replace heightmap' : 'Choose heightmap'}
      </button>
      {draft && (
        <div className="height-import-layout">
          <div className="height-import-pending">
            <strong>Configure RAW grid</strong>
            <span>{draft.file.name} · {draft.file.size.toLocaleString()} bytes</span>
          </div>
          <p className="spline-help">
            RAW has no header. Confirm the original sample type, byte order and dimensions before importing.
          </p>
          <fieldset disabled={busy}>
            <label>
              Sample type
              <select value={draft.sampleType} onChange={(e) => patchDraft({ sampleType: e.target.value as RawEncoding['sampleType'] })}>
                <option value="uint16">Unsigned 16-bit</option>
                <option value="float32">Float32 meters</option>
              </select>
            </label>
            <label>
              Byte order
              <select value={draft.byteOrder} onChange={(e) => patchDraft({ byteOrder: e.target.value as RawEncoding['byteOrder'] })}>
                <option value="little">Little-endian</option>
                <option value="big">Big-endian</option>
              </select>
            </label>
            <div className="height-import-dimensions">
              <label>
                Grid width
                <input type="number" min={2} max={MAX_RASTER_SIDE} step={1} value={draft.width} aria-describedby={layoutHint} onChange={(e) => patchDraft({ width: e.target.value })} />
              </label>
              <label>
                Grid height
                <input type="number" min={2} max={MAX_RASTER_SIDE} step={1} value={draft.height} aria-describedby={layoutHint} onChange={(e) => patchDraft({ height: e.target.value })} />
              </label>
            </div>
            {square !== null && (draft.width !== String(square) || draft.height !== String(square)) && (
              <button type="button" className="button secondary spline-edit-button" onClick={() => patchDraft({ width: String(square), height: String(square) })}>
                Use {square} × {square} square
              </button>
            )}
          </fieldset>
          <p id={layoutHint} className="height-import-validation" aria-live="polite">
            {validation || `Byte count matches · ${(draftLayout(draft).width * draftLayout(draft).height).toLocaleString()} samples · ${rawSampleBytes(draft.sampleType)} bytes/sample`}
          </p>
          <div className="height-import-actions">
            <button type="button" className="button primary" disabled={busy || Boolean(validation)} onClick={() => read(draft.file, draftLayout(draft))}>
              Import RAW grid
            </button>
            {!busy && (
              <button type="button" className="button secondary" onClick={() => { setDraft(null); setError(''); setNotice(''); }}>
                Discard file
              </button>
            )}
          </div>
        </div>
      )}
      {busy && (
        <div className="height-import-status">
          <p role="status">Reading heightmap… {raster ? 'Keeping the current source until import succeeds.' : 'The terrain is not changed yet.'}</p>
          <progress aria-label="Reading heightmap" />
          <button type="button" className="button secondary spline-edit-button" onClick={cancel}>Cancel import</button>
        </div>
      )}
      {error && <p className="error-notice" role="alert">{error}</p>}
      {notice && <p className="spline-help" role="status">{notice}</p>}
      <p className="spline-help">
        Grayscale PNG (8/16-bit, non-interlaced) or headerless UInt16 / Float32 RAW, up to 2048 × 2048.
        Rectangular grids fill the tile edge to edge; their aspect ratio is not preserved.
        First row is north; use Flip north / south to reverse it. UInt16 spans the project height scale; Float32 stores meters.
      </p>
      <p className="spline-help height-import-budget">
        {mib(availableBytes)} of 16 MiB sample space available for this source, including any current raster being replaced.
      </p>
    </section>
  );
}
