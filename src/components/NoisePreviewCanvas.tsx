import { useEffect, useRef } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { NoisePreview } from '../hooks/noisePreviewProtocol';

/** A fixed 0–1 display range keeps comparisons honest, including clipped output. */
export function NoisePreviewCanvas({
  preview,
  error,
  label,
  pending = false,
  className = '',
}: {
  preview?: NoisePreview;
  error?: string;
  label: string;
  pending?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !preview) return;
    canvas.width = preview.resolution;
    canvas.height = preview.resolution;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return;
    const image = context.createImageData(preview.resolution, preview.resolution);
    for (let i = 0; i < preview.height.length; i++) {
      const value = Math.round(Math.min(1, Math.max(0, preview.height[i])) * 255);
      image.data[i * 4] = value;
      image.data[i * 4 + 1] = value;
      image.data[i * 4 + 2] = value;
      image.data[i * 4 + 3] = 255;
    }
    context.putImageData(image, 0, 0);
  }, [preview]);
  return (
    <div className={`studio-preview-map ${className}`} aria-busy={pending || (!preview && !error)}>
      <canvas ref={ref} role="img" aria-label={label} hidden={!preview} />
      {!preview && (
        <span className={`studio-preview-placeholder ${error ? 'has-error' : ''}`}>
          {error ? (
            'Preview unavailable'
          ) : (
            <>
              <LoaderCircle size={18} aria-hidden="true" /> Rendering
            </>
          )}
        </span>
      )}
      {pending && preview && (
        <span className="studio-preview-updating">
          <LoaderCircle size={12} aria-hidden="true" /> Updating
        </span>
      )}
      {error && (
        <span className="studio-preview-error" role="status" title={error}>
          Preview unavailable
        </span>
      )}
    </div>
  );
}

export function NoiseHistogram({ preview }: { preview?: NoisePreview }) {
  if (!preview) return <div className="studio-histogram empty" aria-hidden="true" />;
  const maximum = Math.max(1, ...preview.histogram);
  return (
    <div
      className="studio-histogram"
      role="img"
      aria-label={`Height distribution on a fixed zero-to-one display range. Minimum ${preview.minimum.toFixed(3)}, mean ${preview.mean.toFixed(3)}, maximum ${preview.maximum.toFixed(3)}.`}
    >
      {preview.histogram.map((count, i) => (
        <span key={i} style={{ height: `${Math.max(1, (100 * count) / maximum)}%` }} />
      ))}
    </div>
  );
}
