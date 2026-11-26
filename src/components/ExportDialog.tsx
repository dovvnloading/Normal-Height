import { useEffect, useMemo, useState } from 'react';
import { Download, Package, Check, LoaderCircle, ArrowUpRight } from 'lucide-react';
import { Modal } from './Modal';
import { TerrainIcon, EXPORT_ICON_NAMES } from './TerrainIcon';
import { createTerrainWorker } from '../hooks/useTerrainEngine';
import type { ExportFormat } from '../export/heightmap';
import { detailTileMeters } from '../materials/detailTiles';
import { resolveSurface } from '../materials/pbr';
import { listMaskOutputs } from '../export/maskOutputs';
import { pbrBudgetMiB, checkPBRExportBudget, isPBRExportFormat } from '../export/budget';
import { TerrainExportClient, type ExportState } from '../export/exportClient';
import {
  EXPORT_RESOLUTIONS, exportDescription, formatExportSize, mapPayloadBytes, pbrPreflight,
} from '../export/exportPlan';
import { downloadBlob } from '../model/project';
import type { TerrainProject } from '../model/types';

export function ExportDialog({
  project,
  onClose,
}: {
  project: TerrainProject;
  onClose: () => void;
}) {
  const [resolution, setResolution] = useState<number>(() => EXPORT_RESOLUTIONS.find((n) => n >= Math.max(512, project.resolution)) ?? 2048);
  const [choice, setChoice] = useState('png16');
  const maskOutputs = useMemo(() => listMaskOutputs(project.graph), [project.graph]);
  const format = choice.startsWith('mask16:') ? 'mask16' : choice as ExportFormat;
  const mask = maskOutputs.find((output) => choice === 'mask16:' + output.id);
  const [bundle, setBundle] = useState(true);
  const [state, setState] = useState<ExportState>({ phase: 'idle' });
  const [client] = useState(() => new TerrainExportClient(
    createTerrainWorker,
    () => new Worker(new URL('../export/export.worker.ts', import.meta.url), { type: 'module' }),
    downloadBlob,
    setState,
  ));
  useEffect(() => () => client.dispose(), [client]);
  const busy = state.phase === 'generating' || state.phase === 'encoding';
  const memoryGiB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const preflight = pbrPreflight(format, resolution, bundle, memoryGiB);
  const isTiles = format === 'detailTiles';
  const isComplete = format === 'pbr' || isTiles;
  const isBundle = isComplete || bundle;
  const tileMeters = detailTileMeters(resolveSurface(project.surface).detailMeters);
  const resetStatus = () => setState({ phase: 'idle' });
  const chooseResolution = (value: number) => {
    setResolution(value);
    resetStatus();
  };
  const run = () => {
    if (busy || (format === 'mask16' && !mask?.input)) return;
    // Recheck at the execution boundary; the worker repeats this guard before
    // material synthesis. The device memory hint is not measured free RAM.
    const memoryBudgetMiB = pbrBudgetMiB(
      (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    );
    if (isPBRExportFormat(format)) {
      try {
        checkPBRExportBudget(resolution, memoryBudgetMiB, format, isBundle);
      } catch (error) {
        setState({
          phase: 'error',
          message: error instanceof Error ? error.message : 'PBR export exceeds device memory budget.',
        });
        return;
      }
    }
    client.start({
      project, resolution, format, bundle: isBundle, previewNodeId: mask?.id, memoryBudgetMiB,
    });
  };
  const close = () => {
    client.dispose();
    onClose();
  };
  return (
    <Modal
      title="Export your landscape"
      eyebrow="FROM GRAPH TO HEIGHTFIELD"
      onClose={close}
      className="export-modal"
    >
      <div className="modal-body">
        <div className="export-project">
          <span>
            <TerrainIcon name={EXPORT_ICON_NAMES[format]} height={28} />
          </span>
          <div>
            <strong>{project.name}</strong>
            <small>{isTiles ? 'Local surface detail · ' + resolveSurface(project.surface).biome : mask ? mask.displayName : 'Connected Terrain output'} · seed {project.seed}</small>
          </div>
        </div>
        <div className="export-grid">
          <label>
            Format
            <select
              aria-label="Export format"
              value={choice}
              disabled={busy}
              onChange={(e) => {
                setChoice(e.target.value);
                resetStatus();
              }}
            >
              <option value="png16">Heightmap · 16-bit PNG</option>
              <option value="raw32">Elevation · Float32 RAW</option>
              <optgroup label="Named masks · 16-bit PNG">
                {maskOutputs.length === 0 && (
                  <option disabled>Add a Mask output node to the graph</option>
                )}
                {maskOutputs.map((output) => (
                  <option key={output.id} value={'mask16:' + output.id} disabled={!output.input}>
                    {output.displayName}{output.input ? '' : ' · connect an input'}
                  </option>
                ))}
              </optgroup>
              <option value="normal">Terrain normal · OpenGL +Y PNG</option>
              <option value="flow">Flow visualization · 8-bit PNG</option>
              <option value="wear">Erosion wear · 8-bit PNG</option>
              <option value="deposition">Deposition · 8-bit PNG</option>
              <option value="pbr">Complete PBR material set · ZIP</option>
              <option value="detailTiles">Seamless material detail tiles · ZIP</option>
              <option value="basecolor">PBR base color · PNG</option>
              <option value="roughness">PBR roughness · PNG</option>
              <option value="ao">PBR ambient occlusion · PNG</option>
              <option value="metallic">PBR metallic · PNG</option>
              <option value="orm">PBR packed ORM · PNG</option>
              <option value="splat">Terrain layer weights · RGBA PNG</option>
              <option value="curvature">Terrain curvature · PNG</option>
              <option value="normalGL">Material normal · OpenGL +Y PNG</option>
              <option value="detailNormal">Material detail normal · OpenGL +Y PNG</option>
              <option value="normalDX">Material normal · DirectX -Y PNG</option>
            </select>
          </label>
          <label>
            Resolution
            <select
              aria-label="Export resolution"
              value={resolution}
              disabled={busy}
              onChange={(e) => chooseResolution(Number(e.target.value))}
            >
              {EXPORT_RESOLUTIONS.map((n) => (
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
            {isTiles ? 'Four repeatable local materials are synthesized at ' : mask ? 'The selected mask branch is evaluated at ' : 'The complete graph is simulated at '}
            <strong>
              {resolution.toLocaleString()} × {resolution.toLocaleString()}
            </strong>
            . {isTiles ? 'No terrain simulation is needed. Use the local tiles with the landscape splat masks.' : mask ? 'Black is zero weight and white is full weight.' : 'Larger grids take longer and may change erosion detail.'}
          </p>
        </div>
        <label className="export-bundle">
          <Package size={19} />
          <span>
            <strong>
              {isTiles ? 'Complete detail tile bundle' : format === 'pbr' ? 'Complete material bundle'
                : mask ? 'Include project & mask metadata' : 'Include project & elevation metadata'}
            </strong>
            <small>
              {isTiles ? 'Four material folders, six maps per folder and a physical-scale manifest.' : format === 'pbr' ? 'Includes all PBR maps, height, metadata, and project.'
                : mask ? 'ZIP with mask PNG, source connection, and editable project.'
                : 'ZIP bundle with map, reproducible graph and scale information.'}
            </small>
          </span>
          <input
            type="checkbox"
            checked={isBundle}
            disabled={busy || isComplete}
            onChange={(e) => {
              setBundle(e.target.checked);
              resetStatus();
            }}
          />
        </label>
        <dl className="export-spec">
          <div>
            <dt>{isTiles ? 'Repeat period' : 'Terrain extent'}</dt>
            <dd>
              {isTiles ? tileMeters.toFixed(2) + ' × ' + tileMeters.toFixed(2) + ' m' : (project.worldSize / 1000).toFixed(2) + ' × ' + (project.worldSize / 1000).toFixed(2) + ' km'}
            </dd>
          </div>
          <div>
            <dt>Sample spacing</dt>
            <dd>{isTiles ? (tileMeters / resolution * 100).toFixed(3) + ' cm / sample' : (project.worldSize / (resolution - 1)).toFixed(2) + ' m / sample'}</dd>
          </div>
          <div>
            <dt>Precision</dt>
            <dd>
              {isTiles ? '16-bit local relief + 8-bit PBR maps' : format === 'pbr'
                ? '16-bit terrain and relief + 8-bit PBR maps'
                : format === 'mask16'
                  ? '65,536 weight levels · linear 0–1'
                : format === 'png16'
                  ? '65,536 elevation levels'
                : format === 'raw32'
                  ? '32-bit float · meters'
                  : '8-bit per channel'}
            </dd>
          </div>
          <div>
            <dt>Map payload (uncompressed)</dt>
            <dd>{formatExportSize(mapPayloadBytes(format, resolution))}</dd>
          </div>
          {preflight && (
            <div>
              <dt>Estimated temporary memory</dt>
              <dd>~{preflight.estimate} / {preflight.budget} MiB budget</dd>
            </div>
          )}
          <div>
            <dt>Orientation</dt>
            <dd>North at top · row-major</dd>
          </div>
        </dl>
        <p className="parameter-hint">{exportDescription(format)}</p>
        {format === 'png16' && !isBundle && (
          <p className="parameter-hint">
            Map only: the elevation range is not embedded in the PNG. Include the bundle to
            preserve the scale needed to recover absolute elevation.
          </p>
        )}
        {preflight && (
          <p className="parameter-hint">
            Memory is a conservative estimate based on the browser's device hint, not free RAM.
            PNG and ZIP download sizes depend on compression and project data.
          </p>
        )}
        {preflight?.overBudget && (
          <div className="error-notice">
            <span>This selection exceeds the estimated device budget.</span>
            {preflight.suggested !== undefined && (
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => chooseResolution(preflight.suggested!)}
              >
                Use {preflight.suggested} × {preflight.suggested}
              </button>
            )}
          </div>
        )}
        {state.phase === 'error' && (
          <div className="error-notice" role="alert">
            {state.message}
          </div>
        )}
        {state.phase === 'generating' && (
          <div className="export-progress" role="status">
            <div>
              <span>Building terrain · {state.stage}</span>
              <span>{Math.round(state.progress * 100)}%</span>
            </div>
            <progress aria-label="Terrain generation progress" max={1} value={state.progress} />
          </div>
        )}
        {state.phase === 'encoding' && (
          <div className="export-progress" role="status">
            <div>
              <span>{state.stage}</span>
              <span>Encoding…</span>
            </div>
            <progress aria-label="Encoding export" />
          </div>
        )}
        {state.phase === 'cancelled' && (
          <p className="parameter-hint" role="status">
            Export cancelled. No terrain data was changed. Adjust the settings or try again.
          </p>
        )}
        {state.phase === 'success' && (
          <div className="success-notice" role="status">
            <Check size={16} />
            <span>Download started: {state.filename} · {formatExportSize(state.bytes)}</span>
          </div>
        )}
      </div>
      <footer className="modal-footer">
        <button className="button secondary" onClick={busy ? () => client.cancel() : close}>
          {busy ? 'Cancel export' : 'Close'}
        </button>
        <button className="button primary" onClick={run} disabled={busy || (format === 'mask16' && !mask?.input)}>
          {busy ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}{' '}
          {busy
            ? 'Building export…'
            : state.phase === 'success'
              ? 'Export again'
              : `Export ${isBundle ? 'bundle' : 'map'}`}
        </button>
      </footer>
    </Modal>
  );
}
