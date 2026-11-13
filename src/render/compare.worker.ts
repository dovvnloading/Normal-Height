/**
 * Visual-only terrain delta map. A and B are transferred COPIES of the source
 * Float32 height buffers, never detached from the live terrain preview.
 * Negative delta (erosion) is warm; positive delta (deposition/uplift) is cool.
 */
type Request = {
  current: Float32Array; baseline: Float32Array;
  currentSize: number; baselineSize: number;
  currentScale: number; baselineScale: number;
  outputSize: number;
};
const clamp = (x: number) => Math.max(0, Math.min(1, x));
function sample(values: Float32Array, n: number, u: number, v: number) {
  const x = clamp(u) * (n - 1), y = clamp(v) * (n - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(n - 1, x0 + 1), y1 = Math.min(n - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const a = values[y0 * n + x0] * (1 - fx) + values[y0 * n + x1] * fx;
  const b = values[y1 * n + x0] * (1 - fx) + values[y1 * n + x1] * fx;
  return a * (1 - fy) + b * fy;
}
self.onmessage = (event: MessageEvent<Request>) => {
  const { current, baseline, currentSize, baselineSize,
    currentScale, baselineScale, outputSize: n } = event.data;
  const differences = new Float32Array(n * n);
  let maxAbs = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = x / (n - 1), v = y / (n - 1);
    const diff = sample(current, currentSize, u, v) * currentScale -
      sample(baseline, baselineSize, u, v) * baselineScale;
    differences[y * n + x] = diff;
    maxAbs = Math.max(maxAbs, Math.abs(diff));
  }
  const scale = Math.max(maxAbs, 0.00001);
  const rgba = new Uint8ClampedArray(n * n * 4);
  for (let i = 0; i < differences.length; i++) {
    // sqrt mapping makes small changes visible without claiming the gradient
    // is linear. The legend states the actual physical range in meters.
    const t = Math.sqrt(Math.min(1, Math.abs(differences[i]) / scale));
    const positive = differences[i] >= 0;
    const r = positive ? 44 : 166, g = positive ? 132 : 76, b = positive ? 162 : 53;
    rgba[i * 4] = Math.round(39 * (1 - t) + r * t);
    rgba[i * 4 + 1] = Math.round(53 * (1 - t) + g * t);
    rgba[i * 4 + 2] = Math.round(48 * (1 - t) + b * t);
    rgba[i * 4 + 3] = 255;
  }
  self.postMessage({ pixels: rgba, resolution: n, maxAbs },
    { transfer: [rgba.buffer] });
};
