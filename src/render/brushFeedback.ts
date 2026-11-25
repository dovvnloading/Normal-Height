import type {
  MaterialStroke,
  PaintPoint,
  PaintMask,
  PaintSelection,
} from '../materials/materialPaint';
import { applyPaintStrokes, getPaintStrokes } from '../materials/paintLayers';
import { requestPBR, pbrVariantKey } from '../materials/pbrClient';
import type { PBRMaps } from '../materials/pbr';
import type { HeightField, TerrainProject } from '../model/types';
import { sampleGrid } from '../model/viewportUX';

export type BrushSettings = Omit<MaterialStroke, 'points'>;
const BRUSH_COLORS: Record<MaterialStroke['layer'], string> = {
  rock: '#989291',
  soil: '#b48662',
  vegetation: '#78934b',
  snow: '#e7f0f3',
  erase: '#70c4c3',
};
export interface LiveBrushPreview {
  field: HeightField;
  project: TerrainProject;
  maps: PBRMaps;
  revision: number;
}
const previewFields = new WeakMap<HeightField, HeightField>();
/** Keep interaction work bounded; the final/export bake always uses the source grid. */
function interactiveField(field: HeightField): HeightField {
  if (field.resolution <= 192) return field;
  const cached = previewFields.get(field);
  if (cached) return cached;
  const n = 192;
  const next: HeightField = {
    resolution: n,
    height: new Float32Array(n * n),
    flow: new Float32Array(n * n),
    wear: new Float32Array(n * n),
    deposition: new Float32Array(n * n),
  };
  for (const key of ['height', 'flow', 'wear', 'deposition'] as const)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++)
        next[key][y * n + x] = sampleGrid(field[key], field.resolution, {
          u: x / (n - 1),
          v: y / (n - 1),
        });
  previewFields.set(field, next);
  return next;
}

/** Drafts never enter project history. Each viewport acknowledges a committed
 * stroke independently, so a fast map cannot clear a slower 3D preview. */
export class BrushFeedback {
  canvas = document.createElement('canvas');
  guideCanvas = document.createElement('canvas');
  guideRevision = 0;
  readonly colors = { ...BRUSH_COLORS };
  revision = 0;
  cursor: PaintPoint | null = null;
  settings: BrushSettings = { layer: 'rock', radius: 0.035, hardness: 0.55, strength: 0.9 };
  overlayOpacity = 0.5;
  showFalloff = true;
  previewBusy = false;
  previewError = '';
  private pending: { stroke: MaterialStroke; waiting: Set<string> }[] = [];
  private draft: MaterialStroke[] = [];
  private listeners = new Set<() => void>();
  private consumers = new Set<string>();
  private frame = 0;
  private dirty = false;
  private held = false;
  private context: { field: HeightField; project: TerrainProject; layerId: string } | null = null;
  private live: LiveBrushPreview | null = null;
  private liveRevision = 0;
  private draftRevision = 0;
  private epoch = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private releasePreview: (() => void) | null = null;
  private guideWorker: Worker | null = null;

  constructor() {
    this.canvas.width = this.canvas.height = 512;
    this.guideCanvas.width = this.guideCanvas.height = 512;
  }
  get drawing() {
    return this.held;
  }
  get hasMarks() {
    return this.draft.length > 0 || this.pending.length > 0;
  }
  get status() {
    if (this.previewError) return 'Live preview unavailable · final material will still update';
    if (this.held) return this.live ? 'Painting · live material' : 'Painting · preparing material';
    return this.pending.length ? 'Refining material…' : 'Ready to paint';
  }

  configure(field: HeightField | null, project: TerrainProject, layerId: string) {
    if (!field) {
      this.context = null;
      this.clear();
      return;
    }
    if (this.context?.field !== field || this.context.layerId !== layerId) this.clear();
    else if (pbrVariantKey(this.context.project) !== pbrVariantKey(project)) {
      this.stopPreview();
      this.refresh(true);
    }
    this.context = { field, project, layerId };
    const size = Math.max(256, Math.min(1024, field.resolution));
    if (this.canvas.width !== size) {
      this.canvas.width = this.canvas.height = size;
      this.refresh(true);
    }
    this.sync(getPaintStrokes(project));
    if (this.hasMarks) this.schedulePreview();
  }

  registerConsumer(id: string) {
    this.consumers.add(id);
    for (const mark of this.pending) mark.waiting.add(id);
    return () => {
      this.consumers.delete(id);
      for (const mark of this.pending) mark.waiting.delete(id);
      this.prunePending();
    };
  }
  hasMarksFor(id: string) {
    return this.draft.length > 0 || this.pending.some((mark) => mark.waiting.has(id));
  }
  liveFor(id: string) {
    return this.hasMarksFor(id) ? this.live : null;
  }

  begin() {
    if (this.held) return false;
    this.held = true;
    this.previewError = '';
    this.refresh(false);
    return true;
  }
  setLayerColors(next: Partial<typeof BRUSH_COLORS>) {
    if (
      Object.entries(next).every(
        ([key, color]) => this.colors[key as MaterialStroke['layer']] === color,
      )
    )
      return;
    Object.assign(this.colors, next);
    this.refresh(this.hasMarks);
  }
  setDisplay(opacity: number, showFalloff: boolean) {
    if (this.overlayOpacity === opacity && this.showFalloff === showFalloff) return;
    this.overlayOpacity = opacity;
    this.showFalloff = showFalloff;
    this.refresh(true);
  }
  setGuides(
    field: HeightField,
    project: TerrainProject,
    masks: (PaintMask | undefined)[],
    selection: PaintSelection | null,
    showMask: boolean,
  ) {
    this.guideWorker?.terminate();
    this.guideWorker = null;
    const context = this.guideCanvas.getContext('2d');
    if (!context) return;
    const size = this.guideCanvas.width;
    context.clearRect(0, 0, size, size);
    const hasRules =
      showMask &&
      masks.some(
        (mask) =>
          mask &&
          (mask.elevation ||
            mask.slope ||
            mask.flow ||
            mask.curvature ||
            mask.aspect ||
            mask.breakup),
      );
    const selected =
      selection && (selection.points.length >= 3 || selection.region) ? selection : undefined;
    const drawVertices = () => {
      const points = selection?.points;
      if (points?.length) {
        context.strokeStyle = '#e1fff2';
        context.fillStyle = '#264a3a';
        context.lineWidth = 2;
        context.setLineDash([5, 4]);
        context.beginPath();
        points.forEach((point, index) =>
          index
            ? context.lineTo(point.u * size, point.v * size)
            : context.moveTo(point.u * size, point.v * size),
        );
        if (points.length >= 3) context.closePath();
        context.stroke();
        context.setLineDash([]);
        for (const point of points) {
          context.beginPath();
          context.arc(point.u * size, point.v * size, 3, 0, Math.PI * 2);
          context.fill();
          context.stroke();
        }
      }
      this.guideRevision++;
      this.refresh(false);
    };
    drawVertices();
    if (!hasRules && !selected) return;
    const worker = new Worker(new URL('./paintGuide.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.guideWorker = worker;
    worker.onmessage = (event: MessageEvent<{ pixels: Uint8ClampedArray; resolution: number }>) => {
      if (this.guideWorker !== worker) return;
      const { pixels, resolution } = event.data;
      const buffer = document.createElement('canvas');
      buffer.width = buffer.height = resolution;
      const ctx = buffer.getContext('2d');
      if (ctx) {
        const raster = ctx.createImageData(resolution, resolution);
        raster.data.set(pixels);
        ctx.putImageData(raster, 0, 0);
        context.clearRect(0, 0, size, size);
        context.drawImage(buffer, 0, 0, size, size);
        drawVertices();
      }
      worker.terminate();
      this.guideWorker = null;
    };
    worker.onerror = () => {
      worker.terminate();
      if (this.guideWorker === worker) this.guideWorker = null;
    };
    worker.postMessage({
      field: interactiveField(field),
      project: { ...project, materialPaint: undefined, paintLayers: undefined },
      masks,
      selection: selected,
      showMask: !!hasRules,
    });
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    listener();
    return () => {
      this.listeners.delete(listener);
    };
  }
  hover(point: PaintPoint | null, settings: BrushSettings) {
    this.cursor = point;
    this.settings = settings;
    this.refresh(false);
  }
  preview(strokes: MaterialStroke[]) {
    this.draft = strokes;
    this.draftRevision++;
    this.refresh(true);
    this.schedulePreview();
  }
  finish(committed: boolean) {
    this.held = false;
    if (committed)
      this.pending.push(
        ...this.draft.map((stroke) => ({ stroke, waiting: new Set(this.consumers) })),
      );
    this.draft = [];
    if (!committed) this.stopPreview();
    else this.schedulePreview();
    this.refresh(true);
  }
  baked(strokes: readonly MaterialStroke[] | undefined, consumer = 'default') {
    const baked = new Set(strokes);
    for (const mark of this.pending)
      if (baked.has(mark.stroke)) {
        if (consumer === 'default') mark.waiting.clear();
        else mark.waiting.delete(consumer);
      }
    this.prunePending();
    this.refresh(true);
  }
  sync(strokes?: readonly MaterialStroke[]) {
    const present = new Set(strokes);
    const next = this.pending.filter((mark) => present.has(mark.stroke));
    if (next.length !== this.pending.length) {
      this.pending = next;
      if (!this.hasMarks) this.stopPreview();
      this.refresh(true);
    }
  }
  clear() {
    this.held = false;
    this.draft = [];
    this.pending = [];
    this.cursor = null;
    this.guideWorker?.terminate();
    this.guideWorker = null;
    this.guideCanvas
      .getContext('2d')
      ?.clearRect(0, 0, this.guideCanvas.width, this.guideCanvas.height);
    this.guideRevision++;
    this.stopPreview();
    this.refresh(true);
  }
  dispose() {
    this.clear();
    this.guideWorker?.terminate();
    this.guideWorker = null;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.listeners.clear();
    this.consumers.clear();
  }
  private prunePending() {
    this.pending = this.pending.filter((mark) => mark.waiting.size > 0);
    if (!this.hasMarks) this.stopPreview();
  }
  private stopPreview() {
    this.epoch++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.releasePreview?.();
    this.releasePreview = null;
    this.previewBusy = false;
    this.live = null;
  }
  private schedulePreview() {
    if (!this.context || !this.hasMarks || this.timer || this.releasePreview) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.bakeDraft();
    }, 90);
  }
  private bakeDraft() {
    const context = this.context;
    if (!context || !this.hasMarks) return;
    const existing = new Set(getPaintStrokes(context.project));
    const marks = [...this.pending.map((mark) => mark.stroke), ...this.draft]
      .filter((stroke) => !existing.has(stroke))
      .map((stroke) => ({ ...stroke, points: stroke.points.map((point) => ({ ...point })) }));
    let project: TerrainProject;
    try {
      project = marks.length
        ? applyPaintStrokes(context.project, marks, context.layerId)
        : context.project;
    } catch {
      return;
    }
    const field = interactiveField(context.field);
    const epoch = this.epoch,
      revision = this.draftRevision;
    const request = requestPBR(field, project);
    this.releasePreview = request.release;
    this.previewBusy = true;
    request.promise
      .then((maps) => {
        if (this.epoch !== epoch || !this.hasMarks) return;
        this.live = { field, project, maps, revision: ++this.liveRevision };
        this.previewError = '';
        this.refresh(true);
      })
      .catch((error) => {
        if (this.epoch === epoch) {
          this.previewError = error instanceof Error ? error.message : 'Preview failed';
          this.refresh(false);
        }
      })
      .finally(() => {
        request.release();
        if (this.epoch !== epoch) return;
        this.releasePreview = null;
        this.previewBusy = false;
        if (revision !== this.draftRevision) this.schedulePreview();
        this.refresh(false);
      });
  }
  private refresh(maskChanged: boolean) {
    this.dirty ||= maskChanged;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.dirty) {
        this.drawMask();
        this.revision++;
        this.dirty = false;
      }
      this.listeners.forEach((listener) => listener());
    });
  }
  private drawMask() {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const n = this.canvas.width;
    ctx.clearRect(0, 0, n, n);
    // Actual PBR replaces this immediate ink guide as soon as a worker result arrives.
    if (this.live) return;
    ctx.lineCap = ctx.lineJoin = 'round';
    for (const stroke of [...this.pending.map((mark) => mark.stroke), ...this.draft]) {
      if (!stroke.points.length) continue;
      ctx.save();
      if (stroke.selection?.points.length) {
        const clip = new Path2D();
        if (stroke.selection.invert) clip.rect(0, 0, n, n);
        stroke.selection.points.forEach((point, index) =>
          index ? clip.lineTo(point.u * n, point.v * n) : clip.moveTo(point.u * n, point.v * n),
        );
        clip.closePath();
        ctx.clip(clip, 'evenodd');
      }
      const path = new Path2D();
      const [first, ...tail] = stroke.points;
      path.moveTo(first.u * n, first.v * n);
      path.lineTo(first.u * n + 0.001, first.v * n);
      for (const p of tail) path.lineTo(p.u * n, p.v * n);
      ctx.strokeStyle = this.colors[stroke.layer];
      let previousAlpha = 0;
      for (let band = 1; band <= 10; band++) {
        const t = band / 10;
        const alpha = t * t * (3 - 2 * t) * stroke.strength * this.overlayOpacity;
        ctx.globalAlpha = (alpha - previousAlpha) / Math.max(0.0001, 1 - previousAlpha);
        ctx.lineWidth = Math.max(
          0.25,
          2 * n * stroke.radius * (1 - (t - 0.05) * (1 - stroke.hardness)),
        );
        ctx.stroke(path);
        previousAlpha = alpha;
      }
      ctx.restore();
    }
  }
}
