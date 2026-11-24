import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpRight, Check, Compass, Cpu, Download, Expand, Globe2, Grid2X2, LoaderCircle, Map, Play, Scan, Settings2, X } from 'lucide-react';
import { Modal } from './Modal';
import { paintWorldMap } from './worldMap';
import type { WorldMapChannel } from './worldMap';
import { createWorldDefinition, validateWorldDefinition } from '../model/world';
import type { WorldDefinition, WorldDomain } from '../model/world';
import type { TerrainProject } from '../model/types';
import type { WorldRegionResult } from '../engine/world';
import type { WorldGridRequest, WorldWorkerResponse } from '../hooks/worldProtocol';
import type { WorldRegionStoreStats } from '../engine/worldStore';
import type { ComputeCapability } from '../engine/gpu/pointwise';
import { downloadBlob, slug } from '../model/project';
import { checkWorldExportBudget } from '../export/worldExport';
import type { WorldExportOptions } from '../export/worldExport';
import './WorldStudio.css';

type Region = Pick<WorldGridRequest, 'startX' | 'startZ' | 'cellsX' | 'cellsZ'>;
type Tab = 'domain' | 'build' | 'export';
const number = (value: number, digits = 1) => value.toLocaleString('en-US', { maximumFractionDigits: digits });
const mib = (bytes: number) => `${number(bytes / 1048576)} MiB`;
const boundaryLabel = { closed: 'Closed perimeter', open: 'Open outlets', periodic: 'Periodic world' };

function NumberField({ label, value, onChange, min, max, step = 1, unit = 'm' }: {
  label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number; unit?: string;
}) {
  return <label className="world-field"><span>{label}</span><span className="world-number"><input aria-label={label} type="number" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} /><small>{unit}</small></span></label>;
}

interface FileWriter { write(data: ArrayBuffer): Promise<void>; close(): Promise<void>; abort(): Promise<void> }
type PickerWindow = Window & { showSaveFilePicker?: (options: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<{ createWritable(): Promise<FileWriter> }> };

export function WorldStudio({ project, onSave, onClose }: {
  project: TerrainProject; onSave: (world: WorldDefinition) => void; onClose: () => void;
}) {
  const [world, setWorld] = useState<WorldDefinition>(() => structuredClone(project.world ?? createWorldDefinition(project)));
  const [tab, setTab] = useState<Tab>('domain');
  const [result, setResult] = useState<WorldRegionResult | null>(null);
  const [builtWorld, setBuiltWorld] = useState<WorldDefinition>(world);
  const [builtGrid, setBuiltGrid] = useState<Region | null>(null);
  const [builtSignature, setBuiltSignature] = useState('');
  const [region, setRegion] = useState<Region | null>(null);
  const [channel, setChannel] = useState<WorldMapChannel>('relief');
  const [gridVisible, setGridVisible] = useState(true);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState('Preparing world overview');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [savedWorld, setSavedWorld] = useState(JSON.stringify(project.world));
  const [format, setFormat] = useState<'png16' | 'raw32' | 'raw16'>('png16');
  const [profile, setProfile] = useState<'generic' | 'unreal' | 'unity'>('generic');
  const [samples, setSamples] = useState(1024);
  const [exportRegion, setExportRegion] = useState(false);
  const [diagnostics, setDiagnostics] = useState(true);
  const [normals, setNormals] = useState(true);
  const [maskIds, setMaskIds] = useState<string[]>([]);
  const [cacheEnabled, setCacheEnabled] = useState(false);
  const [storeStats, setStoreStats] = useState<WorldRegionStoreStats | null>(null);
  const [cacheHit, setCacheHit] = useState(false);
  const [compute, setCompute] = useState<ComputeCapability | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const worker = useRef<Worker | null>(null);
  const encoder = useRef<Worker | null>(null);
  const writer = useRef<FileWriter | null>(null);
  const epoch = useRef(0);
  const exportEpoch = useRef(0);
  const building = useRef(false);
  const dragStart = useRef<{ x: number; z: number } | null>(null);
  const signature = JSON.stringify(world);
  const validation = validateWorldDefinition(world);
  const stale = result !== null && builtSignature !== signature;
  const domain = world.domain;
  const patch = (value: Partial<WorldDefinition>) => { setWorld(w => ({ ...w, ...value })); setSuccess(''); };
  const patchDomain = (value: Partial<WorldDomain>) => { setWorld(w => ({ ...w, domain: { ...w.domain, ...value } })); setSuccess(''); setRegion(null); };
  const cancelBuild = () => {
    ++epoch.current;
    worker.current?.terminate(); worker.current = null; building.current = false;
    setBusy(false); setStage('Build cancelled — last complete field retained');
  };
  const cancelExport = () => {
    ++exportEpoch.current;
    encoder.current?.terminate(); encoder.current = null;
    void writer.current?.abort().catch(() => {}); writer.current = null;
    setExporting(false); setStage('Export cancelled');
  };
  useEffect(() => () => {
    ++epoch.current; ++exportEpoch.current;
    worker.current?.terminate(); encoder.current?.terminate();
    void writer.current?.abort().catch(() => {});
  }, []);
  const runPreview = (selected: Region | null = null) => {
    if (validation) { setError(validation); return; }
    if (building.current) { worker.current?.terminate(); worker.current = null; }
    const active = worker.current ?? new Worker(new URL('../engine/world.worker.ts', import.meta.url), { type: 'module' });
    worker.current = active;
    building.current = true;
    const id = ++epoch.current;
    const snapshot = structuredClone(world);
    const area = selected ?? { startX: 0, startZ: 0, cellsX: domain.cellsX, cellsZ: domain.cellsZ };
    const width = area.cellsX / domain.cellsX * domain.width;
    const depth = area.cellsZ / domain.cellsZ * domain.depth;
    const longest = selected ? Math.min(512, Math.max(area.cellsX, area.cellsZ)) : 384;
    const samplesX = Math.max(2, Math.round(longest * Math.min(1, width / depth)) + 1);
    const samplesZ = Math.max(2, Math.round(longest * Math.min(1, depth / width)) + 1);
    setBusy(true); setError(''); setSuccess(''); setProgress(0); setStage('Preparing dependency graph');
    active.onmessage = (event: MessageEvent<WorldWorkerResponse>) => {
      const message = event.data;
      if (message.id !== epoch.current) return;
      if (message.type === 'progress') { setProgress(message.progress); setStage(message.stage); }
      else {
        building.current = false; setBusy(false);
        if (message.type === 'error') { setError(message.message); setStage('World needs attention'); }
        else {
          setResult(message.result); setBuiltWorld(snapshot); setBuiltGrid(selected); setBuiltSignature(JSON.stringify(snapshot));
          setStoreStats(message.store ?? null); setCacheHit(message.cacheHit); setCompute(message.compute ?? null); setWarnings(message.warnings ?? []);
          setProgress(1); setStage(selected ? 'Region ready' : 'World overview ready');
        }
      }
    };
    active.onerror = event => {
      if (id !== epoch.current) return;
      building.current = false; setBusy(false); setError(event.message || 'World worker stopped. Try a smaller global reference grid.');
      active.terminate(); worker.current = null;
    };
    active.postMessage({ type: 'preview', id, project, world: snapshot, grid: { ...area, samplesX, samplesZ }, cache: cacheEnabled });
  };
  useEffect(() => { runPreview(); }, []); // A deliberate build, not a rebuild on every field keystroke.
  useEffect(() => { if (canvas.current && result) paintWorldMap(canvas.current, result, channel, builtWorld.domain.heightScale); }, [result, channel, builtWorld]);

  const dimensions = profile === 'unreal' ? [505, 1009, 2017, 4033, 8129] : profile === 'unity' ? [513, 1025, 2049, 4097] : [512, 1024, 2048, 4096, 8192];
  const target = exportRegion && region ? region : { startX: 0, startZ: 0, cellsX: domain.cellsX, cellsZ: domain.cellsZ };
  const targetAspect = (target.cellsZ / domain.cellsZ * domain.depth) / (target.cellsX / domain.cellsX * domain.width);
  const exportSamplesZ = profile === 'generic' ? Math.max(16, Math.min(8192, Math.round((samples - 1) * targetAspect) + 1)) : samples;
  const exportOptions = useMemo(() => ({
    project, world, format, profile, samplesX: samples, samplesZ: exportSamplesZ,
    tileIntervals: world.tileCells, region: exportRegion && region ? region : undefined,
    diagnostics, normals, masks: project.graph.nodes.filter(n => maskIds.includes(n.id)).map(n => ({ nodeId: n.id, name: n.label })), sink: 'memory',
  } satisfies WorldExportOptions), [project, world, format, profile, samples, exportSamplesZ, exportRegion, region, diagnostics, normals, maskIds]);
  const estimate = useMemo(() => { try { const value = checkWorldExportBudget(exportOptions); if (value.archiveBytes > 192 * 1048576) throw new Error('Use Save directly to file for archives above the 192 MiB download budget.'); return { value, error: '' }; } catch (e) { return { value: null, error: e instanceof Error ? e.message : 'Invalid export settings.' }; } }, [exportOptions]);
  const runExport = async (toFile: boolean) => {
    if (validation) { setError(validation); return; }
    const id = ++exportEpoch.current;
    let output: FileWriter | null = null;
    try {
      if (toFile) {
        const handle = await (window as PickerWindow).showSaveFilePicker!({ suggestedName: `${slug(project.name)}-world-${samples}.zip`, types: [{ description: 'World package', accept: { 'application/zip': ['.zip'] } }] });
        output = await handle.createWritable();
        if (id !== exportEpoch.current) { await output.abort(); return; }
        writer.current = output;
      }
      const options = { ...exportOptions, sink: toFile ? 'file' : 'memory' } as WorldExportOptions;
      checkWorldExportBudget(options);
      const active = new Worker(new URL('../export/worldExport.worker.ts', import.meta.url), { type: 'module' });
      encoder.current = active;
      const chunks: ArrayBuffer[] = [];
      let bytes = 0;
      setExporting(true); setError(''); setSuccess(''); setProgress(0); setStage('Planning world package');
      const fail = (message: string) => {
        if (id !== exportEpoch.current) return;
        active.terminate(); encoder.current = null;
        void output?.abort().catch(() => {}); writer.current = null;
        chunks.length = 0; setExporting(false); setError(message);
      };
      active.onmessage = async (event: MessageEvent) => {
        const message = event.data;
        if (message.id !== exportEpoch.current) return;
        try {
          if (message.type === 'progress') { setProgress(message.progress); setStage(message.stage); }
          else if (message.type === 'chunk') {
            bytes += message.bytes.byteLength;
            if (output) await output.write(message.bytes);
            else {
              if (bytes > 192 * 1048576) throw new Error('The archive exceeded the in-memory download budget. Use Save directly to file or a smaller region.');
              chunks.push(message.bytes);
            }
            if (id === exportEpoch.current) active.postMessage({ type: 'ack', id, sequence: message.sequence });
          } else if (message.type === 'error') fail(message.message);
          else if (message.type === 'complete') {
            if (output) await output.close();
            else downloadBlob(new Blob(chunks, { type: 'application/zip' }), message.filename);
            writer.current = null; chunks.length = 0; active.terminate(); encoder.current = null;
            setExporting(false); setProgress(1); setStage('World package ready'); setSuccess(`${message.filename} · ${mib(bytes)}`);
          }
        } catch (e) { fail(e instanceof Error ? e.message : 'Could not save the world package.'); }
      };
      active.onerror = event => fail(event.message || 'World export stopped unexpectedly.');
      active.postMessage({ type: 'export', id, options });
    } catch (e) {
      void output?.abort().catch(() => {}); writer.current = null;
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setError(e instanceof Error ? e.message : 'Could not start world export.'); setExporting(false);
    }
  };

  const selectAt = (event: React.PointerEvent<HTMLDivElement>, start = false) => {
    if (!result || builtGrid || stale || busy) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = Math.min(domain.cellsX - 1, Math.max(0, (event.clientX - bounds.left) / bounds.width * domain.cellsX));
    const z = Math.min(domain.cellsZ - 1, Math.max(0, (event.clientY - bounds.top) / bounds.height * domain.cellsZ));
    const tx = Math.floor(x / world.tileCells), tz = Math.floor(z / world.tileCells);
    if (start) { dragStart.current = { x: tx, z: tz }; event.currentTarget.setPointerCapture(event.pointerId); }
    const anchor = dragStart.current;
    if (!anchor) return;
    const startX = Math.min(anchor.x, tx) * world.tileCells, startZ = Math.min(anchor.z, tz) * world.tileCells;
    setRegion({ startX, startZ, cellsX: Math.min(domain.cellsX, (Math.max(anchor.x, tx) + 1) * world.tileCells) - startX, cellsZ: Math.min(domain.cellsZ, (Math.max(anchor.z, tz) + 1) * world.tileCells) - startZ });
  };
  const tileCount = Math.ceil(domain.cellsX / world.tileCells) * Math.ceil(domain.cellsZ / world.tileCells);
  const selectedWidth = region ? region.cellsX / domain.cellsX * domain.width : domain.width;
  const selectedDepth = region ? region.cellsZ / domain.cellsZ * domain.depth : domain.depth;
  const viewedWidth = builtGrid ? builtGrid.cellsX / builtWorld.domain.cellsX * builtWorld.domain.width : builtWorld.domain.width;
  const viewedDepth = builtGrid ? builtGrid.cellsZ / builtWorld.domain.cellsZ * builtWorld.domain.depth : builtWorld.domain.depth;
  const mapRatio = Math.max(0.2, Math.min(5, viewedWidth / viewedDepth));
  const gridX = Math.ceil(builtWorld.domain.cellsX / builtWorld.tileCells), gridZ = Math.ceil(builtWorld.domain.cellsZ / builtWorld.tileCells);
  const gridStrideX = Math.max(1, Math.ceil(gridX / 64)), gridStrideZ = Math.max(1, Math.ceil(gridZ / 64));
  const warningStages = result?.stages.filter(s => s.mode !== 'native') ?? [];
  return <Modal title="World Studio" eyebrow="NORMAL HEIGHT / WORLD ENGINE" onClose={onClose} className="world-modal">
    <div className="world-heading"><div><Globe2 size={17} /><strong>{project.name}</strong><span>seed {project.seed}</span></div><span className="world-badge">{project.version === 2 ? 'WORLD PROJECT' : 'WORLD PREVIEW'}</span></div>
    <div className="world-layout">
      <aside className="world-sidebar">
        <div className="world-tabs" role="tablist" aria-label="World tools">{(['domain', 'build', 'export'] as Tab[]).map(t => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t === 'domain' ? <Globe2 size={14} /> : t === 'build' ? <Cpu size={14} /> : <Download size={14} />}{t === 'domain' ? 'World' : t === 'build' ? 'Compute' : 'Export'}</button>)}</div>
        <div className="world-controls">
          {tab === 'domain' && <>
            <div className="world-section-label">01 / PHYSICAL DOMAIN</div>
            <h3>A world, in meters.</h3><p className="world-intro">One continuous coordinate system. Refine a region without moving its terrain.</p>
            <div className="world-two"><NumberField label="World width" value={domain.width} min={1} onChange={width => patchDomain({ width })} /><NumberField label="World depth" value={domain.depth} min={1} onChange={depth => patchDomain({ depth })} /></div>
            <div className="world-two"><NumberField label="Origin east" value={domain.originX} onChange={originX => patchDomain({ originX })} /><NumberField label="Origin south" value={domain.originZ} onChange={originZ => patchDomain({ originZ })} /></div>
            <div className="world-two"><NumberField label="Height scale" value={domain.heightScale} min={1} onChange={heightScale => patchDomain({ heightScale })} /><NumberField label="Vertical datum" value={domain.datum} onChange={datum => patchDomain({ datum })} /></div>
            <div className="world-section-label">02 / SAMPLE GRID</div>
            <div className="world-two"><NumberField label="East intervals" value={domain.cellsX} min={1} max={32768} unit="cells" onChange={cellsX => patchDomain({ cellsX })} /><NumberField label="South intervals" value={domain.cellsZ} min={1} max={32768} unit="cells" onChange={cellsZ => patchDomain({ cellsZ })} /></div>
            <label className="world-field"><span>Tile intervals</span><select aria-label="World tile intervals" value={world.tileCells} onChange={e => { patch({ tileCells: Number(e.target.value) }); setRegion(null); }}>{[64, 128, 256, 512].map(n => <option key={n} value={n}>{n} cells / {n + 1} shared samples</option>)}</select></label>
            <label className="world-field"><span>Outer boundary</span><select aria-label="World boundary" value={domain.boundary} onChange={e => patchDomain({ boundary: e.target.value as WorldDomain['boundary'] })}>{Object.entries(boundaryLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
            <div className="world-note"><Grid2X2 size={16} /><span>{number(domain.cellsX + 1, 0)} × {number(domain.cellsZ + 1, 0)} samples · {number(tileCount, 0)} tiles<br />{number(domain.width / domain.cellsX, 3)} × {number(domain.depth / domain.cellsZ, 3)} m spacing</span></div>
            <button className="button world-save" disabled={Boolean(validation) || signature === savedWorld} onClick={() => { onSave(structuredClone(world)); setSavedWorld(signature); setSuccess('World setup saved. Undo in the editor restores the previous project.'); }}><Check size={14} />{project.version === 2 ? 'Save world setup' : 'Enable World project'}</button>
            <p className="world-footnote">World setup is saved as project v2. The original terrain graph and its versioned algorithms are preserved. This change is undoable.</p>
          </>}
          {tab === 'build' && <>
            <div className="world-section-label">COMPUTE / QUALITY</div><h3>See what actually ran.</h3><p className="world-intro">Each stage records its backend and physical sampling. Coarse simulations remain visible in the build report.</p>
            <label className="world-field"><span>Compute preference</span><select aria-label="World compute backend" value={world.backend} onChange={e => patch({ backend: e.target.value as WorldDefinition['backend'] })}><option value="cpu-reference">CPU reference</option><option value="auto">Auto · qualified stages</option><option value="webgpu">WebGPU · CPU fallback</option></select></label>
            <label className="world-field"><span>Global reference grid</span><select aria-label="Global reference resolution" value={world.globalResolution} onChange={e => patch({ globalResolution: Number(e.target.value) })}>{[64, 128, 256, 512, 1024].map(n => <option key={n} value={n}>{n} × {n} samples</option>)}</select></label>
            <p className="world-footnote">Global and legacy stages share one whole-domain solution. Larger output tiles do not increase their simulation resolution.</p>
            {compute && <p className="world-footnote">{compute.reason}{compute.numerical && ` Maximum probe error: ${compute.numerical.maxAbsoluteError.toExponential(2)}.`}</p>}
            {warnings.map((warning, i) => <p className="world-footnote" key={i}>{warning}</p>)}
            <label className="world-check"><input type="checkbox" checked={cacheEnabled} onChange={e => setCacheEnabled(e.target.checked)} />Remember completed CPU regions</label>
            <p className="world-footnote">Optional local cache, limited to 64 MiB. Stored regions are checked before reuse; unavailable storage falls back to memory.</p>
            {storeStats && <div className="world-note">{storeStats.backend === 'indexeddb' ? 'On-device' : 'Memory'} cache · {storeStats.entries} regions · {mib(storeStats.bytes)}{storeStats.lastError && <span>{storeStats.lastError}</span>}</div>}
            <button className="button secondary" disabled={busy || exporting} onClick={async () => { const { createWorldRegionStore } = await import('../engine/worldStore'); const cache = await createWorldRegionStore(); await cache.clear(); setStoreStats(cache.stats()); await cache.close(); setSuccess('Stored world regions cleared. Authored projects are preserved.'); }}>Clear stored world regions</button>
            <div className="world-metrics"><div><span>Actual backend</span><strong>{result?.backend === 'webgpu' ? 'WebGPU + CPU' : 'CPU reference'}</strong></div><div><span>Region evaluation</span><strong>{cacheHit ? 'Loaded from cache' : result ? `${number(result.duration)} ms` : '—'}</strong></div><div><span>Estimated working peak</span><strong>{result ? mib(result.estimatedPeakBytes) : '—'}</strong></div><div><span>Global / reconstructed</span><strong>{warningStages.length} stages</strong></div></div>
            <button className="button secondary" disabled={!result} onClick={() => downloadBlob(new Blob([JSON.stringify({ application: 'Normal Height World Engine', world: builtWorld, region: builtGrid, stages: result?.stages, backend: result?.backend, duration: result?.duration, estimatedPeakBytes: result?.estimatedPeakBytes, compute, store: storeStats, warnings }, null, 2)], { type: 'application/json' }), 'world-build-report.json')}><ArrowDownToLine size={14} />Download build report</button>
          </>}
          {tab === 'export' && <>
            <div className="world-section-label">WORLD / DELIVERY</div><h3>From graph to world.</h3><p className="world-intro">Aligned tiles, a common elevation range, checksums, and the original project in one package.</p>
            <label className="world-field"><span>Target profile</span><select aria-label="World export profile" value={profile} onChange={e => { const p = e.target.value as typeof profile; setProfile(p); setSamples(p === 'unreal' ? 1009 : p === 'unity' ? 1025 : 1024); setFormat(p === 'unity' ? 'raw16' : 'png16'); }}><option value="generic">Generic Cartesian world</option><option value="unreal">Unreal Landscape · experimental</option><option value="unity">Unity Terrain · experimental</option></select></label>
            <label className="world-field"><span>Height encoding</span><select aria-label="World height format" value={format} onChange={e => setFormat(e.target.value as typeof format)}><option value="png16" disabled={profile === 'unity'}>16-bit PNG / common range</option><option value="raw32" disabled={profile !== 'generic'}>Float32 RAW / meters</option><option value="raw16">UInt16 RAW / little endian</option></select></label>
            <label className="world-field"><span>East sample count</span><select aria-label="World export samples" value={samples} onChange={e => setSamples(Number(e.target.value))}>{dimensions.map(n => <option key={n} value={n}>{number(n, 0)} samples</option>)}</select></label>
            <label className="world-check"><input type="checkbox" checked={exportRegion} disabled={!region} onChange={e => setExportRegion(e.target.checked)} />Selected region only</label>
            <label className="world-check"><input type="checkbox" checked={diagnostics} onChange={e => setDiagnostics(e.target.checked)} />Flow, wear & deposition</label>
            <label className="world-check"><input type="checkbox" checked={normals} onChange={e => setNormals(e.target.checked)} />Terrain normal map</label>
            {project.graph.nodes.filter(n => n.kind === 'mask').map(n => <label key={n.id} className="world-check"><input type="checkbox" checked={maskIds.includes(n.id)} onChange={e => setMaskIds(ids => e.target.checked ? [...ids, n.id] : ids.filter(id => id !== n.id))} />Mask: {n.label}</label>)}
            <div className="world-note"><Map size={16} /><span>{number(samples, 0)} × {number(exportSamplesZ, 0)} output samples<br />{estimate.value ? `${number(estimate.value.tileCount, 0)} tiles · ${mib(estimate.value.peakBytes)} estimated peak` : estimate.error}</span></div>
            <p className="world-footnote">Engine profiles include import settings and remain experimental until a real engine import is verified. Native detail and reconstructed stages are listed in every manifest.</p>
            <button className="button primary" disabled={busy || exporting || Boolean(validation) || Boolean(estimate.error)} onClick={() => void runExport(false)}><Download size={14} />Download world package</button>
            {typeof (window as PickerWindow).showSaveFilePicker === 'function' && <button className="button secondary" disabled={busy || exporting || Boolean(validation)} onClick={() => void runExport(true)}><ArrowUpRight size={14} />Save directly to file</button>}
          </>}
        </div>
      </aside>
      <main className="world-main">
        <div className="world-map-toolbar"><div><Compass size={16} /><span>{builtGrid ? 'Regional detail' : 'World overview'}</span>{stale && <b>Settings changed</b>}</div><div><select aria-label="World map channel" value={channel} onChange={e => setChannel(e.target.value as WorldMapChannel)}><option value="relief">Shaded relief</option><option value="height">Height</option><option value="flow">Flow</option><option value="wear">Wear</option><option value="deposition">Deposition</option></select><button className={`icon-button ${gridVisible ? 'active' : ''}`} aria-label="Show world tile grid" aria-pressed={gridVisible} onClick={() => setGridVisible(v => !v)}><Grid2X2 size={15} /></button><button className="icon-button" aria-label="Save world map image" disabled={!result} onClick={() => canvas.current?.toBlob(blob => { if (blob) downloadBlob(blob, `${slug(project.name)}-world-${channel}.png`); })}><Download size={15} /></button></div></div>
        <div className="world-map-stage">
          <div className="world-compass"><span>N</span><Compass size={30} /><small>+X EAST / +Z SOUTH</small></div>
          <div className="world-map-frame" style={{ aspectRatio: mapRatio }} role="button" aria-label="World region map. Click or drag to select tiles; press Enter to refine." tabIndex={0} onPointerDown={e => selectAt(e, true)} onPointerMove={e => { if (dragStart.current) selectAt(e); }} onPointerUp={() => { dragStart.current = null; }} onPointerCancel={() => { dragStart.current = null; }} onKeyDown={e => {
            if (e.key === 'Enter' && region) { e.preventDefault(); runPreview(region); }
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) || builtGrid) return;
            e.preventDefault();
            const x = Math.max(0, Math.min(domain.cellsX - 1, (region?.startX ?? 0) + (e.key === 'ArrowRight' ? world.tileCells : e.key === 'ArrowLeft' ? -world.tileCells : 0)));
            const z = Math.max(0, Math.min(domain.cellsZ - 1, (region?.startZ ?? 0) + (e.key === 'ArrowDown' ? world.tileCells : e.key === 'ArrowUp' ? -world.tileCells : 0)));
            const startX = Math.floor(x / world.tileCells) * world.tileCells, startZ = Math.floor(z / world.tileCells) * world.tileCells;
            setRegion({ startX, startZ, cellsX: Math.min(world.tileCells, domain.cellsX - startX), cellsZ: Math.min(world.tileCells, domain.cellsZ - startZ) });
          }}>
            <canvas ref={canvas} aria-label="Actual generated world heightfield" />
            {result && gridVisible && !builtGrid && <div className="world-grid" aria-hidden="true">{Array.from({ length: Math.ceil(gridX / gridStrideX) - 1 }, (_, i) => <i key={`x${i}`} style={{ left: `${(i + 1) * gridStrideX * builtWorld.tileCells / builtWorld.domain.cellsX * 100}%` }} />)}{Array.from({ length: Math.ceil(gridZ / gridStrideZ) - 1 }, (_, i) => <i key={`z${i}`} className="horizontal" style={{ top: `${(i + 1) * gridStrideZ * builtWorld.tileCells / builtWorld.domain.cellsZ * 100}%` }} />)}</div>}
            {result && region && !builtGrid && !stale && <div className="world-selection" style={{ left: `${region.startX / domain.cellsX * 100}%`, top: `${region.startZ / domain.cellsZ * 100}%`, width: `${region.cellsX / domain.cellsX * 100}%`, height: `${region.cellsZ / domain.cellsZ * 100}%` }}><span>REGION</span></div>}
            {!result && <div className="world-empty"><Globe2 size={42} /><strong>Your world is taking shape</strong><span>The graph is being evaluated at global coordinates.</span></div>}
          </div>
          {result && <><div className="world-map-caption"><span>{number(viewedWidth / 1000, 2)} × {number(viewedDepth / 1000, 2)} km</span><strong>{builtGrid ? 'REGIONAL DETAIL' : 'CONTINUOUS WORLD'}</strong></div><div className="world-elevation-key"><span>{number(result.max * builtWorld.domain.heightScale + builtWorld.domain.datum, 0)} m</span><i /><span>{number(result.min * builtWorld.domain.heightScale + builtWorld.domain.datum, 0)} m</span></div></>}
        </div>
        <div className="world-selection-bar"><div><Scan size={17} /><span><strong>{region ? 'Region selected' : 'Select a region'}</strong><small>{region ? `${number(selectedWidth)} × ${number(selectedDepth)} m · ${number(region.cellsX + 1, 0)} × ${number(region.cellsZ + 1, 0)} lattice samples` : 'Click a tile or drag across the overview. Arrow keys also select tiles.'}</small></span></div><div>{builtGrid && <button className="button secondary" disabled={busy || exporting} onClick={() => runPreview()}><Expand size={13} />Overview</button>}<button className="button secondary" disabled={!region || busy || exporting || Boolean(validation)} onClick={() => runPreview(region)}><Scan size={13} />Refine region</button><button className="button primary" disabled={exporting || Boolean(validation)} onClick={busy ? cancelBuild : () => runPreview()}>{busy ? <X size={14} /> : <Play size={12} fill="currentColor" />}{busy ? 'Cancel build' : 'Build world'}</button></div></div>
        <details className="world-stage-report"><summary><Settings2 size={14} />Stage report <span>{result?.stages.length ?? 0} stages · {warningStages.length ? `${warningStages.length} use global context` : 'native coordinate sampling'}</span></summary><div className="world-stage-scroll"><table><thead><tr><th>Stage</th><th>Execution</th><th>Backend</th><th>Spacing</th></tr></thead><tbody>{result?.stages.map(s => <tr key={s.nodeId}><td><strong>{s.label}</strong><small>{s.reason}</small></td><td>{s.mode.replaceAll('-', ' ')}{s.simulationResolution && <small>Simulation {s.simulationResolution}²</small>}</td><td>{s.backend === 'webgpu' ? 'WebGPU' : 'CPU'}</td><td>{number(s.spacingX, 2)} × {number(s.spacingZ, 2)} m</td></tr>)}</tbody></table></div></details>
      </main>
    </div>
    <footer className="world-footer"><div className={error || validation ? 'world-status error' : 'world-status'}>{busy || exporting ? <LoaderCircle className="spin" size={14} /> : error || validation ? <X size={14} /> : <Check size={14} />}<span role="status">{error || validation || success || stage}</span></div><div>{(busy || exporting) && <><progress value={progress} max={1} aria-label="World progress" /><span>{Math.round(progress * 100)}%</span></>}{exporting && <button className="button secondary" onClick={cancelExport}>Cancel export</button>}<span className="world-footer-label">{result ? `${result.width} × ${result.height} preview · ${result.backend === 'webgpu' ? 'WebGPU + CPU' : 'CPU reference'}` : 'FLOAT32 / METERS'}</span></div></footer>
  </Modal>;
}
