import { Check, Layers, Mountain } from 'lucide-react';
import type { GenesisSettings } from '../../model/genesis';
import {
  DEFAULT_GENESIS,
  GENESIS_LITHOLOGIES,
  GENESIS_PRESETS,
  GENESIS_SETTING_RANGES,
} from '../../model/genesis';
import type { WorldDefinition } from '../../model/world';
import type { WorldRegionResult } from '../../engine/world';
import { genesisGridSize } from '../../engine/genesis';
import {
  WorldDisclosure,
  WorldMetric,
  WorldNotice,
  WorldNumberField,
  WorldSection,
  WorldSlider,
  worldDistance,
  worldNumber,
} from './WorldControls';

/** Authored settings only: selecting a preset never changes the input graph or transport. */
export function WorldGenesisPanel({
  world,
  onChange,
  result,
  stale,
  onPin,
  canPin,
}: {
  world: WorldDefinition;
  onChange(world: WorldDefinition, group?: string): void;
  result: WorldRegionResult | null;
  stale: boolean;
  onPin(): void;
  canPin: boolean;
}) {
  const settings = { ...DEFAULT_GENESIS, ...world.genesis };
  const patch = (change: Partial<GenesisSettings>, key: string) =>
    onChange({ ...world, genesis: { ...settings, ...change } }, `world-genesis-${key}`);
  const report = result?.genesis?.report;
  const formationGrid = genesisGridSize(world.domain, world.globalResolution);
  return (
    <>
      <WorldSection title="World Genesis">
        <label className="we-toggle-card we-genesis-toggle">
          <span>
            <strong>
              <Mountain size={15} /> Geological formation
            </strong>
            <small>Uplift, layered rock and connected river incision</small>
          </span>
          <input
            type="checkbox"
            aria-label="Enable World Genesis"
            checked={settings.enabled}
            onChange={(event) => patch({ enabled: event.target.checked }, 'enable')}
          />
        </label>
        <p className="we-hint">
          Shape the authored terrain through successive erosion scales. Hard and soft rock layers
          guide the rivers as the landscape rises.
        </p>
        {!settings.enabled && (
          <p className="we-hint">
            Enable formation to choose a geological character and inspect its rock and drainage
            layers.
          </p>
        )}
        {settings.enabled && (
          <>
            <div
              className="we-choice-list we-genesis-presets"
              role="group"
              aria-label="Genesis presets"
            >
              {GENESIS_PRESETS.map((preset) => {
                const active = Object.entries(preset.settings).every(
                  ([key, value]) => settings[key as keyof GenesisSettings] === value,
                );
                return (
                  <button
                    type="button"
                    key={preset.id}
                    aria-pressed={active}
                    onClick={() => {
                      if (canPin) onPin();
                      onChange(
                        {
                          ...world,
                          genesis: { ...DEFAULT_GENESIS, ...preset.settings, enabled: true },
                        },
                        'world-genesis-preset',
                      );
                    }}
                  >
                    <span>
                      <strong>{preset.label}</strong>
                      <small>{preset.description}</small>
                    </span>
                    {active ? <Check size={15} /> : <span className="we-preset-arrow">↗</span>}
                  </button>
                );
              })}
            </div>
            {world.domain.boundary === 'periodic' && (
              <WorldNotice>
                Genesis requires an open or closed domain. Choose a boundary in Setup before
                building.
              </WorldNotice>
            )}
            <div className="we-genesis-scale">
              <Layers size={15} />
              <span>
                <strong>
                  {formationGrid.width} × {formationGrid.height} formation grid
                </strong>
                <small>
                  {worldDistance(world.domain.width / (formationGrid.width - 1))} ×{' '}
                  {worldDistance(world.domain.depth / (formationGrid.height - 1))} spacing · change
                  Build quality below
                </small>
              </span>
            </div>
            <WorldNumberField
              label="Formation duration"
              value={settings.durationYears}
              min={GENESIS_SETTING_RANGES.durationYears[0]}
              max={GENESIS_SETTING_RANGES.durationYears[1]}
              step={1}
              unit="years"
              onChange={(value) => patch({ durationYears: value }, 'duration')}
              hint="Model time controls accumulated erosion. These are artistic geological settings."
            />
            <WorldSlider
              label="Peak uplift"
              value={settings.upliftMeters}
              min={GENESIS_SETTING_RANGES.upliftMeters[0]}
              max={GENESIS_SETTING_RANGES.upliftMeters[1]}
              step={1}
              unit="m"
              onChange={(value) => patch({ upliftMeters: value }, 'uplift')}
              description="Total uplift across the formation, concentrated along the uplift axis."
            />
            <WorldSlider
              label="Rainfall multiplier"
              value={settings.rainfall}
              min={GENESIS_SETTING_RANGES.rainfall[0]}
              max={GENESIS_SETTING_RANGES.rainfall[1]}
              step={0.05}
              unit="×"
              onChange={(value) => patch({ rainfall: value }, 'rainfall')}
            />
            <WorldSlider
              label="Rock hardness"
              value={settings.rockHardness}
              min={GENESIS_SETTING_RANGES.rockHardness[0]}
              max={GENESIS_SETTING_RANGES.rockHardness[1]}
              onChange={(value) => patch({ rockHardness: value }, 'hardness')}
              description="Harder formations resist channel incision. Layer contrast controls how the rock types differ."
            />
            <WorldDisclosure title="Uplift & erosion controls">
              <WorldNumberField
                label="Uplift axis"
                value={settings.upliftAngleDegrees}
                min={GENESIS_SETTING_RANGES.upliftAngleDegrees[0]}
                max={GENESIS_SETTING_RANGES.upliftAngleDegrees[1]}
                step={0.5}
                unit="°"
                onChange={(value) => patch({ upliftAngleDegrees: value }, 'axis')}
              />
              <WorldNumberField
                label="Uplift width"
                value={settings.upliftWidthMeters}
                min={GENESIS_SETTING_RANGES.upliftWidthMeters[0]}
                max={GENESIS_SETTING_RANGES.upliftWidthMeters[1]}
                step={0.1}
                unit="m"
                onChange={(value) => patch({ upliftWidthMeters: value }, 'width')}
              />
              <WorldNumberField
                label="Incision efficiency"
                value={settings.erosionRate}
                min={GENESIS_SETTING_RANGES.erosionRate[0]}
                max={GENESIS_SETTING_RANGES.erosionRate[1]}
                step={0.000001}
                unit="1 / year"
                onChange={(value) => patch({ erosionRate: value }, 'erosion-rate')}
                hint="Stream-power coefficient with area exponent 0.5 and slope exponent 1."
              />
              <WorldNumberField
                label="Hillslope diffusivity"
                value={settings.hillslopeRate}
                min={GENESIS_SETTING_RANGES.hillslopeRate[0]}
                max={GENESIS_SETTING_RANGES.hillslopeRate[1]}
                step={0.01}
                unit="m² / year"
                onChange={(value) => patch({ hillslopeRate: value }, 'hillslope')}
              />
              <WorldNumberField
                label="Formation iterations"
                value={settings.iterations}
                min={GENESIS_SETTING_RANGES.iterations[0]}
                max={GENESIS_SETTING_RANGES.iterations[1]}
                step={1}
                unit="/ scale"
                onChange={(value) => patch({ iterations: value }, 'iterations')}
              />
            </WorldDisclosure>
            <WorldDisclosure title="Strata, folds & faults">
              <div className="we-genesis-rocks" aria-label="Genesis rock classes">
                {GENESIS_LITHOLOGIES.map((rock) => (
                  <span key={rock.id}>
                    <i style={{ backgroundColor: rock.color }} />
                    {rock.label}
                  </span>
                ))}
              </div>
              <WorldSlider
                label="Layer contrast"
                value={settings.hardnessContrast}
                min={GENESIS_SETTING_RANGES.hardnessContrast[0]}
                max={GENESIS_SETTING_RANGES.hardnessContrast[1]}
                onChange={(value) => patch({ hardnessContrast: value }, 'contrast')}
              />
              <WorldNumberField
                label="Strata thickness"
                value={settings.strataThicknessMeters}
                min={GENESIS_SETTING_RANGES.strataThicknessMeters[0]}
                max={GENESIS_SETTING_RANGES.strataThicknessMeters[1]}
                step={0.1}
                unit="m"
                onChange={(value) => patch({ strataThicknessMeters: value }, 'strata-thickness')}
              />
              <WorldNumberField
                label="Strata dip"
                value={settings.strataDipDegrees}
                min={GENESIS_SETTING_RANGES.strataDipDegrees[0]}
                max={GENESIS_SETTING_RANGES.strataDipDegrees[1]}
                step={0.5}
                unit="°"
                onChange={(value) => patch({ strataDipDegrees: value }, 'strata-dip')}
              />
              <WorldNumberField
                label="Strata strike"
                value={settings.strataStrikeDegrees}
                min={GENESIS_SETTING_RANGES.strataStrikeDegrees[0]}
                max={GENESIS_SETTING_RANGES.strataStrikeDegrees[1]}
                step={0.5}
                unit="°"
                onChange={(value) => patch({ strataStrikeDegrees: value }, 'strata-strike')}
              />
              <WorldNumberField
                label="Fold amplitude"
                value={settings.foldAmplitudeMeters}
                min={GENESIS_SETTING_RANGES.foldAmplitudeMeters[0]}
                max={GENESIS_SETTING_RANGES.foldAmplitudeMeters[1]}
                step={0.1}
                unit="m"
                onChange={(value) => patch({ foldAmplitudeMeters: value }, 'fold-amplitude')}
              />
              <WorldNumberField
                label="Fold wavelength"
                value={settings.foldWavelengthMeters}
                min={GENESIS_SETTING_RANGES.foldWavelengthMeters[0]}
                max={GENESIS_SETTING_RANGES.foldWavelengthMeters[1]}
                step={0.1}
                unit="m"
                onChange={(value) => patch({ foldWavelengthMeters: value }, 'fold-wavelength')}
              />
              <WorldNumberField
                label="Fault throw"
                value={settings.faultThrowMeters}
                min={GENESIS_SETTING_RANGES.faultThrowMeters[0]}
                max={GENESIS_SETTING_RANGES.faultThrowMeters[1]}
                step={0.1}
                unit="m"
                onChange={(value) => patch({ faultThrowMeters: value }, 'fault-throw')}
              />
              <WorldNumberField
                label="Fault direction"
                value={settings.faultAngleDegrees}
                min={GENESIS_SETTING_RANGES.faultAngleDegrees[0]}
                max={GENESIS_SETTING_RANGES.faultAngleDegrees[1]}
                step={0.5}
                unit="°"
                onChange={(value) => patch({ faultAngleDegrees: value }, 'fault-angle')}
              />
              <p className="we-hint">
                Rock classes describe procedural layers with stylized resistance. Folds and faults
                alter their structure beneath the surface.
              </p>
            </WorldDisclosure>
            <p className="we-hint">
              Formation runs before optional World transport. Increasing export samples retains
              finer authored detail; the formation grid sets the resolved river scale.
            </p>
          </>
        )}
      </WorldSection>
      {report && (
        <WorldDisclosure title="Last Genesis formation" open>
          {stale && (
            <WorldNotice>
              These measurements describe the last completed build. Build your changes to update
              them.
            </WorldNotice>
          )}
          <div className="we-metrics">
            <WorldMetric label="Formation grid" value={`${report.width} × ${report.height}`} />
            <WorldMetric
              label="Formation spacing"
              value={`${worldNumber(report.spacingX, 2)} × ${worldNumber(report.spacingZ, 2)} m`}
            />
            <WorldMetric
              label="Erosion scales"
              value={report.levels.length}
              detail={report.levels.map((level) => `${level.width} × ${level.height}`).join(' → ')}
            />
            <WorldMetric
              label="Formation time"
              value={`${worldNumber(report.durationMs / 1000, 2)} s`}
              detail="CPU reference solve"
            />
            <WorldMetric
              label="Uplifted volume"
              value={`${worldNumber(report.upliftVolumeM3 / 1e6, 3)} Mm³`}
            />
            <WorldMetric
              label="Incised volume"
              value={`${worldNumber(report.incisedVolumeM3 / 1e6, 3)} Mm³`}
            />
            <WorldMetric
              label="Largest catchment"
              value={`${worldNumber(report.maxDrainageAreaM2 / 1e6, 3)} km²`}
            />
            <WorldMetric label="Drainage terminals" value={worldNumber(report.outletCount, 0)} />
          </div>
          <p className="we-hint">
            Inspect Rock hardness, Lithology, Tectonic uplift, Channel incision, Drainage area and
            River network in the map layers. Diagnostics describe the Genesis stage before optional
            World transport.
          </p>
          <WorldDisclosure title="Formation model & limits">
            <p className="we-hint">
              {report.algorithmVersion} · multiscale stream-power amplification. Volume diagnostics
              describe the reference solve; they are not a sediment-conservation budget for the
              exported terrain.
            </p>
            {report.limitations.map((limit) => (
              <p className="we-hint" key={limit}>
                {limit}
              </p>
            ))}
          </WorldDisclosure>
        </WorldDisclosure>
      )}
    </>
  );
}
