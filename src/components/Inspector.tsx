import { HeightImportControl } from './HeightImportControl';
import type { HeightRaster } from '../model/heightRaster';
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
  RotateCcw,
  Plus,
  ArrowDownUp,
} from 'lucide-react';
import { NODE_DEFINITIONS, noiseParamVisible } from '../model/registry';
import { upgradeNoiseParams } from '../model/noiseStudio';
import { layerColorHex, resolveSurface, SPLAT_LAYERS } from '../materials/pbr';
import {
  DEFAULT_SPLINE_PATH,
  MAX_SPLINE_POINTS,
  moveSplinePoint,
  splineLength,
  splineFootprint,
  splitLongestSplineSpan,
} from '../model/splines';
import { formatMeters } from '../model/viewportUX';
import type { SplinePoint } from '../model/splines';
import { NumberField, ParamControl } from './Controls';
import { TerrainIcon } from './TerrainIcon';
import { NoiseStudio } from './NoiseStudio';
import type { TerrainNode, TerrainProject, ParamValue, ViewSettings } from '../model/types';

interface Props {
  /** World has its own rendering controls; this inspector edits the shared graph. */
  worldMode?: boolean;
  onImportRaster: (raster: HeightRaster) => void;
  splineEditing: boolean;
  onSplinePath: (path: SplinePoint[]) => void;
  onSplineEdit: () => void;
  node: TerrainNode | null;
  project: TerrainProject;
  previewNodeId?: string;
  onParam: (key: string, value: ParamValue) => void;
  onParams: (patch: Record<string, ParamValue>) => void;
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
  worldMode = false,
  onImportRaster,
  splineEditing,
  onSplinePath,
  onSplineEdit,
  node,
  project,
  previewNodeId,
  onParam,
  onParams,
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
  const activeTab = worldMode ? 'node' : tab;
  const definition = node ? NODE_DEFINITIONS[node.kind] : null;
  const surface = resolveSurface(project.surface);
  const visibleParams =
    node && definition ? definition.params.filter((p) => noiseParamVisible(node, p.key)) : [];
  const sections = [...new Set(visibleParams.map((p) => p.section ?? 'Parameters'))];
  return (
    <aside className="inspector panel" aria-label="Parameter inspector">
      <div className="panel-tabs">
        <button className={activeTab === 'node' ? 'active' : ''} onClick={() => setTab('node')}>
          <SlidersHorizontal size={14} />
          Inspector
        </button>
        {!worldMode && (
          <button className={activeTab === 'scene' ? 'active' : ''} onClick={() => setTab('scene')}>
            <Sun size={14} />
            Scene
          </button>
        )}
      </div>
      <div className="inspector-scroll">
        {activeTab === 'node' ? (
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
                node.kind !== 'maskOutput' &&
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
              {node.kind === 'heightImport' && (
                <HeightImportControl key={node.id} raster={node.raster} onImport={onImportRaster} />
              )}
              {node.kind === 'noise' && node.params.noiseModel !== 'v3' && (
                <div className="studio-upgrade">
                  <span>
                    {node.params.noiseModel === 'v2'
                      ? 'Corrected sampler · v2'
                      : 'Original sampler · legacy'}
                  </span>
                  <p>
                    Upgrade these controls to Noise Studio for new generators, seed exploration and
                    shaping. The new sampler changes the pattern. Undo restores this version.
                  </p>
                  <button type="button" onClick={() => onParams(upgradeNoiseParams(node.params))}>
                    Upgrade to Studio <ArrowUpRight size={14} />
                  </button>
                </div>
              )}
              {node.kind === 'noise' &&
                node.params.mode === 'wave' &&
                !['v2', 'v3'].includes(String(node.params.noiseModel)) && (
                  <p className="parameter-hint">
                    Legacy Wave uses a fixed three-layer phase fractal. Switch to corrected sampling
                    to edit its layers.
                  </p>
                )}
              {node.kind === 'noise' &&
                node.params.mode === 'naki' &&
                !['v2', 'v3'].includes(String(node.params.noiseModel)) && (
                  <p className="parameter-hint">
                    Legacy Naki includes inherent coordinate distortion even at zero Warp amount.
                  </p>
                )}
              {node.kind === 'noise' && node.params.noiseModel === 'v3' ? (
                <NoiseStudio
                  key={node.id}
                  params={node.params}
                  projectSeed={project.seed}
                  worldSize={project.worldSize}
                  heightScale={project.heightScale}
                  onParam={onParam}
                  onParams={onParams}
                />
              ) : (
                sections.map((section) => (
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
                      {visibleParams
                        .filter((p) => (p.section ?? 'Parameters') === section)
                        .map((d) => (
                          <ParamControl
                            key={`${node.id}-${d.key}`}
                            definition={
                              node.kind === 'noise' && d.key === 'noiseModel'
                                ? {
                                    ...d,
                                    options: d.options?.filter((option) => option.value !== 'v3'),
                                  }
                                : d
                            }
                            value={
                              node.params[d.key] ??
                              (node.kind === 'noise' && d.key === 'noiseModel'
                                ? 'legacy'
                                : d.default)
                            }
                            onChange={(v) => onParam(d.key, v)}
                          />
                        ))}
                    </div>
                  </details>
                ))
              )}
              {node.kind === 'spline' && (() => {
                const points = node.path ?? DEFAULT_SPLINE_PATH;
                const percentAt = (point: SplinePoint, coord: 'x' | 'y') =>
                  Number((point[coord] * 100).toFixed(3));
                const changePoint = (index: number, coord: 'x' | 'y', percent: number) => {
                  if (!Number.isFinite(percent) || percent === percentAt(points[index], coord)) return;
                  onSplinePath(moveSplinePoint(points, index, { ...points[index], [coord]: percent / 100 }));
                };
                const pathLength = splineLength(points);
                const footprint = splineFootprint(Number(node.params.width ?? 0.016), Number(node.params.falloff ?? 3));
                const ridge = node.params.mode === 'ridge';
                return (
                  <section className="spline-editor" aria-label="Spline path editor">
                    <div className="spline-editor-heading">
                      <TerrainIcon name="river-ridge-spline" height={15} />
                      <strong>Path designer</strong>
                      <span>{points.length} points</span>
                    </div>
                    <button
                      type="button"
                      className={`button ${splineEditing ? 'primary' : 'secondary'} spline-edit-button`}
                      aria-pressed={splineEditing}
                      onClick={onSplineEdit}
                    >
                      <TerrainIcon name="river-ridge-spline" height={14} />
                      {splineEditing ? 'Finish editing' : 'Edit path on 2D map'}
                    </button>
                    <p className="spline-help">
                      {splineEditing
                        ? 'Click to insert along the nearest curve span; drag empty map space to pan or pinch to zoom. Focus a handle and use arrows (Shift for larger steps). Escape cancels an active drag.'
                        : 'Switch to edit mode to draw directly over your terrain. The spline is saved with the project and evaluated before downstream erosion.'}
                    </p>
                    <dl className="spline-path-metrics" aria-label="Path dimensions">
                      <div><dt>Approx. path length</dt><dd>{formatMeters(pathLength * project.worldSize)}</dd></div>
                      <div><dt>Core radius</dt><dd>{formatMeters(footprint.core * project.worldSize)}</dd></div>
                      <div><dt>Outer reach</dt><dd>{formatMeters(footprint.outer * project.worldSize)}</dd></div>
                    </dl>
                    <p className="spline-help spline-footprint-help">
                      {ridge ? 'Start → end' : 'Headwater → outlet'} · The shaded guide shows the authored core and outer reach, not a simulated water width.
                    </p>
                    <div className="spline-edit-actions">
                      <button type="button"
                        title="Insert halfway along the longest curved span"
                        onClick={() => onSplinePath(splitLongestSplineSpan(points))}
                        disabled={points.length >= MAX_SPLINE_POINTS || pathLength <= 1e-10}>
                        <Plus size={12} /> Add point
                      </button>
                      <button type="button" onClick={() => onSplinePath([...points].reverse())}>
                        <ArrowDownUp size={12} /> Reverse
                      </button>
                      <button type="button" onClick={() => onSplinePath(DEFAULT_SPLINE_PATH.map((p) => ({ ...p })))}>
                        <RotateCcw size={12} /> Reset
                      </button>
                    </div>
                    <p className="spline-capacity">{points.length >= MAX_SPLINE_POINTS
                      ? 'Point limit reached. Remove a point to continue.'
                      : `${MAX_SPLINE_POINTS - points.length} more points available · X east, Y south`}</p>
                    <div className="spline-point-list" aria-label="Control point coordinates">
                      {points.map((point, index) => (
                        <div className="spline-point-row" key={index}>
                          <span className="spline-point-number">{String(index + 1).padStart(2, '0')}</span>
                          <label>
                            X
                            <NumberField
                              key={`${node.id}-${index}-x`}
                              min={0}
                              max={100}
                              step={0.1}
                              label={`Point ${index + 1} X percent`}
                              value={percentAt(point, 'x')}
                              onChange={(value) => changePoint(index, 'x', value)}
                            />
                          </label>
                          <label>
                            Y
                            <NumberField
                              key={`${node.id}-${index}-y`}
                              min={0}
                              max={100}
                              step={0.1}
                              label={`Point ${index + 1} Y percent`}
                              value={percentAt(point, 'y')}
                              onChange={(value) => changePoint(index, 'y', value)}
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
                  min: 2,
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
                  min: 0.5,
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
                  key: 'meshQuality',
                  label: 'Terrain mesh fidelity',
                  type: 'select',
                  default: 'high',
                  description:
                    'Controls how finely the 3D mesh subdivides nearby terrain. Higher fidelity resolves smaller features in silhouettes and shadows.',
                  options: [
                    { value: 'balanced', label: 'Balanced · faster' },
                    { value: 'high', label: 'High · adaptive' },
                    { value: 'ultra', label: 'Ultra · close-up' },
                  ],
                }}
                value={settings.meshQuality}
                onChange={(v) =>
                  onSettingsChange({
                    ...settings,
                    meshQuality: v as ViewSettings['meshQuality'],
                  })
                }
              />
              <ParamControl
                definition={{
                  key: 'detailStrength',
                  label: 'Sub-polygon displacement',
                  type: 'range',
                  default: 0.65,
                  min: 0,
                  max: 2,
                  step: 0.05,
                  unit: '×',
                  description:
                    'Scales the signed relief of rock, soil, vegetation and snow on every terrain mesh. Zero shows the underlying terrain elevation.',
                }}
                value={surface.detailStrength}
                onChange={(v) =>
                  onProjectChange({ surface: { ...surface, detailStrength: Number(v) } })
                }
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
              <p className="parameter-hint">
                Biome and layer coverage shape the relief in every 3D view. The PBR preview also
                shows the exported surface colors and roughness.
              </p>
              <ParamControl
                definition={{
                  key: 'biome',
                  label: 'Material biome',
                  type: 'select',
                  default: 'alpine',
                  options: [
                    { value: 'alpine', label: 'Alpine / temperate' },
                    { value: 'arid', label: 'Arid / desert' },
                    { value: 'volcanic', label: 'Volcanic rock' },
                  ],
                }}
                value={surface.biome}
                onChange={(v) =>
                  onProjectChange({ surface: { ...surface, biome: v as typeof surface.biome } })
                }
              />
              <fieldset className="layer-palette">
                <legend>Layer albedo</legend>
                <div className="layer-swatches">
                  {SPLAT_LAYERS.map((layer) => (
                    <label key={layer}>
                      <input
                        type="color"
                        aria-label={layer + ' albedo'}
                        value={layerColorHex(surface, layer)}
                        onChange={(event) =>
                          onProjectChange({
                            surface: {
                              ...surface,
                              layerColors: { ...surface.layerColors, [layer]: event.target.value },
                            },
                          })
                        }
                      />
                      {layer}
                    </label>
                  ))}
                </div>
                {surface.layerColors && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      onProjectChange({ surface: { ...surface, layerColors: undefined } })
                    }
                  >
                    Restore biome colors
                  </button>
                )}
              </fieldset>
              <ParamControl
                definition={{
                  key: 'nearFieldDetail',
                  label: 'Live close-up microdetail',
                  type: 'toggle',
                  default: true,
                  description:
                    'Adds meter-scaled world-space rock joints, sediment grain and snow/vegetation micro-normal shading only when zoomed close enough to resolve them. Preview only; exported PBR maps are unchanged.',
                }}
                value={settings.nearFieldDetail}
                onChange={(v) => onSettingsChange({ ...settings, nearFieldDetail: Boolean(v) })}
              />
              {(
                [
                  {
                    key: 'snowLine',
                    label: 'Snow-line elevation',
                    min: 0.35,
                    max: 1,
                    step: 0.01,
                    description: 'Relative to the generated terrain elevation range.',
                  },
                  {
                    key: 'rockSlope',
                    label: 'Exposed rock slope',
                    min: 12,
                    max: 75,
                    step: 1,
                    unit: '°',
                    description: 'Surface angle where vegetation gives way to exposed rock.',
                  },
                  {
                    key: 'moisture',
                    label: 'Environmental moisture',
                    min: 0,
                    max: 1,
                    step: 0.01,
                    description: 'Controls vegetation coverage and wet surface response.',
                  },
                  {
                    key: 'detailMeters',
                    label: 'Surface detail scale',
                    min: 4,
                    max: 200,
                    step: 1,
                    unit: 'm',
                    description: 'Approximate spatial wavelength of generated microstructure.',
                  },
                  {
                    key: 'strataMeters',
                    label: 'Rock bedding separation',
                    min: 12,
                    max: 500,
                    step: 2,
                    unit: 'm',
                    description:
                      'Geological stratum thickness in elevation meters; bands follow actual rock heights and fade if unresolved.',
                  },
                  {
                    key: 'fractureMeters',
                    label: 'Rock fracture spacing',
                    min: 12,
                    max: 320,
                    step: 2,
                    unit: 'm',
                    description:
                      'Physical spacing of seeded rock joints; one pattern drives color, roughness and micro-relief.',
                  },
                  {
                    key: 'aoStrength',
                    label: 'Terrain occlusion',
                    min: 0,
                    max: 1,
                    step: 0.05,
                    description:
                      'Physical 50/150/425 m, plane-corrected terrain horizon occlusion.',
                  },
                ] as const
              ).map((control) => (
                <ParamControl
                  key={control.key}
                  definition={{ ...control, type: 'range', default: surface[control.key] }}
                  value={surface[control.key]}
                  onChange={(v) =>
                    onProjectChange({
                      surface: { ...surface, [control.key]: Number(v) },
                    })
                  }
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
      {activeTab === 'node' && node && (
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
