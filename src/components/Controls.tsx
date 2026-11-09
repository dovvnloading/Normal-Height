import { useEffect, useState } from 'react';
import { Dices, Info } from 'lucide-react';
import type { ParamDefinition, ParamValue } from '../model/types';

export function NumberField({
  value,
  onChange,
  min = -1e9,
  max = 1e9,
  step = 1,
  label,
  className = '',
  unit,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  className?: string;
  unit?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(Math.round(value * 100000) / 100000)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (draft.trim() && Number.isFinite(n)) {
      const next = Math.min(max, Math.max(min, n));
      onChange(next);
      setDraft(String(next));
    } else setDraft(String(value));
  };
  return (
    <span className={`number-field ${className}`}>
      <input
        aria-label={label}
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            e.currentTarget.blur();
          }
          if (e.key === 'Escape') {
            setDraft(String(value));
            e.currentTarget.blur();
          }
        }}
      />
      {unit && <span>{unit}</span>}
    </span>
  );
}
export function ParamControl({
  definition: d,
  value,
  onChange,
}: {
  definition: ParamDefinition;
  value: ParamValue;
  onChange: (value: ParamValue) => void;
}) {
  const id = `param-${d.key}`;
  if (d.type === 'toggle')
    return (
      <label className="toggle-row" htmlFor={id}>
        <span>
          {d.label}
          {d.description && (
            <Info size={12} className="help-icon" aria-label={d.description}>
              <title>{d.description}</title>
            </Info>
          )}
        </span>
        <input
          id={id}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="switch" aria-hidden="true" />
      </label>
    );
  if (d.type === 'select')
    return (
      <div className="parameter">
        <label htmlFor={id}>{d.label}</label>
        <select id={id} value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {d.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {d.key === 'mode' && value === 'naki' && (
          <p className="parameter-hint">
            An independent warped lobe pattern inspired by Naki. Not a reproduction of Maxon’s
            algorithm.
          </p>
        )}
      </div>
    );
  if (d.type === 'text')
    return (
      <div className="parameter">
        <label htmlFor={id}>{d.label}</label>
        <textarea
          id={id}
          rows={5}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          maxLength={4000}
        />
      </div>
    );
  return (
    <div className="parameter" title={d.description}>
      <div className="parameter-top">
        <label htmlFor={id}>{d.label}</label>
        <NumberField
          value={Number(value)}
          onChange={onChange}
          min={d.min}
          max={d.max}
          step={d.step}
          label={`${d.label} value`}
          unit={d.unit}
        />
        {d.key === 'seed' && (
          <button
            className="icon-button small"
            title="Randomize node seed"
            aria-label="Randomize node seed"
            onClick={() => onChange(crypto.getRandomValues(new Uint32Array(1))[0] % 2147483647)}
          >
            <Dices size={15} />
          </button>
        )}
      </div>
      {d.type === 'range' && (
        <input
          id={id}
          type="range"
          min={d.min}
          max={d.max}
          step={d.step}
          value={Number(value)}
          onChange={(e) => onChange(Number(e.target.value))}
          style={
            {
              '--range-progress': `${((Number(value) - (d.min ?? 0)) / ((d.max ?? 1) - (d.min ?? 0))) * 100}%`,
            } as React.CSSProperties
          }
        />
      )}
    </div>
  );
}
