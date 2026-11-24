import { useMemo, useState } from 'react';
import {
  ArrowRight,
  Bookmark,
  Check,
  ChevronDown,
  Clipboard,
  Code2,
  Dices,
  Download,
  Grid2X2,
  History,
  Layers3,
  LockKeyhole,
  Search,
  SlidersHorizontal,
  UnlockKeyhole,
  X,
} from 'lucide-react';
import {
  applyNoisePreset,
  decodeNoiseRecipe,
  encodeNoiseRecipe,
  MAX_SEED,
  NOISE_PRESETS,
  resolveNoiseSeed,
  resolveStudioSettings,
  STUDIO_DEFAULTS,
  STUDIO_FRACTALS,
  STUDIO_KERNELS,
  STUDIO_PARAMS,
  studioParamVisible,
  studioHasDerivativeGuidance,
} from '../model/noiseStudio';
import type { ParamValue } from '../model/types';
import type { NoisePreviewRequest } from '../hooks/noisePreviewProtocol';
import { useNoisePreviews } from '../hooks/useNoisePreviews';
import { frozenNoiseRecipe, useNoiseCollection } from '../hooks/noiseStudioStorage';
import type { NoiseCollection } from '../hooks/noiseStudioStorage';
import { NumberField, ParamControl } from './Controls';
import { Modal } from './Modal';
import { NoiseCurveEditor } from './NoiseCurveEditor';
import { NoiseHistogram, NoisePreviewCanvas } from './NoisePreviewCanvas';
import { NoiseExportDialog } from './NoiseExportDialog';
import './NoiseStudio.css';

type NoiseParams = Record<string, ParamValue>;
interface StudioContext {
  params: NoiseParams;
  projectSeed: number;
  worldSize: number;
}
interface Candidate {
  id: string;
  name: string;
  description: string;
  category: string;
  params: NoiseParams;
}
const labelForKernel = (kernel: ParamValue | undefined) =>
  STUDIO_KERNELS.find(([id]) => id === kernel)?.[1] ?? 'Noise';
const seedNumber = () => crypto.getRandomValues(new Uint32Array(1))[0] % (MAX_SEED + 1);
const previewRequest = (
  id: string,
  params: NoiseParams,
  projectSeed: number,
  worldSize: number,
  resolution = 96,
): NoisePreviewRequest => ({ id, params, projectSeed, worldSize, resolution });

/** Arrow navigation complements standard Tab / Enter buttons without trapping focus. */
function navigateGrid(event: React.KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key))
    return;
  const cards = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-noise-card]'),
  );
  const current = cards.indexOf(event.target as HTMLButtonElement);
  if (current < 0) return;
  const firstRow = cards[0].getBoundingClientRect().top;
  const columns = Math.max(
    1,
    cards.filter((card) => Math.abs(card.getBoundingClientRect().top - firstRow) < 1).length,
  );
  const step =
    event.key === 'ArrowLeft'
      ? -1
      : event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowUp'
          ? -columns
          : columns;
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? cards.length - 1
        : Math.max(0, Math.min(cards.length - 1, current + step));
  event.preventDefault();
  cards[next]?.focus();
}

export function NoiseStudio({
  params,
  projectSeed,
  worldSize,
  heightScale,
  onParam,
  onParams,
}: StudioContext & {
  heightScale: number;
  onParam: (key: string, value: ParamValue) => void;
  onParams: (patch: NoiseParams) => void;
}) {
  const settings = resolveStudioSettings(params);
  const [modal, setModal] = useState<'library' | 'seeds' | 'recipe' | 'export' | null>(null);
  const [reference, setReference] = useState<StudioContext | null>(null);
  const saved = useNoiseCollection();
  const resolvedSeed = resolveNoiseSeed(params, projectSeed);
  const requests = [previewRequest('current', params, projectSeed, worldSize, 160)];
  if (reference)
    requests.push(
      previewRequest(
        'reference',
        reference.params,
        reference.projectSeed,
        reference.worldSize,
        160,
      ),
    );
  const { previews, errors, pendingIds } = useNoisePreviews(requests);
  const sections = [
    ...new Set(
      STUDIO_PARAMS.filter(
        (d) => d.section !== 'Randomness' && studioParamVisible(params, d.key),
      ).map((d) => d.section!),
    ),
  ];
  const apply = (next: NoiseParams) => {
    saved.remember([params, next], projectSeed);
    onParams(next);
    setModal(null);
  };
  const change = (key: string, value: ParamValue) => {
    if (['warpSeed', 'warpOctaves', 'gaborDensity'].includes(key))
      value = Math.round(Number(value));
    if (key === 'blackPoint' && Number(value) > settings.whitePoint - 0.01 + 1e-10) {
      onParams({ blackPoint: value, whitePoint: Math.min(1, Number(value) + 0.01) });
    } else if (key === 'whitePoint' && Number(value) < settings.blackPoint + 0.01 - 1e-10) {
      onParams({ whitePoint: value, blackPoint: Math.max(0, Number(value) - 0.01) });
    } else onParam(key, value);
  };
  return (
    <div className="noise-studio" aria-label="Noise Studio">
      <div className="studio-heading">
        <span className="studio-version">STUDIO 03</span>
        <span>{labelForKernel(settings.kernel)}</span>
      </div>
      <div className={`studio-live-preview ${reference ? 'comparing' : ''}`}>
        {reference && (
          <figure>
            <NoisePreviewCanvas
              preview={previews.reference}
              error={errors.reference}
              pending={pendingIds.includes('reference')}
              label="A: captured noise reference"
            />
            <figcaption>
              <span>A · Reference</span>
              <button
                type="button"
                onClick={() => setReference(null)}
                aria-label="Clear noise reference"
              >
                <X size={11} />
              </button>
            </figcaption>
          </figure>
        )}
        <figure>
          <NoisePreviewCanvas
            preview={previews.current}
            error={errors.current}
            pending={pendingIds.includes('current')}
            label={`${reference ? 'B: current' : 'Current'} ${labelForKernel(settings.kernel)} height preview`}
          />
          <figcaption>
            <span>{reference ? 'B · Current' : 'Height · fixed 0–1 range'}</span>
            <span>{previews.current ? `${previews.current.duration.toFixed(0)} ms` : '—'}</span>
          </figcaption>
        </figure>
      </div>
      <NoiseHistogram preview={previews.current} />
      <div className="studio-range">
        <span>0.000</span>
        <span>HEIGHT DISTRIBUTION</span>
        <span>1.000</span>
      </div>
      <div className="studio-statistics">
        <span>
          Min <output>{previews.current?.minimum.toFixed(3) ?? '—'}</output>
        </span>
        <span>
          Mean <output>{previews.current?.mean.toFixed(3) ?? '—'}</output>
        </span>
        <span>
          Max <output>{previews.current?.maximum.toFixed(3) ?? '—'}</output>
        </span>
      </div>
      {previews.current?.outsideDisplayRange > 0 && (
        <p className="studio-help studio-display-range">
          {((100 * previews.current.outsideDisplayRange) / previews.current.height.length).toFixed(
            1,
          )}
          % of samples lie outside the 0–1 display range. Source exports preserve their values.
        </p>
      )}
      <div className="studio-toolbar">
        <button type="button" onClick={() => setModal('library')}>
          <Grid2X2 size={14} /> Noise library
        </button>
        <button
          type="button"
          onClick={() => setReference({ params: { ...params }, projectSeed, worldSize })}
          title="Capture the current noise and seed for a visual A/B comparison"
        >
          <Layers3 size={14} /> {reference ? 'Replace A' : 'Capture A'}
        </button>
        <button type="button" onClick={() => setModal('recipe')}>
          <Code2 size={14} /> Recipe
        </button>
        <button type="button" onClick={() => setModal('export')}>
          <Download size={14} /> Export source
        </button>
      </div>
      {reference && (
        <p className="studio-help studio-reference-help">
          A retains its captured settings, world seed and tile size. B follows your edits.
        </p>
      )}
      <details className="parameter-section studio-seeds" open>
        <summary>
          Randomness <ChevronDown size={13} />
        </summary>
        <div>
          <div className="studio-seed-heading">
            <span>Reproducible by design</span>
            <button
              type="button"
              className={`studio-seed-lock ${settings.seedLocked ? 'locked' : ''}`}
              aria-pressed={settings.seedLocked}
              onClick={() =>
                onParams(
                  settings.seedLocked
                    ? { seedLocked: false }
                    : { seedLocked: true, lockedSeed: resolvedSeed },
                )
              }
              title={
                settings.seedLocked
                  ? 'Unlock and resume the selected seed mode'
                  : 'Freeze this random stream, including world-seed changes'
              }
            >
              {settings.seedLocked ? <LockKeyhole size={13} /> : <UnlockKeyhole size={13} />}
              {settings.seedLocked ? 'Locked' : 'Lock seed'}
            </button>
          </div>
          <fieldset className="studio-seed-fields" disabled={settings.seedLocked}>
            <label className="studio-field">
              Seed mode
              <select
                aria-label="Noise seed mode"
                value={settings.seedMode}
                onChange={(event) => onParam('seedMode', event.target.value)}
              >
                <option value="linked">Follow world seed</option>
                <option value="fixed">Independent of world seed</option>
              </select>
            </label>
            <div className="studio-seed-value">
              <span>Node seed</span>
              <div>
                <NumberField
                  value={settings.seed}
                  label="Noise node seed"
                  min={0}
                  max={MAX_SEED}
                  step={1}
                  onChange={(seed) => onParam('seed', Math.round(seed))}
                />
                <button
                  type="button"
                  aria-label="Randomize selected noise seed"
                  title="Randomize this noise node"
                  onClick={() => {
                    const next = { ...params, seed: seedNumber() };
                    saved.remember([params, next], projectSeed);
                    onParams(next);
                  }}
                >
                  <Dices size={15} />
                </button>
              </div>
            </div>
            <label className="studio-field">
              Seed name <span className="studio-optional">optional</span>
              <input
                aria-label="Noise seed name"
                type="text"
                maxLength={128}
                placeholder="e.g. north-ridge-07"
                value={settings.seedText}
                onChange={(event) => onParam('seedText', event.target.value)}
                spellCheck={false}
              />
            </label>
            <button
              type="button"
              className="studio-explore-button"
              onClick={() => setModal('seeds')}
            >
              <Grid2X2 size={14} /> Explore 9 seeds <ArrowRight size={13} />
            </button>
          </fieldset>
          <div className="studio-effective-seed">
            <span>{settings.seedLocked ? 'LOCKED STREAM' : 'EFFECTIVE SEED'}</span>
            <output aria-label="Effective noise seed">{resolvedSeed}</output>
          </div>
          <p className="studio-help">
            {settings.seedLocked
              ? 'The random stream is frozen. Unlock to edit seed inputs.'
              : settings.seedMode === 'linked'
                ? `Combined with world seed ${projectSeed}. The seed name is case-sensitive.`
                : 'This node keeps its random stream when the world seed changes. The seed name is case-sensitive.'}
          </p>
        </div>
      </details>
      {sections.map((section) => (
        <details
          className="parameter-section studio-parameter-section"
          key={section}
          open={['Generator', 'Fractal', 'Cellular', 'Gabor', 'Features', 'Pattern'].includes(
            section,
          )}
        >
          <summary>
            {section}
            <ChevronDown size={13} />
          </summary>
          <div>
            {STUDIO_PARAMS.filter(
              (d) => d.section === section && studioParamVisible(params, d.key),
            ).map((d) => (
              <ParamControl
                key={d.key}
                definition={d}
                value={params[d.key] ?? d.default}
                onChange={(value) => change(d.key, value)}
              />
            ))}
            {section === 'Output' && (
              <NoiseCurveEditor
                value={settings.curve}
                onChange={(value) => onParam('curve', value)}
              />
            )}
            {section === 'Fractal' && ['swiss', 'jordan'].includes(settings.fractal) && (
              <p className="studio-help">
                {!studioHasDerivativeGuidance(settings)
                  ? 'Choose a continuous base noise for derivative distortion.'
                  : settings.kernel === 'perlin'
                    ? 'Perlin supplies analytic gradients for derivative distortion.'
                    : 'This base noise uses central-difference gradient estimates for derivative distortion.'}
              </p>
            )}
            {section === 'Sampling' && (
              <p className="studio-help">
                {settings.tiling === 'blend'
                  ? 'Seamless blend matches this source’s opposite borders and, for smooth sources, slopes. It alters the interior distribution; downstream erosion is not periodic.'
                  : 'Filtered sampling reduces unresolved octave detail. Extra samples improve small edges at additional render cost.'}
              </p>
            )}
            {section === 'Distortion' && settings.warpType !== 'none' && (
              <p className="studio-help">
                Displacement is measured in base noise coordinates. Zero amplitude returns the
                undistorted field.
              </p>
            )}
          </div>
        </details>
      ))}
      {saved.storageNotice && (
        <p className="studio-help" role="status">
          {saved.storageNotice}
        </p>
      )}
      {modal === 'library' && (
        <NoiseLibraryDialog
          params={params}
          projectSeed={projectSeed}
          worldSize={worldSize}
          onApply={apply}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'seeds' && (
        <SeedExplorer
          params={params}
          projectSeed={projectSeed}
          worldSize={worldSize}
          collection={saved.collection}
          onFavorite={(candidate) => saved.toggleFavorite(candidate, projectSeed)}
          onApply={apply}
          onClose={() => setModal(null)}
          storageNotice={saved.storageNotice}
        />
      )}
      {modal === 'recipe' && (
        <NoiseRecipeDialog
          params={params}
          projectSeed={projectSeed}
          worldSize={worldSize}
          onApply={apply}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'export' && (
        <NoiseExportDialog
          params={params}
          projectSeed={projectSeed}
          worldSize={worldSize}
          heightScale={heightScale}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

export function NoiseLibraryDialog({
  params,
  projectSeed,
  worldSize,
  onApply,
  onClose,
  adding = false,
}: StudioContext & {
  onApply: (params: NoiseParams) => void;
  onClose: () => void;
  adding?: boolean;
}) {
  const [tab, setTab] = useState<'presets' | 'kernels'>('presets');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const entries: Candidate[] =
    tab === 'presets'
      ? NOISE_PRESETS.map((preset) => ({ ...preset, params: applyNoisePreset(params, preset) }))
      : STUDIO_KERNELS.map(([kernel, name]) => ({
          id: kernel,
          name,
          category: ['cellular', 'sparse', 'crater'].includes(kernel)
            ? 'Spatial features'
            : ['gabor', 'wave', 'dunes', 'strata'].includes(kernel)
              ? 'Directional'
              : 'Base fields',
          description: `${name} as a single layer. Add fractal structure and distortion in the inspector.`,
          params: applyNoisePreset(params, {
            id: kernel,
            name,
            category: '',
            description: '',
            params: { kernel, fractal: 'none' },
          }),
        }));
  const categories = ['All', ...new Set(entries.map((entry) => entry.category))];
  const visible = entries.filter(
    (entry) =>
      (category === 'All' || entry.category === category) &&
      `${entry.name} ${entry.description} ${entry.category} ${entry.params.kernel} ${entry.params.fractal}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const { previews, errors, busy, pendingIds } = useNoisePreviews(
    visible.map((entry) => previewRequest(entry.id, entry.params, projectSeed, worldSize)),
  );
  const selected = visible.find((entry) => entry.id === selectedId) ?? null;
  return (
    <Modal
      title="Noise library"
      eyebrow="STUDIO 03 / GENERATORS"
      onClose={onClose}
      className="studio-modal studio-library-modal"
    >
      <div className="studio-modal-intro">
        <p>Explore real heightfields. Each preview uses your current seed.</p>
        <span>
          {STUDIO_KERNELS.length} base noises · {STUDIO_FRACTALS.length} fractal structures
        </span>
      </div>
      <div className="studio-browser-controls">
        <div className="studio-tabs" role="group" aria-label="Noise library view">
          <button
            type="button"
            aria-pressed={tab === 'presets'}
            onClick={() => {
              setTab('presets');
              setCategory('All');
              setSelectedId(null);
            }}
          >
            Artist presets <span>{NOISE_PRESETS.length}</span>
          </button>
          <button
            type="button"
            aria-pressed={tab === 'kernels'}
            onClick={() => {
              setTab('kernels');
              setCategory('All');
              setSelectedId(null);
            }}
          >
            Base noises <span>{STUDIO_KERNELS.length}</span>
          </button>
        </div>
        <label className="studio-search">
          <Search size={15} />
          <input
            autoFocus
            aria-label="Search noise library"
            placeholder="Find a terrain, texture or generator…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label="Clear noise search">
              <X size={13} />
            </button>
          )}
        </label>
      </div>
      <div className="studio-category-filters" role="group" aria-label="Noise categories">
        {categories.map((name) => (
          <button
            type="button"
            key={name}
            aria-pressed={category === name}
            onClick={() => setCategory(name)}
          >
            {name}
          </button>
        ))}
        <span role="status">
          {busy
            ? 'Rendering previews…'
            : `${visible.length} ${visible.length === 1 ? 'result' : 'results'}`}
        </span>
      </div>
      <div className="studio-browser-scroll">
        <div className="studio-card-grid" onKeyDown={navigateGrid} aria-label="Noise previews">
          {visible.map((entry) => (
            <button
              type="button"
              data-noise-card
              key={entry.id}
              className={`studio-noise-card ${selectedId === entry.id ? 'selected' : ''}`}
              aria-pressed={selectedId === entry.id}
              onClick={() => setSelectedId(entry.id)}
            >
              <NoisePreviewCanvas
                preview={previews[entry.id]}
                error={errors[entry.id]}
                pending={pendingIds.includes(entry.id)}
                label={`${entry.name} height preview`}
              />
              <span className="studio-card-category">
                {entry.category}
                {selectedId === entry.id && <Check size={13} />}
              </span>
              <strong>{entry.name}</strong>
              <span className="studio-card-description">{entry.description}</span>
            </button>
          ))}
        </div>
        {!visible.length && (
          <div className="studio-empty">
            <Search size={24} />
            <strong>No matching noise</strong>
            <p>Try a generator name, terrain feature or category.</p>
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setCategory('All');
              }}
            >
              Clear filters
            </button>
          </div>
        )}
      </div>
      <footer className="studio-modal-footer">
        <div>
          <strong>{selected?.name ?? 'Select a noise to preview its settings'}</strong>
          <p>
            {selected
              ? `${labelForKernel(selected.params.kernel)} · ${STUDIO_FRACTALS.find(([key]) => key === selected.params.fractal)?.[1] ?? 'Single layer'} · seed ${resolveNoiseSeed(selected.params, projectSeed)}`
              : 'Apply a selection when you are ready. Your seed choices are preserved.'}
          </p>
        </div>
        <button type="button" className="button secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="button primary"
          disabled={!selected}
          onClick={() => selected && onApply(selected.params)}
        >
          {adding ? 'Add noise' : 'Apply noise'}
          <ArrowRight size={14} />
        </button>
      </footer>
    </Modal>
  );
}

function createSeedCandidates(params: NoiseParams, includeCurrent: boolean): Candidate[] {
  const seen = new Set<number>();
  return Array.from({ length: 9 }, (_, index) => {
    let seed = includeCurrent && index === 0 ? Number(params.seed ?? 0) : seedNumber();
    while (seen.has(seed)) seed = seedNumber();
    seen.add(seed);
    return {
      id: `seed-${seed}`,
      name:
        includeCurrent && index === 0
          ? 'Current seed'
          : `Variation ${String(index + 1).padStart(2, '0')}`,
      description: `Node seed ${seed}`,
      category: 'Seed variation',
      params: { ...params, seed, seedLocked: false },
    };
  });
}

function SeedExplorer({
  params,
  projectSeed,
  worldSize,
  collection,
  onFavorite,
  onApply,
  onClose,
  storageNotice,
}: StudioContext & {
  collection: NoiseCollection;
  onFavorite: (params: NoiseParams) => void;
  onApply: (params: NoiseParams) => void;
  onClose: () => void;
  storageNotice: string;
}) {
  const [tab, setTab] = useState<'explore' | 'favorites' | 'history'>('explore');
  const [candidates, setCandidates] = useState(() => createSeedCandidates(params, true));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const savedEntries = tab === 'favorites' ? collection.favorites : collection.history;
  const entries =
    tab === 'explore'
      ? candidates
      : savedEntries.map((entry) => ({
          id: entry.id,
          name: entry.name,
          category: 'Saved look',
          description: 'Captured noise controls and locked random stream',
          params: decodeNoiseRecipe(entry.recipe),
        }));
  const { previews, errors, busy } = useNoisePreviews(
    entries.map((entry) => previewRequest(entry.id, entry.params, projectSeed, worldSize, 112)),
  );
  const selected = entries.find((entry) => entry.id === selectedId);
  return (
    <Modal
      title="Seed explorer"
      eyebrow="STUDIO 03 / RANDOMNESS"
      onClose={onClose}
      className="studio-modal studio-seed-modal"
    >
      <div className="studio-modal-intro">
        <p>
          {tab === 'explore'
            ? 'One recipe, nine possible landscapes. Pick the structure that fits.'
            : 'Saved looks restore their noise controls and captured, locked seed.'}
        </p>
        <span>
          {labelForKernel(params.kernel)} · world {projectSeed}
        </span>
      </div>
      <div className="studio-seed-browser-bar">
        <div className="studio-tabs" role="group" aria-label="Seed explorer view">
          <button
            type="button"
            aria-pressed={tab === 'explore'}
            onClick={() => {
              setTab('explore');
              setSelectedId(null);
            }}
          >
            <Grid2X2 size={13} /> Explore
          </button>
          <button
            type="button"
            aria-pressed={tab === 'favorites'}
            onClick={() => {
              setTab('favorites');
              setSelectedId(null);
            }}
          >
            <Bookmark size={13} /> Favorites <span>{collection.favorites.length}</span>
          </button>
          <button
            type="button"
            aria-pressed={tab === 'history'}
            onClick={() => {
              setTab('history');
              setSelectedId(null);
            }}
          >
            <History size={13} /> History <span>{collection.history.length}</span>
          </button>
        </div>
        {tab === 'explore' && (
          <button
            type="button"
            className="studio-reroll"
            onClick={() => {
              setCandidates(createSeedCandidates(params, false));
              setSelectedId(null);
            }}
          >
            <Dices size={14} /> Reroll nine
          </button>
        )}
      </div>
      <div className="studio-browser-scroll">
        <div
          className="studio-card-grid studio-seed-grid"
          onKeyDown={navigateGrid}
          aria-label="Seed previews"
        >
          {entries.map((entry) => {
            const favorite = collection.favorites.some(
              (item) => item.recipe === frozenNoiseRecipe(entry.params, projectSeed),
            );
            return (
              <div
                className={`studio-seed-card ${selectedId === entry.id ? 'selected' : ''}`}
                key={entry.id}
              >
                <button
                  type="button"
                  data-noise-card
                  className="studio-seed-select"
                  aria-pressed={selectedId === entry.id}
                  onClick={() => setSelectedId(entry.id)}
                >
                  <NoisePreviewCanvas
                    preview={previews[entry.id]}
                    error={errors[entry.id]}
                    label={`${entry.name}, effective seed ${resolveNoiseSeed(entry.params, projectSeed)}`}
                  />
                  <span className="studio-seed-card-title">
                    <strong>
                      {tab === 'explore' ? entry.name : labelForKernel(entry.params.kernel)}
                    </strong>
                    {selectedId === entry.id && <Check size={13} />}
                  </span>
                  <span className="studio-seed-card-number">
                    {resolveNoiseSeed(entry.params, projectSeed)}
                  </span>
                </button>
                <button
                  type="button"
                  className={`studio-favorite ${favorite ? 'saved' : ''}`}
                  aria-label={`${favorite ? 'Remove' : 'Save'} favorite seed ${resolveNoiseSeed(entry.params, projectSeed)}`}
                  aria-pressed={favorite}
                  onClick={() => onFavorite(entry.params)}
                >
                  <Bookmark size={14} />
                </button>
              </div>
            );
          })}
        </div>
        {!entries.length && (
          <div className="studio-empty">
            {tab === 'favorites' ? <Bookmark size={25} /> : <History size={25} />}
            <strong>
              {tab === 'favorites'
                ? 'Keep the seeds you love'
                : 'Your explorations will appear here'}
            </strong>
            <p>
              {tab === 'favorites'
                ? 'Bookmark a preview to save its controls and random stream.'
                : 'Applying a noise or randomizing a seed saves a recoverable look.'}
            </p>
            <button type="button" onClick={() => setTab('explore')}>
              Explore seeds
            </button>
          </div>
        )}
      </div>
      <div className="studio-seed-status" role="status">
        {storageNotice ||
          (busy
            ? 'Rendering deterministic previews…'
            : 'Previews use the same sampler as the terrain engine.')}
        <span>
          {collection.favorites.length}/24 favorites · {collection.history.length}/24 recent
        </span>
      </div>
      <footer className="studio-modal-footer">
        <div>
          <strong>
            {selected
              ? `Effective seed ${resolveNoiseSeed(selected.params, projectSeed)}`
              : 'Select a seed variation'}
          </strong>
          <p>
            {selected?.params.seedLocked
              ? 'This saved look will restore with its random stream locked.'
              : 'The terrain changes when you apply your selection.'}
          </p>
        </div>
        <button type="button" className="button secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="button primary"
          disabled={!selected}
          onClick={() => selected && onApply(selected.params)}
        >
          Apply {tab === 'explore' ? 'seed' : 'look'}
          <ArrowRight size={14} />
        </button>
      </footer>
    </Modal>
  );
}

function NoiseRecipeDialog({
  params,
  projectSeed,
  worldSize,
  onApply,
  onClose,
}: StudioContext & { onApply: (params: NoiseParams) => void; onClose: () => void }) {
  const [tab, setTab] = useState<'copy' | 'paste'>('copy');
  const [text, setText] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const exported = encodeNoiseRecipe(params);
  const parsed = useMemo(() => {
    if (!text.trim()) return { params: null, error: '' };
    try {
      return { params: decodeNoiseRecipe(text), error: '' };
    } catch (error) {
      return {
        params: null,
        error: error instanceof Error ? error.message : 'This recipe could not be read.',
      };
    }
  }, [text]);
  const { previews, errors } = useNoisePreviews(
    tab === 'paste' && parsed.params
      ? [previewRequest('recipe', parsed.params, projectSeed, worldSize, 128)]
      : [],
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(exported);
      setCopyStatus('Recipe copied.');
    } catch {
      setCopyStatus('Select the recipe text and copy it with your keyboard.');
    }
  };
  return (
    <Modal
      title="Noise recipe"
      eyebrow="STUDIO 03 / REPRODUCIBILITY"
      onClose={onClose}
      className="studio-modal studio-recipe-modal"
    >
      <div className="studio-modal-intro">
        <p>Share a complete noise: generator, layers, distortion, shaping and seed settings.</p>
        <span>Versioned Studio v3 JSON</span>
      </div>
      <div className="studio-tabs studio-recipe-tabs" role="group" aria-label="Noise recipe action">
        <button type="button" aria-pressed={tab === 'copy'} onClick={() => setTab('copy')}>
          <Clipboard size={14} /> Copy current
        </button>
        <button type="button" aria-pressed={tab === 'paste'} onClick={() => setTab('paste')}>
          <SlidersHorizontal size={14} /> Paste recipe
        </button>
      </div>
      <div className="studio-recipe-content">
        <textarea
          aria-label={tab === 'copy' ? 'Current noise recipe' : 'Paste noise recipe'}
          value={tab === 'copy' ? exported : text}
          readOnly={tab === 'copy'}
          maxLength={20000}
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
          placeholder="Paste a Normal Height Studio noise recipe…"
        />
        {tab === 'copy' ? (
          <p className="studio-help">
            World-linked seeds use the receiving project’s world seed. Lock your seed before copying
            to retain the exact random stream.
          </p>
        ) : parsed.params ? (
          <div className="studio-recipe-valid">
            <NoisePreviewCanvas
              preview={previews.recipe}
              error={errors.recipe}
              label="Imported recipe height preview"
            />
            <div>
              <strong>
                <Check size={14} /> Recipe validated
              </strong>
              <p>
                {labelForKernel(parsed.params.kernel)} · effective seed{' '}
                {resolveNoiseSeed(parsed.params, projectSeed)}
              </p>
              <p>
                {parsed.params.seedLocked
                  ? 'The recipe restores its captured seed lock.'
                  : parsed.params.seedMode === 'fixed'
                    ? 'Independent seed. Noise controls and seed inputs will be restored.'
                    : 'World-linked seed. Your current world seed contributes to the result.'}
              </p>
            </div>
          </div>
        ) : (
          <p
            className={parsed.error ? 'studio-recipe-error' : 'studio-help'}
            role={parsed.error ? 'alert' : undefined}
          >
            {parsed.error || 'The recipe will be validated and previewed before you apply it.'}
          </p>
        )}
        {copyStatus && (
          <p className="studio-help" role="status">
            {copyStatus}
          </p>
        )}
      </div>
      <footer className="studio-modal-footer">
        <div>
          <strong>
            {tab === 'copy' ? labelForKernel(params.kernel) : 'Apply in one undo step'}
          </strong>
          <p>
            {tab === 'copy'
              ? `Effective seed ${resolveNoiseSeed(params, projectSeed)}`
              : 'Recipes include their seed mode and lock state.'}
          </p>
        </div>
        <button type="button" className="button secondary" onClick={onClose}>
          Close
        </button>
        {tab === 'copy' ? (
          <button type="button" className="button primary" onClick={() => void copy()}>
            <Clipboard size={14} /> Copy recipe
          </button>
        ) : (
          <button
            type="button"
            className="button primary"
            disabled={!parsed.params}
            onClick={() => parsed.params && onApply(parsed.params)}
          >
            Apply recipe
            <ArrowRight size={14} />
          </button>
        )}
      </footer>
    </Modal>
  );
}

export const NEW_STUDIO_PARAMS: NoiseParams = { ...STUDIO_DEFAULTS, noiseModel: 'v3' };
