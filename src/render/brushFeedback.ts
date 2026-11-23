import type { MaterialStroke, PaintPoint } from '../materials/materialPaint';

export type BrushSettings = Omit<MaterialStroke, 'points'>;
const BRUSH_COLORS: Record<MaterialStroke['layer'], string> = {
  rock: '#989291', soil: '#b48662', vegetation: '#78934b', snow: '#e7f0f3', erase: '#70c4c3',
};

/** Transient coverage overlay shared by both viewports. Completed marks stay
 * visible until their material bake arrives. The project only receives strokes
 * at pointer-up, so a gesture makes one undo step and one worker request. */
export class BrushFeedback {
  canvas = document.createElement('canvas');
  readonly colors = { ...BRUSH_COLORS };
  revision = 0;
  cursor: PaintPoint | null = null;
  settings: BrushSettings = { layer: 'rock', radius: 0.035, hardness: 0.55, strength: 0.9 };
  private pending: MaterialStroke[] = [];
  private draft: MaterialStroke[] = [];
  private listeners = new Set<() => void>();
  private frame = 0;
  private dirty = false;
  private held = false;

  get drawing() { return this.held; }

  begin() {
    if (this.held) return false;
    this.held = true;
    return true;
  }

  setLayerColors(next: Partial<typeof BRUSH_COLORS>) {
    if (Object.entries(next).every(([key, color]) =>
      this.colors[key as MaterialStroke['layer']] === color)) return;
    Object.assign(this.colors, next);
    this.refresh(this.hasMarks);
  }

  get hasMarks() { return this.draft.length > 0 || this.pending.length > 0; }

  constructor() {
    this.canvas.width = this.canvas.height = 512;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    listener();
    return () => { this.listeners.delete(listener); };
  }

  hover(point: PaintPoint | null, settings: BrushSettings) {
    this.cursor = point;
    this.settings = settings;
    this.refresh(false);
  }

  preview(strokes: MaterialStroke[]) {
    this.draft = strokes;
    this.refresh(true);
  }

  finish(committed: boolean) {
    this.held = false;
    if (committed) this.pending.push(...this.draft);
    this.draft = [];
    this.refresh(true);
  }

  baked(strokes?: MaterialStroke[]) {
    this.retainPending(s => !strokes?.includes(s));
  }

  sync(strokes?: MaterialStroke[]) {
    this.retainPending(s => !!strokes?.includes(s));
  }

  private retainPending(keep: (stroke: MaterialStroke) => boolean) {
    const next = this.pending.filter(keep);
    if (next.length === this.pending.length) return;
    this.pending = next;
    this.refresh(true);
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
      this.listeners.forEach(listener => listener());
    });
  }

  private drawMask() {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const n = this.canvas.width;
    ctx.clearRect(0, 0, n, n);
    ctx.lineCap = ctx.lineJoin = 'round';
    for (const stroke of [...this.pending, ...this.draft]) {
      const path = new Path2D();
      const [first, ...tail] = stroke.points;
      path.moveTo(first.u * n, first.v * n);
      // A sub-pixel segment gives a click the same round cap as a drag.
      path.lineTo(first.u * n + 0.001, first.v * n);
      for (const p of tail) path.lineTo(p.u * n, p.v * n);
      ctx.strokeStyle = this.colors[stroke.layer];
      let previousAlpha = 0;
      for (let band = 1; band <= 10; band++) {
        const t = band / 10;
        const alpha = t * t * (3 - 2 * t) * stroke.strength * 0.78;
        ctx.globalAlpha = (alpha - previousAlpha) / (1 - previousAlpha);
        ctx.lineWidth = Math.max(0.25, 2 * n * stroke.radius * (1 - (t - 0.05) * (1 - stroke.hardness)));
        ctx.stroke(path);
        previousAlpha = alpha;
      }
    }
    ctx.globalAlpha = 1;
  }
}
