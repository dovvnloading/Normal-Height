import { useState } from 'react';
import { ArrowUpRight, Check, Link2, Unlink } from 'lucide-react';
import type { WorldDefinition, WorldDomain } from '../../model/world';
import type { WorldCapability } from '../../engine/world';
import {
  WorldDisclosure,
  WorldMetric,
  WorldNotice,
  WorldNumberField,
  WorldPanelHeading,
  WorldSection,
  worldDistance,
  worldNumber,
} from './WorldControls';

export function WorldSetupPanel({
  world,
  onChange,
  capability,
  error,
  onOpenGraph,
}: {
  world: WorldDefinition;
  onChange(world: WorldDefinition, group?: string): void;
  capability: WorldCapability | null;
  error?: string | null;
  onOpenGraph(): void;
}) {
  const [linked, setLinked] = useState(world.domain.width === world.domain.depth);
  const d = world.domain;
  const patch = (values: Partial<WorldDefinition>, group = 'world-settings') =>
    onChange({ ...world, ...values }, group);
  const patchDomain = (values: Partial<WorldDomain>, group = 'world-domain') =>
    patch({ domain: { ...d, ...values } }, group);
  const width = (value: number) =>
    patchDomain({ width: value, ...(linked ? { depth: (value * d.depth) / d.width } : {}) });
  const depth = (value: number) =>
    patchDomain({ depth: value, ...(linked ? { width: (value * d.width) / d.depth } : {}) });
  const cellSpacing = Math.max(d.width / d.cellsX, d.depth / d.cellsZ);
  const changeSpacing = (spacing: number) =>
    patchDomain({
      cellsX: Math.max(1, Math.min(32768, Math.round(d.width / spacing))),
      cellsZ: Math.max(1, Math.min(32768, Math.round(d.depth / spacing))),
    });
  return (
    <>
      <WorldPanelHeading eyebrow="WORLD SETUP" title="Give your terrain a place.">
        Physical dimensions, coordinates, and sampling. Every region shares the same world.
      </WorldPanelHeading>
      <WorldSection title="Start with a scale">
        <div className="we-scale-presets">
          {[
            { size: 1000, label: 'Local', detail: '1 km' },
            { size: 8000, label: 'Landscape', detail: '8 km' },
            { size: 32000, label: 'Regional', detail: '32 km' },
          ].map((preset) => (
            <button
              key={preset.size}
              type="button"
              aria-pressed={d.width === preset.size && d.depth === preset.size}
              onClick={() => {
                patchDomain(
                  {
                    width: preset.size,
                    depth: preset.size,
                    originX: d.originX + d.width / 2 - preset.size / 2,
                    originZ: d.originZ + d.depth / 2 - preset.size / 2,
                  },
                  'world-scale-preset',
                );
                setLinked(true);
              }}
            >
              <span
                className={`we-scale-mark scale-${preset.label.toLowerCase()}`}
                aria-hidden="true"
              />
              <strong>{preset.label}</strong>
              <span>{preset.detail}</span>
            </button>
          ))}
        </div>
      </WorldSection>
      <WorldSection
        title="Physical extent"
        action={
          <button
            type="button"
            className="we-icon-button"
            aria-label="Lock world aspect ratio"
            aria-pressed={linked}
            title="Keep the current aspect ratio"
            onClick={() => setLinked(!linked)}
          >
            {linked ? <Link2 size={15} /> : <Unlink size={15} />}
          </button>
        }
      >
        <div className="we-two">
          <WorldNumberField
            label="Width"
            value={d.width}
            min={1}
            max={1e9}
            step={0.1}
            onChange={width}
          />
          <WorldNumberField
            label="Depth"
            value={d.depth}
            min={1}
            max={1e9}
            step={0.1}
            onChange={depth}
          />
        </div>
        <div className="we-metrics">
          <WorldMetric
            label="World area"
            value={`${worldNumber((d.width * d.depth) / 1e6, 2)} km²`}
          />
          <WorldMetric label="Aspect" value={`${worldNumber(d.width / d.depth, 2)} : 1`} />
        </div>
        {capability && !capability.supported && (
          <WorldNotice error>
            <p>{capability.reason}</p>
            <button className="we-text-button" type="button" onClick={onOpenGraph}>
              Review graph stages <ArrowUpRight size={13} />
            </button>
          </WorldNotice>
        )}
      </WorldSection>
      <WorldSection title="Sampling grid">
        <WorldNumberField
          label="Target spacing"
          value={Number(cellSpacing.toPrecision(6))}
          min={Math.max(d.width, d.depth) / 32768}
          max={Math.max(d.width, d.depth)}
          step={0.01}
          onChange={changeSpacing}
          hint="Sets whole cell counts. Actual spacing is shown below."
        />
        <div className="we-metrics">
          <WorldMetric
            label="Actual spacing"
            value={`${worldNumber(d.width / d.cellsX, 2)} × ${worldNumber(d.depth / d.cellsZ, 2)} m`}
          />
          <WorldMetric
            label="World samples"
            value={`${worldNumber(d.cellsX + 1, 0)} × ${worldNumber(d.cellsZ + 1, 0)}`}
          />
        </div>
        <label className="we-field">
          <span>Tile intervals</span>
          <select
            aria-label="Tile intervals"
            value={world.tileCells}
            onChange={(event) => patch({ tileCells: Number(event.target.value) }, 'world-tiles')}
          >
            {[32, 64, 128, 256, 512].map((value) => (
              <option key={value} value={value}>
                {value} × {value} cells
              </option>
            ))}
          </select>
        </label>
        <p className="we-hint">
          {Math.ceil(d.cellsX / world.tileCells)} × {Math.ceil(d.cellsZ / world.tileCells)} tiles ·
          up to {worldDistance((world.tileCells * d.width) / d.cellsX)} wide. Export sampling is
          chosen separately.
        </p>
      </WorldSection>
      <WorldSection title="Elevation">
        <div className="we-two">
          <WorldNumberField
            label="Height scale"
            value={d.heightScale}
            min={0.001}
            max={1e7}
            step={0.1}
            onChange={(value) => patchDomain({ heightScale: value }, 'world-height-scale')}
          />
          <WorldNumberField
            label="Local datum"
            value={d.datum}
            min={-1e9}
            max={1e9}
            step={0.1}
            onChange={(value) => patchDomain({ datum: value }, 'world-datum')}
          />
        </div>
        <p className="we-hint">
          Elevation = terrain value × height scale + datum. View exaggeration changes only the
          display.
        </p>
      </WorldSection>
      <WorldSection title="World boundary">
        <div className="we-choice-list" role="group" aria-label="World boundary">
          {(
            [
              {
                value: 'closed',
                name: 'Closed perimeter',
                detail: 'Water and sediment stay inside.',
              },
              { value: 'open', name: 'Open outlets', detail: 'Transport can leave the world.' },
              {
                value: 'periodic',
                name: 'Periodic world',
                detail: 'Opposite edges meet. Native graphs only.',
              },
            ] as const
          ).map((boundary) => (
            <button
              type="button"
              key={boundary.value}
              aria-pressed={d.boundary === boundary.value}
              onClick={() => patchDomain({ boundary: boundary.value }, 'world-boundary')}
            >
              <span>
                <strong>{boundary.name}</strong>
                <small>{boundary.detail}</small>
              </span>
              {d.boundary === boundary.value && <Check size={15} />}
            </button>
          ))}
        </div>
      </WorldSection>
      <WorldDisclosure title="Coordinates & exact cell counts">
        <div className="we-two">
          <WorldNumberField
            label="Origin X"
            value={d.originX}
            min={-1e12}
            max={1e12}
            step={0.1}
            onChange={(value) => patchDomain({ originX: value }, 'world-origin')}
          />
          <WorldNumberField
            label="Origin Z"
            value={d.originZ}
            min={-1e12}
            max={1e12}
            step={0.1}
            onChange={(value) => patchDomain({ originZ: value }, 'world-origin')}
          />
          <WorldNumberField
            label="Cells X"
            value={d.cellsX}
            min={1}
            max={32768}
            unit="cells"
            onChange={(value) => patchDomain({ cellsX: value }, 'world-cells')}
          />
          <WorldNumberField
            label="Cells Z"
            value={d.cellsZ}
            min={1}
            max={32768}
            unit="cells"
            onChange={(value) => patchDomain({ cellsZ: value }, 'world-cells')}
          />
        </div>
        <p className="we-hint">
          Local Cartesian metres. +X east, +Z south; the first image row is north. Cell counts
          describe intervals, with one shared sample at each boundary.
        </p>
      </WorldDisclosure>
      {error && <WorldNotice error>{error}</WorldNotice>}
    </>
  );
}
