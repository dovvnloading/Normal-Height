import { Check, Cpu, Database, Play, Trash2 } from 'lucide-react';
import type { WorldDefinition, WorldTransportSettings } from '../../model/world';
import { DEFAULT_WORLD_TRANSPORT } from '../../model/world';
import type { WorldRegionResult } from '../../engine/world';
import type { ComputeCapability } from '../../engine/gpu/pointwise';
import type { WorldRegionStoreStats } from '../../engine/worldStore';
import {
  WorldDisclosure,
  WorldMetric,
  WorldNotice,
  WorldNumberField,
  WorldPanelHeading,
  WorldSection,
  WorldSlider,
  worldMemory,
  worldNumber,
} from './WorldControls';

const simulationPresets: {
  name: string;
  detail: string;
  settings: Partial<WorldTransportSettings>;
}[] = [
  {
    name: 'Gentle weathering',
    detail: 'Light rain, subtle surface change.',
    settings: {
      iterations: 16,
      rainfall: 0.04,
      conductivity: 0.25,
      erosion: 0.15,
      deposition: 0.25,
      thermal: 0.08,
      capacity: 1,
      soilDepth: 2,
    },
  },
  {
    name: 'River carving',
    detail: 'Stronger runoff and sediment transport.',
    settings: {
      iterations: 48,
      rainfall: 0.16,
      conductivity: 0.6,
      erosion: 0.55,
      deposition: 0.25,
      thermal: 0.06,
      capacity: 2.5,
      soilDepth: 8,
    },
  },
  {
    name: 'Talus slopes',
    detail: 'Thermal movement with minimal rainfall.',
    settings: {
      iterations: 32,
      rainfall: 0,
      conductivity: 0.35,
      erosion: 0,
      deposition: 0.3,
      thermal: 0.55,
      talusDegrees: 32,
      capacity: 1.5,
      soilDepth: 6,
    },
  },
];

export function WorldSimulationPanel({
  world,
  onChange,
  result,
  compute,
  cacheEnabled,
  onCacheChange,
  storeStats,
  cacheHit,
  onClearCache,
  onBuild,
  onPin,
  canPin,
  busy,
  error,
}: {
  world: WorldDefinition;
  onChange(world: WorldDefinition, group?: string): void;
  result: WorldRegionResult | null;
  compute: ComputeCapability | null;
  cacheEnabled: boolean;
  onCacheChange(value: boolean): void;
  storeStats: WorldRegionStoreStats | null;
  cacheHit: boolean;
  onClearCache(): void;
  onBuild(): void;
  onPin(): void;
  canPin: boolean;
  busy: boolean;
  error?: string | null;
}) {
  const transport = { ...DEFAULT_WORLD_TRANSPORT, ...world.transport };
  const patchTransport = (patch: Partial<WorldTransportSettings>, group = 'world-transport') =>
    onChange({ ...world, transport: { ...transport, ...patch } }, group);
  const budget = result?.transportBudget;
  return (
    <>
      <WorldPanelHeading eyebrow="SIMULATE" title="Shape the landscape.">
        Run one connected world, then inspect the change at any scale.
      </WorldPanelHeading>
      <WorldSection title="Build quality">
        <div className="we-quality-presets" role="group" aria-label="Simulation quality">
          {[
            { name: 'Draft', size: 128 },
            { name: 'Balanced', size: 256 },
            { name: 'Detailed', size: 512 },
          ].map((preset) => (
            <button
              type="button"
              key={preset.size}
              aria-pressed={world.globalResolution === preset.size}
              onClick={() =>
                onChange({ ...world, globalResolution: preset.size }, 'world-reference-quality')
              }
            >
              <strong>{preset.name}</strong>
              <small>{preset.size}² reference</small>
            </button>
          ))}
        </div>
        <label className="we-field">
          <span>Global reference</span>
          <select
            aria-label="Global reference"
            value={world.globalResolution}
            onChange={(event) =>
              onChange(
                { ...world, globalResolution: Number(event.target.value) },
                'world-reference-quality',
              )
            }
          >
            {Array.from(new Set([64, 128, 256, 512, 1024, world.globalResolution]))
              .sort((a, b) => a - b)
              .map((n) => (
                <option key={n} value={n}>
                  {n} × {n} samples
                </option>
              ))}
          </select>
        </label>
        <p className="we-hint">
          Global simulation resolution affects landforms. Refining the viewport samples more native
          detail; it does not rerun a finer simulation.
        </p>
        <button
          className="we-button is-primary we-full"
          type="button"
          onClick={onBuild}
          disabled={busy || !!error}
        >
          <Play size={14} />
          Build world
        </button>
      </WorldSection>
      <WorldSection title="Water & sediment">
        <label className="we-toggle-card">
          <span>
            <strong>World transport</strong>
            <small>Whole-domain hydraulic and thermal pass</small>
          </span>
          <input
            type="checkbox"
            aria-label="Enable world transport"
            checked={transport.enabled}
            onChange={(event) =>
              patchTransport({ enabled: event.target.checked }, 'world-transport-enable')
            }
          />
        </label>
        {!transport.enabled && (
          <p className="we-hint">
            Your authored graph already runs during each build. Enable this additional pass to move
            water and sediment across the world.
          </p>
        )}
        {transport.enabled && (
          <>
            <div className="we-choice-list">
              {simulationPresets.map((preset) => (
                <button
                  key={preset.name}
                  type="button"
                  onClick={() => {
                    if (canPin) onPin();
                    onChange(
                      {
                        ...world,
                        transport: {
                          ...DEFAULT_WORLD_TRANSPORT,
                          ...preset.settings,
                          enabled: true,
                        },
                      },
                      'world-transport-preset',
                    );
                  }}
                >
                  <span>
                    <strong>{preset.name}</strong>
                    <small>{preset.detail}</small>
                  </span>
                  <span className="we-preset-arrow">↗</span>
                </button>
              ))}
            </div>
            <WorldNumberField
              label="Transport iterations"
              value={transport.iterations}
              min={1}
              max={128}
              unit="steps"
              onChange={(value) =>
                patchTransport({ iterations: value }, 'world-transport-iterations')
              }
            />
            <WorldSlider
              label="Rainfall"
              value={transport.rainfall}
              min={0}
              max={10}
              step={0.01}
              unit="m / step"
              onChange={(value) => patchTransport({ rainfall: value }, 'world-transport-rainfall')}
              description="Depth of water added each iteration."
            />
            <WorldSlider
              label="Erosion strength"
              value={transport.erosion}
              min={0}
              max={1}
              onChange={(value) => patchTransport({ erosion: value }, 'world-transport-erosion')}
            />
            <WorldSlider
              label="Thermal movement"
              value={transport.thermal}
              min={0}
              max={1}
              onChange={(value) => patchTransport({ thermal: value }, 'world-transport-thermal')}
            />
            <WorldDisclosure title="Sediment & flow parameters">
              <WorldSlider
                label="Evaporation"
                value={transport.evaporation}
                min={0}
                max={1}
                onChange={(value) =>
                  patchTransport({ evaporation: value }, 'world-transport-evaporation')
                }
              />
              <WorldNumberField
                label="Conductivity"
                value={transport.conductivity}
                min={0}
                max={100}
                step={0.01}
                unit="m² / step"
                onChange={(value) =>
                  patchTransport({ conductivity: value }, 'world-transport-conductivity')
                }
              />
              <WorldNumberField
                label="Sediment capacity"
                value={transport.capacity}
                min={0}
                max={20}
                step={0.05}
                unit=""
                onChange={(value) =>
                  patchTransport({ capacity: value }, 'world-transport-capacity')
                }
              />
              <WorldSlider
                label="Deposition rate"
                value={transport.deposition}
                min={0}
                max={1}
                onChange={(value) =>
                  patchTransport({ deposition: value }, 'world-transport-deposition')
                }
              />
              <WorldNumberField
                label="Talus angle"
                value={transport.talusDegrees}
                min={0}
                max={89}
                step={0.5}
                unit="°"
                onChange={(value) =>
                  patchTransport({ talusDegrees: value }, 'world-transport-talus')
                }
              />
              <WorldNumberField
                label="Soil depth"
                value={transport.soilDepth}
                min={0}
                max={1000}
                step={0.1}
                unit="m"
                onChange={(value) => patchTransport({ soilDepth: value }, 'world-transport-soil')}
              />
            </WorldDisclosure>
            <p className="we-hint">
              Experimental artistic transport. Budgets describe the coarse simulation before
              displacement is reconstructed over the terrain.
            </p>
          </>
        )}
      </WorldSection>
      {budget && (
        <WorldSection title="Last transport budget">
          <div className="we-metrics">
            <WorldMetric label="Eroded" value={`${worldNumber(budget.erodedVolumeM3)} m³`} />
            <WorldMetric label="Deposited" value={`${worldNumber(budget.depositedVolumeM3)} m³`} />
            <WorldMetric
              label="Water balance residual"
              value={`${worldNumber(budget.waterResidualM3, 6)} m³`}
            />
            <WorldMetric
              label="Remaining water"
              value={`${worldNumber(budget.finalWaterVolumeM3)} m³`}
            />
            <WorldMetric
              label="Boundary export"
              value={`${worldNumber(budget.exportedSedimentVolumeM3)} m³`}
            />
            <WorldMetric
              label="Solid balance residual"
              value={`${worldNumber(budget.solidResidualM3, 6)} m³`}
            />
          </div>
        </WorldSection>
      )}
      <WorldDisclosure title="Compute & local cache">
        <label className="we-field">
          <span>
            <Cpu size={13} /> Compute backend
          </span>
          <select
            aria-label="World compute backend"
            value={world.backend}
            onChange={(event) =>
              onChange(
                { ...world, backend: event.target.value as WorldDefinition['backend'] },
                'world-backend',
              )
            }
          >
            <option value="cpu-reference">CPU reference</option>
            <option value="auto">Auto · eligible GPU stages</option>
            <option value="webgpu">WebGPU · when supported</option>
          </select>
        </label>
        {compute && <p className="we-hint">{compute.reason}</p>}
        <label className="we-toggle-card">
          <span>
            <strong>
              <Database size={13} /> Remember completed CPU regions
            </strong>
            <small>Opt-in storage in this browser</small>
          </span>
          <input
            aria-label="Remember completed CPU regions"
            type="checkbox"
            checked={cacheEnabled}
            onChange={(event) => onCacheChange(event.target.checked)}
          />
        </label>
        {cacheHit && (
          <span className="we-inline-success">
            <Check size={13} />
            Loaded from cache
          </span>
        )}
        {storeStats && (
          <p className="we-hint">
            On-device cache · {storeStats.entries} regions · {worldMemory(storeStats.bytes)}
          </p>
        )}
        <button type="button" className="we-button we-full" onClick={onClearCache} disabled={busy}>
          <Trash2 size={13} />
          Clear stored world regions
        </button>
        <p className="we-hint">
          Clearing regions preserves authored projects and the displayed terrain.
        </p>
      </WorldDisclosure>
      {error && <WorldNotice error>{error}</WorldNotice>}
    </>
  );
}
