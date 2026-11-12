import { execFileSync } from 'node:child_process';
import { expect } from '@playwright/test';
import type { Browser, CDPSession, Locator, Page, TestInfo } from '@playwright/test';

/** Shared helpers for the opt-in hardware specs in tests/perf. */

export type Quality = 'balanced' | 'high' | 'ultra';
export type Material = 'clay' | 'pbr';

export const parseList = (key: string, fallback: string) =>
  (process.env[key] || fallback).split(',').map((s) => s.trim()).filter(Boolean);

export const requireHardware = process.env.MESH_BENCH_REQUIRE_HARDWARE !== '0' &&
  process.env.MESH_BENCH_SOFTWARE !== '1';

export const terrainCanvas = (page: Page) =>
  page.getByRole('img', { name: /^Interactive 3D terrain\./ });

/** Select field size, mesh fidelity, material and exaggeration through the UI. */
export async function buildTerrain(page: Page, resolution: number, quality: Quality,
  material: Material, exaggeration: number,
): Promise<Locator> {
  await page.getByRole('combobox', { name: 'Working resolution' })
    .selectOption(String(resolution));
  const canvas = terrainCanvas(page);
  await expect(canvas).toHaveAttribute(
    'data-mesh-source-resolution', String(resolution), { timeout: 150_000 },
  );
  await page.getByRole('button', { name: 'Scene', exact: true }).click();
  await page.getByRole('combobox', { name: 'Terrain mesh fidelity' })
    .selectOption(quality);
  await page.getByRole('combobox', { name: 'Surface material' })
    .selectOption(material);
  if (exaggeration !== 1) {
    const spin = page.getByRole('spinbutton', {
      name: 'Vertical exaggeration value',
    });
    await spin.fill(String(exaggeration));
    await spin.press('Enter');
  }
  await expect(canvas).toHaveAttribute('data-mesh-quality', quality);
  await expect(canvas).toHaveAttribute('data-material-status',
    material === 'pbr' ? 'ready' : 'inactive', { timeout: 90_000 });
  await expect(page.locator('.status-bar')).toContainText('Terrain ready');
  return canvas;
}

/** The exact WebGL drawing buffer (preserveDrawingBuffer), not a page screenshot. */
export async function canvasDataUrl(canvas: Locator): Promise<string> {
  const data = await canvas.evaluate((el: HTMLCanvasElement) => el.toDataURL('image/png'));
  expect(data).toMatch(/^data:image\/png;base64,/);
  return data;
}

export async function attachDataUrl(testInfo: TestInfo, label: string, data: string) {
  await testInfo.attach(label, {
    body: Buffer.from(data.split(',')[1], 'base64'),
    contentType: data.slice(5, data.indexOf(';')),
  });
}

/** Refuse to call a software rasterizer a GPU measurement. */
export async function assertHardwareRenderer(canvas: Locator) {
  const renderer = await canvas.evaluate((element: HTMLCanvasElement) => {
    const gl = element.getContext('webgl2');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return gl && debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : 'unavailable';
  });
  if (requireHardware && (renderer === 'unavailable' ||
      /swiftshader|llvmpipe|software|softpipe/i.test(renderer)))
    throw new Error(`Hardware GPU required but WebGL reports "${renderer}".`);
  return renderer;
}

/** Count every Worker the page starts, by script (terrain/pbr/export). */
export async function installWorkerCounter(page: Page) {
  await page.addInitScript(() => {
    const counts: Record<string, number> = {};
    (window as unknown as { __nhWorkerStarts: Record<string, number> }).__nhWorkerStarts = counts;
    const Native = window.Worker;
    class CountingWorker extends Native {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        const name = /(terrain|pbr|export)\.worker/.exec(String(url))?.[1] ?? 'other';
        counts[name] = (counts[name] ?? 0) + 1;
      }
    }
    window.Worker = CountingWorker;
  });
}

export const workerStarts = (page: Page) => page.evaluate(() => ({
  ...(window as unknown as { __nhWorkerStarts: Record<string, number> }).__nhWorkerStarts,
}));

/** Record main-thread long tasks (> 50 ms) with their start times. */
export async function installLongTaskObserver(page: Page) {
  await page.addInitScript(() => {
    const tasks: Array<{ start: number; duration: number }> = [];
    (window as unknown as { __nhLongTasks: typeof tasks }).__nhLongTasks = tasks;
    if (!PerformanceObserver.supportedEntryTypes.includes('longtask')) return;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        tasks.push({ start: entry.startTime, duration: entry.duration });
    }).observe({ entryTypes: ['longtask'] });
  });
}

/** Long-task durations (ms) recorded since `mark` (a performance.now() value). */
export const longTasksSince = (page: Page, mark: number) => page.evaluate((since) =>
  (window as unknown as { __nhLongTasks: Array<{ start: number; duration: number }> })
    .__nhLongTasks.filter((task) => task.start >= since).map((task) => task.duration), mark);

export const pageNow = (page: Page) => page.evaluate(() => performance.now());

/** The Chrome GPU process, whose video memory Windows attributes per process. */
export async function gpuProcessId(browser: Browser): Promise<number | null> {
  try {
    const session = await browser.newBrowserCDPSession();
    const info = await session.send('SystemInfo.getProcessInfo') as {
      processInfo: Array<{ type: string; id: number }>;
    };
    await session.detach();
    return info.processInfo.find((p) => p.type.toLowerCase() === 'gpu')?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Dedicated and shared GPU memory of one process from the Windows
 * "GPU Process Memory" performance counters (what Task Manager shows).
 * Returns null where those counters are unavailable; never a guessed value.
 */
export function gpuProcessMemory(pid: number | null):
  { dedicatedBytes: number; sharedBytes: number } | null {
  if (!pid || process.platform !== 'win32') return null;
  const script = [
    `$s = (Get-Counter -ErrorAction Stop -Counter @(` +
      `'\\GPU Process Memory(pid_${pid}_*)\\Dedicated Usage',` +
      `'\\GPU Process Memory(pid_${pid}_*)\\Shared Usage')).CounterSamples`,
    `$d = ($s | Where-Object { $_.Path -like '*\\dedicated usage' } | Measure-Object CookedValue -Sum).Sum`,
    `$h = ($s | Where-Object { $_.Path -like '*\\shared usage' } | Measure-Object CookedValue -Sum).Sum`,
    `"$d $h"`,
  ].join('; ');
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 30_000, windowsHide: true }).trim();
    const [dedicated, shared] = out.split(/\s+/).map(Number);
    if (!Number.isFinite(dedicated) || !Number.isFinite(shared)) return null;
    return { dedicatedBytes: dedicated, sharedBytes: shared };
  } catch {
    return null;
  }
}

/** JS heap and ArrayBuffer backing stores after a forced full GC. */
export async function heapAfterGc(cdp: CDPSession) {
  await cdp.send('HeapProfiler.collectGarbage');
  const usage = await cdp.send('Runtime.getHeapUsage') as {
    usedSize: number; totalSize: number; backingStorageSize?: number;
  };
  return { jsHeapUsedBytes: usage.usedSize, arrayBufferBytes: usage.backingStorageSize ?? null };
}

/** Mean absolute RGB difference and the share of strongly changed pixels. */
export const imageDelta = (page: Page, a: string, b: string) => page.evaluate(
  async ([first, second]) => {
    const load = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
    const [ia, ib] = await Promise.all([load(first), load(second)]);
    const canvas = new OffscreenCanvas(ia.width, ia.height);
    const context = canvas.getContext('2d')!;
    context.drawImage(ia, 0, 0);
    const da = context.getImageData(0, 0, ia.width, ia.height).data;
    context.clearRect(0, 0, ia.width, ia.height);
    context.drawImage(ib, 0, 0);
    const db = context.getImageData(0, 0, ia.width, ia.height).data;
    let total = 0, changed = 0;
    for (let p = 0; p < da.length; p += 4) {
      const d = (Math.abs(da[p] - db[p]) + Math.abs(da[p + 1] - db[p + 1]) +
        Math.abs(da[p + 2] - db[p + 2])) / 3;
      total += d;
      if (d > 24) changed++;
    }
    const pixels = da.length / 4;
    return { meanAbsDelta: total / pixels, strongChangeFraction: changed / pixels };
  }, [a, b] as const);

type Vec3 = [number, number, number];
type HookWindow = Window & {
  __nhMeshBenchmark?: {
    setCamera: (position: Vec3, target: Vec3) => void;
    heightAt: (x: number, z: number) => number | null;
  };
};

export const setCamera = (page: Page, position: Vec3, target: Vec3) =>
  page.evaluate(([p, t]) => (window as HookWindow).__nhMeshBenchmark!.setCamera(p, t),
    [position, target] as const);

/** Displayed terrain height on an n×n grid over the tile (scene units). */
export const heightGrid = (page: Page, n: number) => page.evaluate((size) => {
  const hooks = (window as HookWindow).__nhMeshBenchmark!;
  const half = 1.3;
  const values: number[] = [];
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++)
    values.push(hooks.heightAt(-half + (2 * half * i) / (size - 1),
      -half + (2 * half * j) / (size - 1)) ?? 0);
  return values;
}, n);

/** Wait until the displayed mesh stops changing (sliced LOD builds settle). */
export async function settleMesh(canvas: Locator, page: Page, quietMs = 700, timeoutMs = 8_000) {
  const started = Date.now();
  let last = await canvas.getAttribute('data-mesh-build-count');
  let stableSince = Date.now();
  while (Date.now() - started < timeoutMs) {
    await page.waitForTimeout(100);
    const now = await canvas.getAttribute('data-mesh-build-count');
    if (now !== last) {
      last = now;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) return;
  }
}
