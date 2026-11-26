import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertCircle, ChevronDown } from 'lucide-react';

export const worldNumber = (value: number, digits = 1) =>
  Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: digits }) : '—';
export const worldDistance = (value: number) =>
  Math.abs(value) >= 1000 ? `${worldNumber(value / 1000, 2)} km` : `${worldNumber(value, 2)} m`;
export const worldMemory = (bytes: number) => `${worldNumber(bytes / 1048576)} MiB`;

/** Keep incomplete numeric text local; a cleared field must never become zero. */
export function WorldNumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit = 'm',
  hint,
  disabled,
}: {
  label: string;
  value: number;
  onChange(value: number): void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  hint?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState('');
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setDraft(String(value));
    setError('');
  }, [value]);
  const commit = () => {
    const next = Number(draft);
    if (!draft.trim() || !Number.isFinite(next)) {
      setError('Enter a number.');
      return;
    }
    if (min !== undefined && next < min) {
      setError(`Use ${worldNumber(min, 4)} or more.`);
      return;
    }
    if (max !== undefined && next > max) {
      setError(`Use ${worldNumber(max, 4)} or less.`);
      return;
    }
    if (step === 1 && !Number.isSafeInteger(next)) {
      setError('Use a whole number.');
      return;
    }
    setError('');
    if (next !== value) onChange(next);
  };
  return (
    <label className={`we-field ${error ? 'is-invalid' : ''}`}>
      <span>{label}</span>
      <span className="we-number-input">
        <input
          ref={input}
          type="number"
          inputMode="decimal"
          aria-label={label}
          value={draft}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          aria-invalid={!!error}
          aria-describedby={error || hint ? id : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            setError('');
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              input.current?.blur();
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setDraft(String(value));
              setError('');
            }
          }}
        />
        {unit && <small>{unit}</small>}
      </span>
      {(error || hint) && (
        <small id={id} className={error ? 'we-field-error' : 'we-field-hint'}>
          {error || hint}
        </small>
      )}
    </label>
  );
}

export function WorldSlider({
  label,
  value,
  onChange,
  min,
  max,
  step = 0.01,
  unit = '',
  description,
}: {
  label: string;
  value: number;
  onChange(value: number): void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  description?: string;
}) {
  return (
    <div className="we-slider-field">
      <WorldNumberField
        label={label}
        value={value}
        onChange={onChange}
        min={min}
        max={max}
        step={step}
        unit={unit}
      />
      <input
        type="range"
        aria-label={`Adjust ${label.toLowerCase()}`}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {description && <p className="we-hint">{description}</p>}
    </div>
  );
}

export function WorldPanelHeading({
  eyebrow,
  title,
  children,
}: {
  eyebrow?: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="we-panel-heading">
      {eyebrow && <span className="we-eyebrow">{eyebrow}</span>}
      <h2>{title}</h2>
      {children && <p>{children}</p>}
    </header>
  );
}
export function WorldSection({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="we-section">
      <div className="we-section-heading">
        <h3>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}
export function WorldDisclosure({
  title,
  children,
  open,
}: {
  title: string;
  children: ReactNode;
  open?: boolean;
}) {
  return (
    <details className="we-disclosure" open={open}>
      <summary>
        {title}
        <ChevronDown size={14} />
      </summary>
      <div>{children}</div>
    </details>
  );
}
export function WorldNotice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <div className={`we-notice ${error ? 'is-error' : ''}`} role={error ? 'alert' : undefined}>
      <AlertCircle size={15} />
      <div>{children}</div>
    </div>
  );
}
export function WorldMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail?: string;
}) {
  return (
    <div className="we-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}
