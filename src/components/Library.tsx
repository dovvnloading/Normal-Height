import { useState } from 'react';
import {
  Search,
  MountainSnow,
  Waves,
  Wind,
  Droplets,
  Layers3,
  Combine,
  SlidersHorizontal,
  ScanLine,
  StickyNote,
  ArrowUpRight,
  Dices,
  ChevronRight,
  Sparkles,
  Plus,
  X,
} from 'lucide-react';
import { NODE_DEFINITIONS, NOISE_MODES } from '../model/registry';
import { PRESETS } from '../model/presets';
import { NumberField } from './Controls';
import type { NodeKind, ParamValue } from '../model/types';

const icons = {
  mountain: MountainSnow,
  noise: Waves,
  warp: Wind,
  hydraulic: Droplets,
  thermal: Layers3,
  terrace: Layers3,
  remap: SlidersHorizontal,
  blend: Combine,
  mask: ScanLine,
  output: ArrowUpRight,
  note: StickyNote,
  group: Layers3,
};
export function NodeIcon({ kind, size = 17 }: { kind: NodeKind; size?: number }) {
  const Icon = icons[kind];
  return <Icon size={size} />;
}
interface Props {
  seed: number;
  onSeed: (seed: number) => void;
  onAdd: (kind: NodeKind, params?: Record<string, ParamValue>) => void;
  onPreset: (id: string) => void;
  activePreset: string;
  compact?: boolean;
}
export function Library({ seed, onSeed, onAdd, onPreset, activePreset, compact = false }: Props) {
  const [tab, setTab] = useState<'nodes' | 'presets'>('nodes');
  const [search, setSearch] = useState('');
  const groups = ['Source', 'Shape', 'Simulate', 'Combine', 'Utility'];
  const query = search.trim().toLowerCase();
  const matches = Object.values(NODE_DEFINITIONS).filter(
    (d) =>
      d.kind !== 'group' &&
      `${d.label} ${d.category} ${d.description}`.toLowerCase().includes(query),
  );
  return (
    <aside className={`library panel ${compact ? 'compact' : ''}`} aria-label="Node library">
      <div className="panel-tabs">
        <button className={tab === 'nodes' ? 'active' : ''} onClick={() => setTab('nodes')}>
          <Layers3 size={14} />
          Nodes
        </button>
        <button className={tab === 'presets' ? 'active' : ''} onClick={() => setTab('presets')}>
          <MountainSnow size={14} />
          Landscapes
        </button>
      </div>
      <div className="library-scroll">
        {tab === 'nodes' ? (
          <>
            <div className="search-box">
              <Search size={14} />
              <input
                aria-label="Search nodes"
                placeholder="Find a node…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search ? (
                <button
                  className="icon-button small"
                  aria-label="Clear search"
                  onClick={() => setSearch('')}
                >
                  <X size={12} />
                </button>
              ) : (
                <kbd>/</kbd>
              )}
            </div>
            {groups.map((category) => {
              const items = matches.filter((n) => n.category === category);
              if (!items.length) return null;
              return (
                <section className="library-category" key={category}>
                  <h3>
                    {category === 'Source'
                      ? 'Generators'
                      : category === 'Simulate'
                        ? 'Erosion & weathering'
                        : category === 'Shape'
                          ? 'Shape & transform'
                          : category === 'Combine'
                            ? 'Combine & mask'
                            : 'Utilities'}
                    <span>{items.length}</span>
                  </h3>
                  {items.map((d) => (
                    <button
                      key={d.kind}
                      className="library-node"
                      title={d.description}
                      onClick={() => onAdd(d.kind)}
                    >
                      <span className="library-node-icon" style={{ color: d.color }}>
                        <NodeIcon kind={d.kind} />
                      </span>
                      <span>
                        <strong>{d.label}</strong>
                        <small>
                          {d.kind === 'mountain'
                            ? 'Connected landforms'
                            : d.kind === 'noise'
                              ? '12 seeded noise families'
                              : d.kind === 'hydraulic'
                                ? 'Water & sediment'
                                : d.kind === 'thermal'
                                  ? 'Talus & loose material'
                                  : d.kind === 'warp'
                                    ? 'Distort coordinates'
                                    : d.kind === 'terrace'
                                      ? 'Layered strata'
                                      : d.kind === 'remap'
                                        ? 'Elevation distribution'
                                        : d.kind === 'blend'
                                          ? 'Mix two heightfields'
                                          : d.kind === 'mask'
                                            ? 'Select regions'
                                            : d.kind === 'note'
                                              ? 'Document your process'
                                              : 'Final heightfield'}
                        </small>
                      </span>
                      <Plus size={13} className="library-add" />
                    </button>
                  ))}
                </section>
              );
            })}
            <details className="noise-library" open={query.length > 0 || undefined}>
              <summary>
                <Waves size={14} />
                Noise families<span>12</span>
                <ChevronRight size={13} />
              </summary>
              <div>
                {NOISE_MODES.filter(
                  (n) => !query || n.label.toLowerCase().includes(query) || query === 'noise',
                ).map((n, i) => (
                  <button onClick={() => onAdd('noise', { mode: n.value })} key={n.value}>
                    <span className="noise-index">{String(i + 1).padStart(2, '0')}</span>
                    {n.label}
                    <Plus size={12} />
                  </button>
                ))}
              </div>
            </details>
            {matches.length === 0 &&
              !NOISE_MODES.some((n) => n.label.toLowerCase().includes(query)) && (
                <div className="search-empty">
                  No matching nodes.<button onClick={() => setSearch('')}>Clear search</button>
                </div>
              )}
            <div className="library-help">
              <span>Click to add to your graph.</span>
              <span>Drag between labeled ports to connect.</span>
            </div>
          </>
        ) : (
          <>
            <div className="preset-intro">
              <div className="eyebrow">START WITH A LANDSCAPE</div>
              <p>Fully editable graphs. A different way into the same terrain engine.</p>
            </div>
            {PRESETS.map((p, i) => (
              <button
                className={`preset-card ${activePreset === p.id ? 'active' : ''}`}
                onClick={() => onPreset(p.id)}
                key={p.id}
              >
                <div
                  className="preset-visual"
                  style={{ '--preset-color': p.color } as React.CSSProperties}
                >
                  <svg viewBox="0 0 200 70" aria-hidden="true">
                    {[0, 1, 2, 3, 4].map((j) => (
                      <path
                        key={j}
                        d={
                          i === 3
                            ? `M-10 ${68 + j * 8} Q40 ${62 + j * 4} 70 ${20 + j * 7} L88 ${28 + j * 6} L108 ${18 + j * 7} Q145 ${65 + j * 5} 215 ${70 + j * 6}`
                            : `M-10 ${56 + j * 8} Q20 ${70 + j * 3} 45 ${28 + j * 7} Q65 ${j * 8} 85 ${34 + j * 5} Q105 ${60 + j * 5} 128 ${14 + j * 7} Q148 ${-4 + j * 7} 175 ${40 + j * 5} L215 ${60 + j * 5}`
                        }
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={j === 0 ? 1.5 : 1}
                        opacity={0.8 - j * 0.12}
                      />
                    ))}
                  </svg>
                  <span>{String(i + 1).padStart(2, '0')}</span>
                  {activePreset === p.id && <span className="preset-loaded">LOADED</span>}
                </div>
                <div className="preset-card-copy">
                  <span className="eyebrow">{p.eyebrow}</span>
                  <strong>{p.name}</strong>
                  <p>{p.description}</p>
                </div>
              </button>
            ))}
          </>
        )}
      </div>
      {!compact && (
        <div className="world-seed">
          <div className="world-seed-label">
            <Sparkles size={12} />
            <span>WORLD SEED</span>
            <span className="seed-dot" />
          </div>
          <div className="world-seed-input">
            <NumberField
              value={seed}
              label="World seed"
              min={0}
              max={2147483647}
              step={1}
              onChange={(v) => onSeed(Math.floor(v))}
            />
            <button
              className="icon-button"
              aria-label="Randomize world seed"
              title="Explore another terrain seed"
              onClick={() => onSeed(crypto.getRandomValues(new Uint32Array(1))[0] % 2147483647)}
            >
              <Dices size={17} />
            </button>
          </div>
          <p>Same seed. Same landscape.</p>
        </div>
      )}
    </aside>
  );
}
