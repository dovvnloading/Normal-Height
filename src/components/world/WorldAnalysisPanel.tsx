import { useMemo, useState } from 'react';
import { ArrowUpRight, Download, Pin, PinOff, ScanLine } from 'lucide-react';
import { GENESIS_LITHOLOGIES } from '../../model/genesis';
import type { WorldProbe, WorldRegion, WorldSnapshot } from './worldViewMath';
import { canCompareWorldSnapshots, worldGridBounds } from './worldViewMath';
import { analyzeWorld, worldElevationProfile } from './worldAnalysis';
import {
  WorldDisclosure,
  WorldMetric,
  WorldNotice,
  WorldPanelHeading,
  WorldSection,
  worldDistance,
  worldMemory,
  worldNumber,
} from './WorldControls';

export function WorldComparisonControls({
  snapshot,
  pinned,
  onPin,
  onClear,
  mode,
  onModeChange,
  canPin,
}: {
  snapshot: WorldSnapshot | null;
  pinned: WorldSnapshot | null;
  onPin(): void;
  onClear(): void;
  mode: 'off' | 'wipe' | 'difference';
  onModeChange(value: 'off' | 'wipe' | 'difference'): void;
  canPin: boolean;
}) {
  const compatible = !!snapshot && !!pinned && canCompareWorldSnapshots(snapshot, pinned);
  return (
    <WorldSection title="Before & after">
      <button className="we-button we-full" type="button" onClick={onPin} disabled={!canPin}>
        <Pin size={14} />
        {pinned ? 'Replace pinned baseline' : 'Pin current terrain'}
      </button>
      {pinned ? (
        <>
          <div className="we-baseline">
            <span>
              <Pin size={13} />
              {pinned.label ?? 'Pinned terrain'}
            </span>
            <button
              type="button"
              className="we-icon-button"
              aria-label="Clear comparison baseline"
              onClick={onClear}
            >
              <PinOff size={14} />
            </button>
          </div>
          <div className="we-segmented" role="group" aria-label="Terrain comparison">
            {(['off', 'wipe', 'difference'] as const).map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={mode === value}
                disabled={value !== 'off' && !compatible}
                onClick={() => onModeChange(value)}
              >
                {value === 'off' ? 'Current' : value === 'wipe' ? 'Wipe' : 'Difference'}
              </button>
            ))}
          </div>
          <p className="we-hint">
            {compatible
              ? 'The baseline holds completed terrain. Build a change, then compare the same physical region.'
              : 'Build the same physical footprint as the pinned terrain to compare. Different sample counts are interpolated for display.'}
          </p>
        </>
      ) : (
        <p className="we-hint">
          Pin a completed build before changing settings. The original samples remain available for
          a wipe or elevation difference.
        </p>
      )}
    </WorldSection>
  );
}

export function WorldAnalysisPanel({
  snapshot,
  region,
  probe,
  pinned,
  onPin,
  onClear,
  compareMode,
  onCompareMode,
  canPin,
  stale,
  onFocusNode,
  onReport,
}: {
  snapshot: WorldSnapshot | null;
  region: WorldRegion | null;
  probe: WorldProbe | null;
  pinned: WorldSnapshot | null;
  onPin(): void;
  onClear(): void;
  compareMode: 'off' | 'wipe' | 'difference';
  onCompareMode(value: 'off' | 'wipe' | 'difference'): void;
  canPin: boolean;
  stale: boolean;
  onFocusNode(id: string): void;
  onReport(): void;
}) {
  const [axis, setAxis] = useState<'x' | 'z'>('x');
  const analysis = useMemo(
    () => (snapshot ? analyzeWorld(snapshot, region) : null),
    [snapshot, region],
  );
  const profile = useMemo(
    () => (snapshot ? worldElevationProfile(snapshot, region, axis) : []),
    [snapshot, region, axis],
  );
  const profileMin = profile.length ? Math.min(...profile.map((p) => p.elevation)) : 0;
  const profileMax = profile.length ? Math.max(...profile.map((p) => p.elevation)) : 1;
  const profileRange = Math.max(1, profileMax - profileMin);
  const distance = profile.at(-1)?.distance ?? 1;
  const path = profile
    .map(
      (point, i) =>
        `${i ? 'L' : 'M'}${((point.distance / Math.max(1e-12, distance)) * 264 + 8).toFixed(2)},${(90 - ((point.elevation - profileMin) / profileRange) * 68).toFixed(2)}`,
    )
    .join(' ');
  const bounds = snapshot ? worldGridBounds(snapshot.world, region ?? snapshot.grid) : null;
  return (
    <>
      <WorldPanelHeading eyebrow="ANALYZE" title="Understand every contour.">
        Measurements from completed terrain, with the sample resolution always in view.
      </WorldPanelHeading>
      {stale && (
        <WorldNotice>
          These measurements describe the last completed build. Build your changes to update them.
        </WorldNotice>
      )}
      <WorldSection title="Terrain probe">
        {probe ? (
          <>
            <div className="we-probe-coordinate">
              <span>X {worldNumber(probe.x)} m</span>
              <span>Z {worldNumber(probe.z)} m</span>
            </div>
            <div className="we-metrics">
              <WorldMetric label="Elevation" value={`${worldNumber(probe.elevation)} m`} />
              <WorldMetric label="Slope" value={`${worldNumber(probe.slope)}°`} />
              <WorldMetric
                label="Aspect"
                value={probe.aspect === null ? 'Flat' : `${worldNumber(probe.aspect, 0)}°`}
              />
              <WorldMetric
                label="Flow"
                value={worldNumber(probe.flow, 4)}
                detail="relative signal"
              />
            </div>
            <p className="we-hint">
              Erosion signal {worldNumber(probe.wear, 3)} · deposition signal{' '}
              {worldNumber(probe.deposition, 3)}. Hover the map to inspect another location.
            </p>
          </>
        ) : (
          <div className="we-empty-inline">
            <ScanLine size={23} />
            <p>Move across the map to inspect physical coordinates, elevation, slope, and flow.</p>
          </div>
        )}
      </WorldSection>
      {snapshot?.result.genesis && (
        <WorldSection title="Geology & catchment probe">
          {probe?.genesis ? (
            <div className="we-metrics">
              <WorldMetric
                label="Rock class"
                value={
                  GENESIS_LITHOLOGIES.find((rock) => rock.id === probe.genesis?.lithology)?.label ??
                  'Unknown'
                }
              />
              <WorldMetric
                label="Hardness"
                value={worldNumber(probe.genesis.hardness, 3)}
                detail="0 soft · 1 hard"
              />
              <WorldMetric label="Uplift" value={`${worldNumber(probe.genesis.uplift, 2)} m`} />
              <WorldMetric label="Incision" value={`${worldNumber(probe.genesis.incision, 2)} m`} />
              <WorldMetric
                label="Contributing area"
                value={
                  probe.genesis.drainageArea >= 1e6
                    ? `${worldNumber(probe.genesis.drainageArea / 1e6, 3)} km²`
                    : `${worldNumber(probe.genesis.drainageArea, 0)} m²`
                }
              />
              <WorldMetric
                label="Channel strength"
                value={worldNumber(probe.genesis.channel, 3)}
                detail="0–1 drainage signal"
              />
            </div>
          ) : (
            <p className="we-hint">
              Move across the map to inspect exposed rock, accumulated uplift and the contributing
              catchment.
            </p>
          )}
          <p className="we-hint">
            Genesis diagnostics precede optional World transport. River and incision fields retain
            the formation grid spacing: {worldNumber(snapshot.result.genesis.report.spacingX, 2)} ×{' '}
            {worldNumber(snapshot.result.genesis.report.spacingZ, 2)} m.
          </p>
        </WorldSection>
      )}
      <WorldSection title={region ? 'Selected region' : 'Visible field'}>
        {analysis && bounds ? (
          <>
            <div className="we-metrics">
              <WorldMetric
                label="Footprint"
                value={`${worldDistance(bounds.width)} × ${worldDistance(bounds.depth)}`}
              />
              <WorldMetric
                label="Area"
                value={`${worldNumber((bounds.width * bounds.depth) / 1e6, 3)} km²`}
              />
              <WorldMetric label="Lowest" value={`${worldNumber(analysis.min)} m`} />
              <WorldMetric label="Highest" value={`${worldNumber(analysis.max)} m`} />
              <WorldMetric label="Mean elevation" value={`${worldNumber(analysis.mean)} m`} />
              <WorldMetric label="Mean slope" value={`${worldNumber(analysis.meanSlope)}°`} />
            </div>
            <figure className="we-chart">
              <figcaption>
                Elevation distribution <span>{worldNumber(analysis.count, 0)} samples</span>
              </figcaption>
              <svg
                viewBox="0 0 280 82"
                role="img"
                aria-label={`Elevation histogram from ${worldNumber(analysis.min)} to ${worldNumber(analysis.max)} metres`}
              >
                {analysis.histogram.map((count, i) => {
                  const h = (count / Math.max(...analysis.histogram, 1)) * 66;
                  return <rect key={i} x={i * 11.5 + 3} y={72 - h} width={9} height={h} rx={2} />;
                })}
              </svg>
              <div className="we-chart-axis">
                <span>{worldNumber(analysis.min)} m</span>
                <span>{worldNumber(analysis.max)} m</span>
              </div>
            </figure>
            <p className="we-hint">
              Relief {worldNumber(analysis.max - analysis.min)} m · steepest sample{' '}
              {worldNumber(analysis.maxSlope)}°. Statistics describe this preview grid.
            </p>
          </>
        ) : (
          <p className="we-hint">
            Build an overview, then select a region to inspect its elevation distribution.
          </p>
        )}
      </WorldSection>
      {!!profile.length && (
        <WorldSection
          title="Elevation section"
          action={
            <select
              aria-label="Elevation section direction"
              className="we-small-select"
              value={axis}
              onChange={(event) => setAxis(event.target.value as 'x' | 'z')}
            >
              <option value="x">West → east</option>
              <option value="z">North → south</option>
            </select>
          }
        >
          <figure className="we-chart we-profile">
            <figcaption>
              Through the region centre<span>{worldDistance(distance)}</span>
            </figcaption>
            <svg
              viewBox="0 0 280 106"
              role="img"
              aria-label={`Elevation section, lowest ${worldNumber(profileMin)} metres, highest ${worldNumber(profileMax)} metres`}
            >
              <path className="we-profile-area" d={`${path} L272,98 L8,98 Z`} />
              <path className="we-profile-line" d={path} />
              <line x1="8" y1="98" x2="272" y2="98" />
            </svg>
            <div className="we-chart-axis">
              <span>{worldNumber(profileMin)} m min</span>
              <span>{worldNumber(profileMax)} m max</span>
            </div>
          </figure>
          <p className="we-hint">
            Interpolated from the completed preview. Refine this region to sample a more detailed
            section.
          </p>
        </WorldSection>
      )}
      <WorldComparisonControls
        snapshot={snapshot}
        pinned={pinned}
        onPin={onPin}
        onClear={onClear}
        mode={compareMode}
        onModeChange={onCompareMode}
        canPin={canPin}
      />
      {snapshot && (
        <WorldSection
          title="Build provenance"
          action={
            <button
              type="button"
              className="we-icon-button"
              aria-label="Download stage report"
              title="Download stage report"
              onClick={onReport}
            >
              <Download size={14} />
            </button>
          }
        >
          <div className="we-metrics">
            <WorldMetric
              label="Preview grid"
              value={`${snapshot.result.width} × ${snapshot.result.height}`}
            />
            <WorldMetric
              label="Sample spacing"
              value={`${worldNumber(snapshot.result.spacingX, 2)} × ${worldNumber(snapshot.result.spacingZ, 2)} m`}
            />
            <WorldMetric
              label="Sampling time"
              value={`${worldNumber(snapshot.result.duration / 1000, 2)} s`}
            />
            <WorldMetric
              label="Estimated peak"
              value={worldMemory(snapshot.result.estimatedPeakBytes)}
            />
          </div>
          <p className="we-hint">
            Sampling time excludes graph preparation and rendering. Backend:{' '}
            {snapshot.result.backend === 'webgpu' ? 'WebGPU with CPU stages' : 'CPU reference'}.
          </p>
          <WorldDisclosure title={`${snapshot.result.stages.length} evaluated stages`}>
            <div className="we-stages">
              {snapshot.result.stages.map((stage) => (
                <button
                  type="button"
                  className="we-stage"
                  key={stage.nodeId}
                  onClick={() => onFocusNode(stage.nodeId)}
                  disabled={stage.nodeId === 'world-transport' || stage.nodeId === 'world-genesis'}
                >
                  <span>
                    <strong>{stage.label}</strong>
                    <small>
                      {stage.mode === 'native'
                        ? 'Native world coordinates'
                        : `${stage.samplesX} × ${stage.samplesZ} global reference`}
                    </small>
                    <small>
                      {worldNumber(stage.spacingX, 2)} × {worldNumber(stage.spacingZ, 2)} m ·{' '}
                      {stage.backend}
                    </small>
                    <em>{stage.reason}</em>
                  </span>
                  <ArrowUpRight size={13} />
                </button>
              ))}
            </div>
          </WorldDisclosure>
        </WorldSection>
      )}
    </>
  );
}
