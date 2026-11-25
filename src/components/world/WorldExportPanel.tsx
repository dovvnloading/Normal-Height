import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Clock3,
  FileJson,
  HardDrive,
  Info,
  Layers3,
  PackageCheck,
  RotateCcw,
  X,
} from 'lucide-react';
import type { TerrainProject } from '../../model/types';
import type { WorldDefinition } from '../../model/world';
import { downloadBlob } from '../../model/project';
import type { WorldGridRequest } from '../../hooks/worldProtocol';
import type {
  WorldExportOptions,
  WorldExportProfile,
  WorldExportFormat,
} from '../../export/worldExport';
import {
  WorldExportClient,
  type WorldExportReceipt,
  type WorldExportState,
  type WorldFileHandle,
} from '../../export/worldExportClient';
import {
  planWorldExport,
  WORLD_EXPORT_SAMPLE_PRESETS,
  worldExportSamplesZ,
  type WorldExportSinkPlan,
} from '../../export/worldExportPlan';
import './WorldExportPanel.css';

type Region = Pick<WorldGridRequest, 'startX' | 'startZ' | 'cellsX' | 'cellsZ'>;
export interface WorldExportActivity {
  busy: boolean;
  progress: number | null;
  stage: string;
  detail?: string;
  cancel?: () => void;
}
type PickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<WorldFileHandle>;
};

const number = (value: number, digits = 1) =>
  Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: digits }) : '—';
const mib = (bytes: number) => `${number(bytes / 1048576)} MiB`;
const bytesLabel = (bytes: number) =>
  bytes < 1024
    ? `${number(bytes, 0)} B`
    : bytes < 1048576
      ? `${number(bytes / 1024)} KiB`
      : mib(bytes);
const distance = (meters: number) =>
  meters >= 1000 ? `${number(meters / 1000, 2)} km` : `${number(meters)} m`;
const elapsed = (ms: number) =>
  ms < 1000
    ? `${Math.round(ms)} ms`
    : ms < 60000
      ? `${number(ms / 1000, 1)} s`
      : `${Math.floor(ms / 60000)}m ${Math.floor(ms / 1000) % 60}s`;
const phaseNames = {
  choosing: 'Choose a destination',
  preparing: 'Preparing world',
  range: 'Measuring elevation',
  encoding: 'Encoding terrain maps',
  masks: 'Encoding authored masks',
  packing: 'Packing your world',
  saving: 'Finishing delivery',
};

function ScopePreview({ options }: { options: WorldExportOptions }) {
  const id = useId();
  const d = options.world.domain;
  const aspect =
    Number.isFinite(d.width / d.depth) && d.width > 0 && d.depth > 0 ? d.width / d.depth : 1;
  const width = Math.min(150, 94 * aspect),
    height = Math.min(94, 150 / aspect);
  const x = (174 - width) / 2,
    y = (110 - height) / 2;
  const r = options.region ?? { startX: 0, startZ: 0, cellsX: d.cellsX, cellsZ: d.cellsZ };
  const valid =
    [r.startX, r.startZ, r.cellsX, r.cellsZ, d.cellsX, d.cellsZ].every(Number.isFinite) &&
    d.cellsX > 0 &&
    d.cellsZ > 0;
  return (
    <svg
      viewBox="0 0 174 110"
      className="we-export-footprint"
      role="img"
      aria-label={
        options.region
          ? 'Selected export region inside the world boundary'
          : 'Full world export footprint'
      }
    >
      <defs>
        <pattern id={id} width="10" height="10" patternUnits="userSpaceOnUse">
          <path d="M10 0H0V10" fill="none" stroke="currentColor" strokeWidth="0.5" opacity="0.25" />
        </pattern>
      </defs>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        fill={`url(#${id})`}
        stroke="currentColor"
        strokeOpacity="0.35"
      />
      {valid && (
        <rect
          x={x + (width * r.startX) / d.cellsX}
          y={y + (height * r.startZ) / d.cellsZ}
          width={(width * r.cellsX) / d.cellsX}
          height={(height * r.cellsZ) / d.cellsZ}
          fill="var(--we-accent, #396b55)"
          fillOpacity="0.18"
          stroke="var(--we-accent, #396b55)"
          strokeWidth="1.5"
        />
      )}
      <text x="162" y="13" textAnchor="middle" fill="currentColor" fontSize="8">
        N
      </text>
      <path d="M162 18v11m-3-7 3-4 3 4" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function DestinationPlan({
  title,
  plan,
  available = true,
  onReduce,
}: {
  title: string;
  plan: WorldExportSinkPlan;
  available?: boolean;
  onReduce: (samples: number) => void;
}) {
  return (
    <div className={`we-export-destination ${plan.error ? 'has-issue' : ''}`}>
      <div className="we-export-destination-heading">
        <strong>{title}</strong>
        <span>
          {!available ? (
            'Unavailable'
          ) : plan.error ? (
            'Adjust settings'
          ) : (
            <>
              <Check size={12} /> Ready
            </>
          )}
        </span>
      </div>
      <p>
        {plan.estimate
          ? `${mib(plan.estimate.peakBytes)} estimated peak memory`
          : 'Check the settings above'}
      </p>
      {plan.error && (
        <div className="we-export-plan-issue">
          <p>{plan.error}</p>
          {plan.smallerSamples !== null && (
            <button
              type="button"
              className="we-export-text-button"
              aria-label={`Use ${plan.smallerSamples} samples for ${title.toLowerCase()}`}
              onClick={() => onReduce(plan.smallerSamples!)}
            >
              Use {number(plan.smallerSamples, 0)} samples <ArrowUpRight size={13} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ExportReceipt({ receipt }: { receipt: WorldExportReceipt }) {
  const [manifestMessage, setManifestMessage] = useState('');
  const [manifestError, setManifestError] = useState('');
  const manifest = receipt.manifest;
  const fileCount = manifest.tiles.reduce((sum, tile) => sum + tile.files.length, 0) + 3;
  return (
    <section className="we-export-receipt" aria-label="Last completed world export">
      <div className="we-export-receipt-label">
        <span>Last completed export</span>
        <time dateTime={new Date(receipt.completedAt).toISOString()}>
          {new Date(receipt.completedAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </time>
      </div>
      <div className="we-export-receipt-title">
        <PackageCheck size={19} />
        <div>
          <strong>{receipt.sink === 'file' ? 'World package saved' : 'Download initiated'}</strong>
          <small>
            {bytesLabel(receipt.bytes)} · {number(fileCount, 0)} files ·{' '}
            {elapsed(receipt.durationMs)}
          </small>
        </div>
      </div>
      <p className="we-export-filename">{receipt.filename}</p>
      <p className="we-export-caption">
        Captured settings · {distance(manifest.dimensions.widthMeters)} ×{' '}
        {distance(manifest.dimensions.depthMeters)} · {manifest.profile}
      </p>
      <dl className="we-export-metrics">
        <div>
          <dt>Output grid</dt>
          <dd>
            {number(manifest.dimensions.samples[0], 0)} ×{' '}
            {number(manifest.dimensions.samples[1], 0)}
          </dd>
        </div>
        <div>
          <dt>Shared-edge tiles</dt>
          <dd>{number(manifest.tiles.length, 0)}</dd>
        </div>
        <div>
          <dt>Elevation range</dt>
          <dd>
            {number(manifest.encoding.elevationMinMeters)}–
            {number(manifest.encoding.elevationMaxMeters)} m
          </dd>
        </div>
        <div>
          <dt>Height encoding</dt>
          <dd>{manifest.encoding.heightFormat.toUpperCase()}</dd>
        </div>
      </dl>
      <details className="we-export-details">
        <summary>Package details and import guidance</summary>
        <p>{manifest.approximation}</p>
        <p>{manifest.importQualification}</p>
        <p>{manifest.encoding.decode}</p>
        <p>{manifest.borders}</p>
        <button
          className="we-export-text-button"
          type="button"
          onClick={() => {
            try {
              downloadBlob(
                new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }),
                receipt.filename.replace(/\.zip$/, '-manifest.json'),
              );
              setManifestError('');
              setManifestMessage('Manifest download initiated.');
            } catch (error) {
              setManifestMessage('');
              setManifestError(
                error instanceof Error ? error.message : 'Could not download the manifest.',
              );
            }
          }}
        >
          <FileJson size={14} /> Download manifest
        </button>
        {manifestMessage && <p role="status">{manifestMessage}</p>}
        {manifestError && <p role="alert">{manifestError}</p>}
      </details>
    </section>
  );
}

export function WorldExportPanel({
  project,
  world,
  region,
  regionRequest = 0,
  onActivity,
}: {
  project: TerrainProject;
  world: WorldDefinition;
  region: Region | null;
  /** A contextual delivery action opts the next draft into the selected footprint. */
  regionRequest?: number;
  onActivity?: (activity: WorldExportActivity | null) => void;
}) {
  const [profile, setProfile] = useState<WorldExportProfile>('generic');
  const [format, setFormat] = useState<WorldExportFormat>('png16');
  const [samples, setSamples] = useState(1024);
  const [selectionOnly, setSelectionOnly] = useState(false);
  const previousRegionRequest = useRef(regionRequest);
  useEffect(() => {
    if (previousRegionRequest.current === regionRequest) return;
    previousRegionRequest.current = regionRequest;
    setSelectionOnly(region !== null);
  }, [regionRequest, region]);
  const [diagnostics, setDiagnostics] = useState(true);
  const [normals, setNormals] = useState(true);
  const [maskIds, setMaskIds] = useState<string[]>([]);
  const [state, setState] = useState<WorldExportState>({ status: 'idle' });
  const [receipt, setReceipt] = useState<WorldExportReceipt | null>(null);
  const [lockedOptions, setLockedOptions] = useState<WorldExportOptions | null>(null);
  const [clock, setClock] = useState(Date.now);
  const activityCallback = useRef(onActivity);
  const feedback = useRef<HTMLDivElement>(null);
  const review = useRef<HTMLElement>(null);
  activityCallback.current = onActivity;
  const supportsFile =
    typeof window !== 'undefined' &&
    typeof (window as PickerWindow).showSaveFilePicker === 'function';
  const [client] = useState(
    () =>
      new WorldExportClient(
        () =>
          new Worker(new URL('../../export/worldExport.worker.ts', import.meta.url), {
            type: 'module',
          }),
        supportsFile
          ? (filename) =>
              (window as PickerWindow).showSaveFilePicker!({
                suggestedName: filename,
                types: [{ description: 'World package', accept: { 'application/zip': ['.zip'] } }],
              })
          : undefined,
        downloadBlob,
        (next) => {
          setState(next);
          if (next.status === 'success') setReceipt(next.receipt);
        },
      ),
  );
  useEffect(() => () => client.dispose(), [client]);
  const cancel = useCallback(() => client.cancel(), [client]);
  const busy = state.status === 'running';
  useEffect(() => {
    if (state.status === 'idle' || !feedback.current?.getClientRects().length) return;
    feedback.current.scrollIntoView({
      block: 'start',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
    });
  }, [state.status]);
  useEffect(() => {
    if (!busy) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);
  useEffect(() => {
    const publish = activityCallback.current;
    if (!publish) return;
    if (state.status === 'idle') {
      publish(null);
      return;
    }
    if (state.status === 'running')
      publish({
        busy: true,
        progress: state.progress,
        stage: state.stage,
        detail:
          state.total !== undefined
            ? `${number(state.completed!, 0)} / ${number(state.total, 0)} tiles · ${bytesLabel(state.bytes)}`
            : state.filename,
        cancel,
      });
    else
      publish({
        busy: false,
        progress: state.status === 'success' ? 1 : null,
        stage:
          state.status === 'success'
            ? state.receipt.sink === 'file'
              ? 'World package saved'
              : 'World package download initiated'
            : state.status === 'error'
              ? state.message
              : 'Export cancelled',
      });
  }, [state, cancel]);

  const options = useMemo<WorldExportOptions>(() => {
    const r = selectionOnly && region ? region : undefined;
    return {
      project,
      world,
      profile,
      format,
      samplesX: samples,
      samplesZ: worldExportSamplesZ({ world, profile, region: r }, samples),
      region: r,
      tileIntervals: world.tileCells,
      diagnostics,
      normals,
      masks: project.graph.nodes
        .filter((node) => node.kind === 'mask' && maskIds.includes(node.id))
        .map((node) => ({ nodeId: node.id, name: node.label })),
    };
  }, [
    project,
    world,
    profile,
    format,
    samples,
    selectionOnly,
    region,
    diagnostics,
    normals,
    maskIds,
  ]);
  const shownOptions = busy && lockedOptions ? lockedOptions : options;
  const shownProfile = shownOptions.profile;
  const masks = shownOptions.project.graph.nodes.filter((node) => node.kind === 'mask');
  const shownMasks = shownOptions.masks?.map((mask) => mask.nodeId) ?? [];
  const plan = useMemo(() => planWorldExport(shownOptions), [shownOptions]);
  const estimate = plan.memory.estimate ?? plan.file.estimate;
  const start = (sink: 'memory' | 'file') => {
    if (client.busy) return;
    try {
      const snapshot = structuredClone(options);
      setLockedOptions(snapshot);
      client.start(snapshot, sink);
    } catch (error) {
      setState({
        status: 'error',
        bytes: 0,
        message: error instanceof Error ? error.message : 'Could not capture the export settings.',
      });
    }
  };
  const phaseIndex =
    state.status === 'running'
      ? state.phase === 'choosing' || state.phase === 'preparing'
        ? 0
        : state.phase === 'range'
          ? 1
          : state.phase === 'encoding' || state.phase === 'masks'
            ? 2
            : 3
      : -1;
  return (
    <div className="we-export">
      <header className="we-export-heading">
        <span className="we-export-eyebrow">WORLD / DELIVERY</span>
        <h2>Deliver your world.</h2>
        <p>
          Aligned terrain tiles, import settings, and your original project in one reproducible
          package.
        </p>
      </header>

      <div ref={feedback} className="we-export-feedback">
        {busy && (
          <section className="we-export-job" aria-label="Current world export">
            <div className="we-export-job-heading">
              <HardDrive size={17} />
              <strong role="status">{phaseNames[state.phase]}</strong>
              <span>
                <Clock3 size={12} />
                {elapsed(Math.max(0, clock - state.startedAt))}
              </span>
            </div>
            <p className="we-export-filename">{state.filename}</p>
            <ol className="we-export-steps" aria-label="Export stages">
              {['Prepare', 'Measure', 'Encode', 'Package'].map((name, index) => (
                <li
                  key={name}
                  className={
                    index < phaseIndex ? 'complete' : index === phaseIndex ? 'current' : ''
                  }
                  aria-current={index === phaseIndex ? 'step' : undefined}
                >
                  <span>{index < phaseIndex ? <Check size={11} /> : index + 1}</span>
                  {name}
                </li>
              ))}
            </ol>
            <p className="we-export-job-stage">{state.stage}</p>
            <progress
              aria-label={phaseNames[state.phase]}
              max={1}
              value={state.progress === null ? undefined : state.progress}
            />
            <div className="we-export-job-stats">
              <span>
                {state.total === undefined
                  ? 'Working…'
                  : `${number(state.completed!, 0)} / ${number(state.total, 0)} tiles`}
              </span>
              <span>
                {bytesLabel(state.bytes)} {state.sink === 'file' ? 'written' : 'assembled'}
              </span>
            </div>
            <p className="we-export-caption">
              This job uses the settings captured at launch. You can keep exploring while it runs.
            </p>
            <button type="button" className="we-export-button secondary" onClick={cancel}>
              <X size={14} />
              Cancel export
            </button>
          </section>
        )}

        {state.status === 'error' && (
          <div className="we-export-error" role="alert">
            <strong>The package could not be completed</strong>
            <p>{state.message}</p>
            <button type="button" className="we-export-text-button" onClick={() => client.retry()}>
              <RotateCcw size={13} />
              Retry export
            </button>
          </div>
        )}
        {state.status === 'cancelled' && (
          <p className="we-export-notice" role="status">
            Export cancelled. Your world is unchanged.
          </p>
        )}
        {state.status === 'success' && (
          <p className="we-export-sr-only" role="status">
            {state.receipt.sink === 'file'
              ? 'World package saved'
              : 'World package download initiated'}
            : {state.receipt.filename}
          </p>
        )}
        {receipt && !busy && <ExportReceipt key={receipt.completedAt} receipt={receipt} />}
      </div>

      <fieldset className="we-export-settings" disabled={busy}>
        <legend className="we-export-sr-only">World delivery settings</legend>
        <section className="we-export-section">
          <div className="we-export-section-title">
            <span>01</span>
            <h3>Choose your footprint</h3>
          </div>
          <div className="we-export-scope">
            <ScopePreview options={shownOptions} />
            <div>
              <strong>{shownOptions.region ? 'Selected region' : 'Full world'}</strong>
              <span>
                {distance(plan.widthMeters)} × {distance(plan.depthMeters)}
              </span>
              <small>
                {estimate
                  ? `${number(estimate.tileCount, 0)} shared-edge tiles`
                  : 'Check world settings'}
              </small>
            </div>
          </div>
          <label className="we-export-check">
            <input
              type="checkbox"
              checked={!!shownOptions.region}
              disabled={!region || busy}
              onChange={(event) => setSelectionOnly(event.target.checked)}
            />
            <span>
              Selected region only
              <small>
                {region || shownOptions.region
                  ? 'Use the highlighted tiles on the map.'
                  : 'Select tiles on the map to export a smaller area.'}
              </small>
            </span>
          </label>
        </section>

        <section className="we-export-section">
          <div className="we-export-section-title">
            <span>02</span>
            <h3>Set the output</h3>
          </div>
          <label className="we-export-field">
            <span>Target profile</span>
            <select
              aria-label="World export profile"
              value={shownProfile}
              onChange={(event) => {
                const value = event.target.value as WorldExportProfile;
                setProfile(value);
                setSamples(value === 'unreal' ? 1009 : value === 'unity' ? 1025 : 1024);
                setFormat(value === 'unity' ? 'raw16' : 'png16');
              }}
            >
              <option value="generic">Generic Cartesian world</option>
              <option value="unreal">Unreal Landscape · experimental</option>
              <option value="unity">Unity Terrain · experimental</option>
            </select>
          </label>
          <label className="we-export-field">
            <span>Height encoding</span>
            <select
              aria-label="World height format"
              value={shownOptions.format}
              onChange={(event) => setFormat(event.target.value as WorldExportFormat)}
            >
              <option value="png16" disabled={shownProfile === 'unity'}>
                16-bit PNG / common range
              </option>
              <option value="raw32" disabled={shownProfile !== 'generic'}>
                Float32 RAW / meters
              </option>
              <option value="raw16">UInt16 RAW / little endian</option>
            </select>
          </label>
          <label className="we-export-field">
            <span>East sample count</span>
            <select
              aria-label="World export samples"
              value={shownOptions.samplesX}
              onChange={(event) => setSamples(Number(event.target.value))}
            >
              {WORLD_EXPORT_SAMPLE_PRESETS[shownProfile].map((value) => (
                <option key={value} value={value}>
                  {number(value, 0)} samples
                </option>
              ))}
            </select>
          </label>
          <dl className="we-export-metrics">
            <div>
              <dt>Exact output grid</dt>
              <dd>
                {number(shownOptions.samplesX, 0)} × {number(shownOptions.samplesZ, 0)}
              </dd>
            </div>
            <div>
              <dt>Sample spacing</dt>
              <dd>
                {number(plan.spacingX, 2)} × {number(plan.spacingZ, 2)} m
              </dd>
            </div>
          </dl>
          <p className="we-export-caption">
            {shownOptions.format === 'raw32'
              ? 'Float32 stores physical elevation in meters. No header; row-major, little endian.'
              : 'All tiles share one elevation range. Exact decoding values are included in the manifest.'}
          </p>
          {plan.referenceSpacing && (
            <p className="we-export-note">
              <Info size={14} />
              <span>
                Global stages use a {number(plan.referenceSpacing[0], 1)} ×{' '}
                {number(plan.referenceSpacing[1], 1)} m reference grid. Export spacing changes
                sampling; it does not rerun those simulations at a higher resolution.
              </span>
            </p>
          )}
          {shownProfile !== 'generic' && (
            <p className="we-export-caption">
              This profile includes engine import scales and dimensions. Real editor import
              verification remains experimental.
            </p>
          )}
        </section>

        <section className="we-export-section">
          <div className="we-export-section-title">
            <span>03</span>
            <h3>Include your maps</h3>
          </div>
          <div className="we-export-included">
            <CheckCircle2 size={15} />
            <span>
              Height tiles, manifest & project
              <small>Always included · common range & checksums</small>
            </span>
          </div>
          <label className="we-export-check">
            <input
              type="checkbox"
              aria-label="Flow, wear & deposition"
              checked={!!shownOptions.diagnostics}
              onChange={(event) => setDiagnostics(event.target.checked)}
            />
            <span>
              Flow, wear & deposition
              <small>
                Includes physical slope in degrees. Flow and erosion channels are diagnostics, not
                physical volumes.
              </small>
            </span>
          </label>
          <label className="we-export-check">
            <input
              type="checkbox"
              aria-label="Terrain normal map"
              checked={!!shownOptions.normals}
              onChange={(event) => setNormals(event.target.checked)}
            />
            <span>
              Terrain normal map<small>OpenGL +Y · continuous derivatives across tiles</small>
            </span>
          </label>
          {masks.length > 0 && (
            <div className="we-export-masks">
              <span className="we-export-label">
                <Layers3 size={13} /> Authored mask branches
              </span>
              {masks.map((node) => (
                <label className="we-export-check" key={node.id}>
                  <input
                    type="checkbox"
                    aria-label={`Mask: ${node.label}`}
                    checked={shownMasks.includes(node.id)}
                    onChange={(event) =>
                      setMaskIds((ids) =>
                        event.target.checked
                          ? [...ids, node.id]
                          : ids.filter((id) => id !== node.id),
                      )
                    }
                  />
                  <span>
                    {node.label}
                    <small>16-bit PNG · fixed 0–1 weights</small>
                  </span>
                </label>
              ))}
            </div>
          )}
        </section>

        <section
          className="we-export-section"
          ref={review}
          tabIndex={-1}
          aria-label="World package checks"
        >
          <div className="we-export-section-title">
            <span>04</span>
            <h3>Review & deliver</h3>
          </div>
          <div className="we-export-package">
            <PackageCheck size={19} />
            <div>
              <strong>
                {estimate
                  ? `${mib(estimate.archiveBytes)} estimated archive`
                  : 'Package needs attention'}
              </strong>
              <small>
                {estimate
                  ? `${number(plan.files, 0)} files · ${number(plan.mapCount, 0)} maps per tile`
                  : 'Resolve the issue below to continue.'}
              </small>
            </div>
          </div>
          <DestinationPlan title="Browser download" plan={plan.memory} onReduce={setSamples} />
          <DestinationPlan
            title="Direct file save"
            plan={plan.file}
            available={supportsFile}
            onReduce={setSamples}
          />
          {!supportsFile && (
            <p className="we-export-caption">
              Direct file save is unavailable in this browser. Use a browser download; reduce
              samples or select a region if needed.
            </p>
          )}
          <p className="we-export-caption">
            Memory and archive sizes are conservative estimates. Direct saving writes tiles as they
            finish, keeping the archive out of browser memory.
          </p>
        </section>
        <div className="we-export-action-dock" role="group" aria-label="Deliver world package">
          <div>
            <span>
              {estimate
                ? `${number(shownOptions.samplesX, 0)} × ${number(shownOptions.samplesZ, 0)} · ${mib(estimate.archiveBytes)} est.`
                : 'Settings need attention'}
            </span>
            <button
              type="button"
              className="we-export-text-button"
              onClick={() => {
                review.current?.focus({ preventScroll: true });
                review.current?.scrollIntoView({
                  block: 'start',
                  behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
                    ? 'instant'
                    : 'smooth',
                });
              }}
            >
              Review <ArrowUpRight size={12} />
            </button>
          </div>
          <button
            type="button"
            className="we-export-button primary"
            disabled={busy || !!plan.memory.error}
            onClick={() => start('memory')}
          >
            <ArrowDownToLine size={15} />
            Download world package
          </button>
          {supportsFile && (
            <button
              type="button"
              className="we-export-button secondary"
              disabled={busy || !!plan.file.error}
              onClick={() => start('file')}
            >
              <ArrowUpRight size={15} />
              Save directly to file
            </button>
          )}
          {(plan.memory.error || plan.file.error) && (
            <p className="we-export-caption">
              {plan.memory.error && !plan.file.error && supportsFile
                ? 'Direct file save is available for this package.'
                : 'Review the package checks to resolve blocked actions.'}
            </p>
          )}
        </div>
      </fieldset>
    </div>
  );
}
