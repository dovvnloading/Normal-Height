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
} from 'lucide-react';
import { NODE_DEFINITIONS } from '../model/registry';
import { NumberField, ParamControl } from './Controls';
import type { TerrainNode, TerrainProject, ParamValue, ViewSettings } from '../model/types';

interface Props {
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
                  default: 'alpine',
                  options: [
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
