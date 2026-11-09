import { useState } from 'react';
import {
  SlidersHorizontal,
  Sun,
  Eye,
  Copy,
  Trash2,
  ChevronDown,
  ArrowUpRight,
  MountainSnow,
  Route,
  RotateCcw,
  Plus,
  ArrowDownUp,
} from 'lucide-react';
import { NODE_DEFINITIONS } from '../model/registry';
import { resolveSurface } from '../materials/pbr';
import { DEFAULT_SPLINE_PATH, MAX_SPLINE_POINTS, insertSplinePoint } from '../model/splines';
import type { SplinePoint } from '../model/splines';
import { NumberField, ParamControl } from './Controls';
import type { TerrainNode, TerrainProject, ParamValue, ViewSettings } from '../model/types';

interface Props {
  splineEditing: boolean;
  onSplinePath: (path: SplinePoint[]) => void;
  onSplineEdit: () => void;
  node: TerrainNode | null;
  project: TerrainProject;
  previewNodeId?: string;
  onParam: (key: string, value: ParamValue) => void;
  onRename: (label: string) => void;
  onBypass: () => void;
  onPreview: (id: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onProjectChange: (patch: Partial<TerrainProject>) => void;
  settings: ViewSettings;
  onSettingsChange: (settings: ViewSettings) => void;
  onClose?: () => void;
}
export function Inspector({
  splineEditing,
  onSplinePath,
  onSplineEdit,
  node,
  project,
  previewNodeId,
  onParam,
  onRename,
  onBypass,
  onPreview,
  onDuplicate,
  onDelete,
  onProjectChange,
  settings,
  onSettingsChange,
}: Props) {
  const [tab, setTab] = useState<'node' | 'scene'>('node');
  const definition = node ? NODE_DEFINITIONS[node.kind] : null;
  const surface = resolveSurface(project.surface);
  const sections = definition
    ? [...new Set(definition.params.map((p) => p.section ?? 'Parameters'))]
    : [];
  return (
    <aside className="inspector panel" aria-label="Parameter inspector">
      <div className="panel-tabs">
        <button className={tab === 'node' ? 'active' : ''} onClick={() => setTab('node')}>
          <SlidersHorizontal size={14} />
          Inspector
        </button>
        <button className={tab === 'scene' ? 'active' : ''} onClick={() => setTab('scene')}>
          <Sun size={14} />
          Scene
        </button>
      </div>
      <div className="inspector-scroll">
        {tab === 'node' ? (
          node && definition ? (
            <>
              <div className="inspector-heading">
                <div className="eyebrow" style={{ color: definition.color }}>
                  {definition.category} / {definition.label}
                </div>
                <input
                  className="node-title-input"
                  aria-label="Node name"
                  value={node.label}
                  maxLength={100}
                  onChange={(e) => onRename(e.target.value)}
                />
                <p>{definition.description}</p>
              </div>
              {node.kind !== 'note' &&
                node.kind !== 'group' &&
                node.kind !== 'output' &&
                definition.inputs.length > 0 && (
                  <label className="toggle-row node-enabled">
                    <span>Node enabled</span>
                    <input
                      aria-label="Node enabled"
                      type="checkbox"
                      checked={!node.bypassed}
                      onChange={onBypass}
                    />
                    <span className="switch" aria-hidden="true" />
                  </label>
                )}
              {sections.map((section) => (
                <details
                  className="parameter-section"
                  key={`${node.id}-${section}`}
                  open={
                    section !== 'Advanced' && section !== 'Randomness' && section !== 'Transform'
                  }
                >
                  <summary>
                    {section}
                    <ChevronDown size={13} />
                  </summary>
                  <div>
                    {definition.params
                      .filter((p) => (p.section ?? 'Parameters') === section)
                      .map((d) => (
                        <ParamControl
                          key={`${node.id}-${d.key}`}
                          definition={d}
                          value={node.params[d.key] ?? d.default}
                          onChange={(v) => onParam(d.key, v)}
                        />
                      ))}
                  </div>
                </details>
              ))}
              {node.kind === 'spline' && (() => {
                const points = node.path ?? DEFAULT_SPLINE_PATH;
                const changePoint = (index: number, coord: 'x' | 'y', percent: number) => {
                  if (!Number.isFinite(percent)) return;
                  onSplinePath(points.map((point, i) =>
                    i === index ? { ...point, [coord]: Math.max(0, Math.min(1, percent / 100)) } : { ...point },
                  ));
                };
                const addPoint = () => {
                  if (points.length >= MAX_SPLINE_POINTS) return;
                  let segment = 0, longest = -1;
                  for (let i = 0; i < points.length - 1; i++) {
                    const length = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
                    if (length > longest) { longest = length; segment = i; }
                  }
                  const point = {
                    x: (points[segment].x + points[segment + 1].x) / 2,
                    y: (points[segment].y + points[segment + 1].y) / 2,
                  };
                  onSplinePath(insertSplinePoint(points, point));
                };
                return (
                  <section className="spline-editor" aria-label="Spline path editor">
                    <div className="spline-editor-heading">
                      <Route size={15} />
                      <strong>Path designer</strong>
                      <span>{points.length} points</span>
                    </div>
                    <button
                      type="button"
                      className={`button ${splineEditing ? 'primary' : 'secondary'} spline-edit-button`}
                      aria-pressed={splineEditing}
                      onClick={onSplineEdit}
                    >
                      <Route size={14} />
                      {splineEditing ? 'Finish editing' : 'Edit path on 2D map'}
                    </button>
                    <p className="spline-help">
                      {splineEditing
                        ? 'Drag handles to reshape the path. Click the map to insert a point near the closest segment. First point is upstream.'
                        : 'Switch to edit mode to draw directly over your terrain. The spline is saved with the project and evaluated before downstream erosion.'}
                    </p>
                    <div className="spline-edit-actions">
                      <button type="button" onClick={addPoint} disabled={points.length >= MAX_SPLINE_POINTS}>
                        <Plus size={12} /> Add point
                      </button>
                      <button type="button" onClick={() => onSplinePath([...points].reverse())}>
                        <ArrowDownUp size={12} /> Reverse
                      </button>
                      <button type="button" onClick={() => onSplinePath(DEFAULT_SPLINE_PATH.map((p) => ({ ...p })))}>
                        <RotateCcw size={12} /> Reset
                      </button>
                    </div>
                    <div className="spline-point-list" aria-label="Control point coordinates">
                      {points.map((point, index) => (
                        <div className="spline-point-row" key={index}>
                          <span className="spline-point-number">{String(index + 1).padStart(2, '0')}</span>
                          <label>
                            X
                            <input
                              type="number"
                              min={0}
                              max={100}
                              step={0.1}
                              aria-label={`Point ${index + 1} X percent`}
                              value={+(point.x * 100).toFixed(1)}
                              onChange={(event) => changePoint(index, 'x', Number(event.target.value))}
                            />
                          </label>
                          <label>
                            Y
                            <input
                              type="number"
                              min={0}
                              max={100}
                              step={0.1}
                              aria-label={`Point ${index + 1} Y percent`}
                              value={+(point.y * 100).toFixed(1)}
                              onChange={(event) => changePoint(index, 'y', Number(event.target.value))}
                            />
                          </label>
                          <button
                            type="button"
                            aria-label={`Remove spline point ${index + 1}`}
                            title={points.length <= 2 ? 'Keep at least two points' : 'Remove point'}
                            disabled={points.length <= 2}
                            onClick={() => onSplinePath(points.filter((_, i) => i !== index).map((p) => ({ ...p })))}
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </section>
                );
              })()}
              {node.kind === 'hydraulic' && (
                <div className="inspector-tip">
                  <span className="tip-dot" />
                  <div>
                    <strong>Follow the water</strong>
                    <p>
                      Use the 2D Flow, Wear, and Deposit maps to inspect how rainfall changes the
                      surface.
                    </p>
                  </div>
                </div>
              )}
              {node.kind === 'output' && (
                <div className="output-summary">
                  <MountainSnow size={25} />
                  <strong>One connected landscape.</strong>
                  <p>
                    All upstream nodes contribute to this output. Export regenerates the graph at
                    the resolution you choose.
                  </p>
                  <dl>
                    <div>
                      <dt>Working grid</dt>
                      <dd>
                        {project.resolution} × {project.resolution}
                      </dd>
                    </div>
                    <div>
                      <dt>Terrain extent</dt>
                      <dd>{(project.worldSize / 1000).toFixed(1)} km</dd>
                    </div>
                    <div>
                      <dt>Height scale</dt>
                      <dd>{project.heightScale.toLocaleString()} m</dd>
                    </div>
                  </dl>
                </div>
              )}
            </>
          ) : (
            <div className="empty-inspector">
              <SlidersHorizontal size={25} />
              <h3>Inspect your process</h3>
              <p>
                Select a node in the graph to edit its parameters. Preview any stage without
                changing the output.
              </p>
            </div>
          )
        ) : (
          <>
            <div className="inspector-heading">
              <div className="eyebrow">WORKSPACE / DISPLAY</div>
              <h2>Scene settings</h2>
              <p>Set the terrain’s physical extent and how its surface is shown in the viewport.</p>
            </div>
            <section className="parameter-section open">
              <h3>Terrain dimensions</h3>
              <div className="parameter">
                <div className="parameter-top">
                  <label>Tile width</label>
                  <NumberField
                    value={project.worldSize}
                    min={100}
                    max={100000}
                    step={100}
                    label="Terrain tile width"
                    unit="m"
                    onChange={(worldSize) => onProjectChange({ worldSize })}
                  />
                </div>
                <p className="parameter-hint">
                  Square terrain extent. Used for elevation sampling and normal-map export.
                </p>
              </div>
              <div className="parameter">
                <div className="parameter-top">
                  <label>Elevation scale</label>
                  <NumberField
                    value={project.heightScale}
                    min={10}
                    max={20000}
                    step={100}
                    label="Terrain elevation scale"
                    unit="m"
                    onChange={(heightScale) => onProjectChange({ heightScale })}
                  />
                </div>
              </div>
            </section>
            <section className="parameter-section open">
              <h3>Surface & light</h3>
              <ParamControl
                definition={{
                  key: 'material',
                  label: 'Surface material',
                  type: 'select',
                  default: 'pbr',
                  options: [
                    { value: 'pbr', label: 'PBR · layered physical material' },
                    { value: 'alpine', label: 'Alpine · rock & snow' },
                    { value: 'clay', label: 'Clay · neutral relief' },
                    { value: 'height', label: 'Elevation · hypsometric' },
                  ],
                }}
                value={settings.material}
                onChange={(v) =>
                  onSettingsChange({ ...settings, material: v as ViewSettings['material'] })
                }
              />
              <ParamControl
                definition={{
                  key: 'sunAzimuth',
                  label: 'Sun direction',
                  type: 'range',
                  default: 315,
                  min: 0,
                  max: 360,
                  step: 1,
                  unit: '°',
                }}
                value={settings.sunAzimuth}
                onChange={(v) => onSettingsChange({ ...settings, sunAzimuth: Number(v) })}
              />
              <ParamControl
                definition={{
                  key: 'sunElevation',
                  label: 'Sun elevation',
                  type: 'range',
                  default: 38,
                  min: 5,
                  max: 85,
                  step: 1,
                  unit: '°',
                }}
                value={settings.sunElevation}
                onChange={(v) => onSettingsChange({ ...settings, sunElevation: Number(v) })}
              />
              <ParamControl
                definition={{
                  key: 'exaggeration',
                  label: 'Vertical exaggeration',
                  type: 'range',
                  default: 1,
                  min: 0.25,
                  max: 3,
                  step: 0.05,
                  unit: '×',
                  description: 'Display only. Exported elevation values are unchanged.',
                }}
                value={settings.exaggeration}
                onChange={(v) => onSettingsChange({ ...settings, exaggeration: Number(v) })}
              />
              <ParamControl
                definition={{
                  key: 'contours',
                  label: 'Contour lines',
                  type: 'toggle',
                  default: false,
                }}
                value={settings.contours}
                onChange={(v) => onSettingsChange({ ...settings, contours: Boolean(v) })}
              />
              <ParamControl
                definition={{
                  key: 'wireframe',
                  label: 'Wireframe',
                  type: 'toggle',
                  default: false,
                }}
                value={settings.wireframe}
                onChange={(v) => onSettingsChange({ ...settings, wireframe: Boolean(v) })}
              />
              <ParamControl
                definition={{
                  key: 'autoRotate',
                  label: 'Slow orbit',
                  type: 'toggle',
                  default: false,
                }}
                value={settings.autoRotate}
                onChange={(v) => onSettingsChange({ ...settings, autoRotate: Boolean(v) })}
              />
            </section>
            <section className="parameter-section open">
              <h3>PBR material studio</h3>
              <p className="parameter-hint">These settings control exported PBR textures and the live PBR preview. Changing them does not rerun terrain erosion.</p>
              <ParamControl
                definition={{
                  key: 'biome', label: 'Material biome', type: 'select',
                  default: 'alpine',
                  options: [
                    { value: 'alpine', label: 'Alpine / temperate' },
                    { value: 'arid', label: 'Arid / desert' },
                    { value: 'volcanic', label: 'Volcanic rock' },
                  ],
                }}
                value={surface.biome}
                onChange={v => onProjectChange({ surface: { ...surface, biome: v as typeof surface.biome } })}
              />
              {([
                { key: 'snowLine', label: 'Snow-line elevation', min: 0.35, max: 1, step: 0.01,
                  description: 'Relative to the generated terrain elevation range.' },
                { key: 'rockSlope', label: 'Exposed rock slope', min: 12, max: 75, step: 1, unit: '°',
                  description: 'Surface angle where vegetation gives way to exposed rock.' },
                { key: 'moisture', label: 'Environmental moisture', min: 0, max: 1, step: 0.01,
                  description: 'Controls vegetation coverage and wet surface response.' },
                { key: 'detailMeters', label: 'Surface detail scale', min: 4, max: 200, step: 1, unit: 'm',
                  description: 'Approximate spatial wavelength of generated microstructure.' },
                { key: 'detailStrength', label: 'Microdetail depth', min: 0, max: 2, step: 0.05,
                  description: 'Scales micro-normal relief without changing macro terrain elevation.' },
                { key: 'aoStrength', label: 'Terrain occlusion', min: 0, max: 1, step: 0.05,
                  description: 'Strength of multi-scale terrain cavity AO.' },
              ] as const).map(control => (
                <ParamControl
                  key={control.key}
                  definition={{ ...control, type: 'range', default: surface[control.key] }}
                  value={surface[control.key]}
                  onChange={v => onProjectChange({
                    surface: { ...surface, [control.key]: Number(v) },
                  })}
                />
              ))}
            </section>
            <div className="inspector-tip">
              <ArrowUpRight size={17} />
              <p>
                Lighting, material, and exaggeration affect the preview. Your exported heights
                retain the project’s elevation scale.
              </p>
            </div>
          </>
        )}
      </div>
      {tab === 'node' && node && (
        <div className="inspector-actions">
          {node.kind !== 'note' && node.kind !== 'group' && (
            <button
              className="button secondary preview-node-button"
              onClick={() => onPreview(node.id)}
            >
              <Eye size={14} />
              {previewNodeId === node.id ? 'Viewing this node' : 'Preview this node'}
            </button>
          )}
          <div className="inspector-edit-actions">
            <button
              onClick={onDuplicate}
              disabled={node.kind === 'output' || node.kind === 'group'}
              title="Duplicate selected node"
            >
              <Copy size={13} />
              Duplicate
            </button>
            <button onClick={onDelete} title="Delete selected node">
              <Trash2 size={13} />
              Delete
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
