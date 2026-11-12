import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { timingDistribution } from '../../src/render/meshDiagnostics';

type Quality = 'balanced' | 'high' | 'ultra';
type Material = 'clay' | 'pbr';
type Reference = 'uniform512' | 'adaptive';
type BenchWindow = Window & {
  __meshLongTasks?: number[];
  __meshCapture?: { running: boolean; samples: number[]; longTaskStart: number };
};

const parseList = (key: string, fallback: string) =>
  (process.env[key] || fallback).split(',').map(s => s.trim()).filter(Boolean);
const resolutions = parseList('MESH_BENCH_RESOLUTIONS', '512')
  .map(Number).filter(n => [128, 256, 512, 1024].includes(n));
const qualities = parseList('MESH_BENCH_QUALITIES', 'high')
  .filter((s): s is Quality => ['balanced', 'high', 'ultra'].includes(s));
const materials = parseList('MESH_BENCH_MATERIALS', 'clay,pbr')
  .filter((s): s is Material => ['clay', 'pbr'].includes(s));
const references: Reference[] = ['uniform512', 'adaptive'];
const requireHardware = process.env.MESH_BENCH_REQUIRE_HARDWARE !== '0' &&
  process.env.MESH_BENCH_SOFTWARE !== '1';

async function beginFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as BenchWindow;
    const capture = {
      running: true, samples: [] as number[],
      longTaskStart: scope.__meshLongTasks?.length ?? 0,
    };
    scope.__meshCapture = capture;
    let previous = 0;
    const frame = (now: number) => {
      if (!capture.running) return;
      if (previous > 0 && capture.samples.length < 5000)
        capture.samples.push(now - previous);
      previous = now;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

async function endFrames(page: Page) {
  const data = await page.evaluate(() => {
    const scope = window as BenchWindow;
    const current = scope.__meshCapture!;
    current.running = false;
    const longTasks = (scope.__meshLongTasks ?? []).slice(current.longTaskStart);
    return { raf: current.samples, longTasks };
  });
  return {
    rafGapsMs: timingDistribution(data.raf),
    mainThreadLongTasksMs: timingDistribution(data.longTasks),
  };
}

async function recordPhase(page: Page, action: () => Promise<void>) {
  await beginFrames(page);
  await action();
  // A short settle window catches the expensive post-orbit LOD update.
  await page.waitForTimeout(400);
  return endFrames(page);
}

async function canvasImage(canvas: Locator, testInfo: TestInfo, label: string) {
  const data = await canvas.evaluate((el: HTMLCanvasElement) => el.toDataURL('image/png'));
  expect(data).toMatch(/^data:image\/png;base64,/);
  await testInfo.attach(label, {
    body: Buffer.from(data.split(',')[1], 'base64'),
    contentType: 'image/png',
  });
}

async function telemetry(canvas: Locator) {
  return canvas.evaluate((element: HTMLCanvasElement) => {
    const d = element.dataset;
    const number = (key: string) => Number(d[key] ?? 0);
    const gl = element.getContext('webgl2');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    const renderer = gl && debug
      ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : 'unavailable';
    const vendor = gl && debug
      ? String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)) : 'unavailable';
    const memory = (performance as Performance & {
      memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
    }).memory;
    let gpuSamples: number[] = [];
    try {
      gpuSamples = JSON.parse(d.meshGpuSamples ?? '[]') as number[];
    } catch {
      // The timer extension is optional; missing data is not a zero GPU time.
    }
    return {
      renderer, vendor,
      dpr: window.devicePixelRatio,
      sourceResolution: number('meshSourceResolution'),
      vertices: number('meshVertices'),
      triangles: number('meshTriangles'),
      maxSegments: number('meshMaxSegments'),
      bufferEstimateBytes: number('meshBufferBytes'),
      geometryCount: number('meshRendererGeometries'),
      textureCount: number('meshRendererTextures'),
      planChecks: number('meshPlanChecks'),
      meshBuilds: number('meshBuildCount'),
      meshDisposals: number('meshDisposeCount'),
      lastMeshPlanCpuMs: number('meshPlanMs'),
      lastMeshBuildCpuMs: number('meshBuildMs'),
      lastRenderSubmissionCpuMs: number('meshRenderCpuMs'),
      pbrRequests: number('pbrRequestCount'),
      pbrUploads: number('pbrUploadCount'),
      pbrWorkerMs: number('pbrWorkerMs'),
      pbrPackCpuMs: number('pbrPackMs'),
      pbrFirstDrawCpuMs: number('pbrFirstRenderMs'),
      gpuTimerSupported: d.meshGpuTimerSupported === 'true',
      gpuSamples,
      jsHeapUsedBytes: memory?.usedJSHeapSize ?? null,
      jsHeapTotalBytes: memory?.totalJSHeapSize ?? null,
    };
  });
}

async function buildTerrain(page: Page, resolution: number, quality: Quality,
  material: Material, exaggeration: number,
) {
  await page.getByRole('combobox', { name: 'Working resolution' })
    .selectOption(String(resolution));
  const canvas = page.getByRole('img', { name: /^Interactive 3D terrain\./ });
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

// Test matrix is environment-selected; the default is a matched-camera
// reference/adaptive pair at 512² for clay and PBR. Full hardware QA uses
// 128,256,512,1024 × balanced,high,ultra × clay,pbr.
for (const resolution of resolutions)
  for (const quality of qualities)
    for (const material of materials)
      for (const reference of references)
        test(`mesh hardware audit: ${resolution}² ${quality} ${material} ${reference}`,
          async ({ page }, testInfo) => {
            test.setTimeout(300_000);
            await page.addInitScript(() => {
              const scope = window as BenchWindow;
              scope.__meshLongTasks = [];
              if (!PerformanceObserver.supportedEntryTypes.includes('longtask')) return;
              const observer = new PerformanceObserver((list) => {
                for (const entry of list.getEntries())
                  scope.__meshLongTasks!.push(entry.duration);
              });
              observer.observe({ entryTypes: ['longtask'] });
            });
            const started = Date.now();
            await page.goto(`/?meshBenchmark=${reference}`);
            const exaggeration = Number(process.env.MESH_BENCH_EXAGGERATION || 1);
            const canvas = await buildTerrain(
              page, resolution, quality, material, exaggeration,
            );
            const readyMs = Date.now() - started;
            const initial = await telemetry(canvas);
            if (requireHardware && (
              initial.renderer === 'unavailable' ||
              /swiftshader|llvmpipe|software|softpipe/i.test(initial.renderer)
            )) throw new Error(
              `Hardware GPU required but WebGL reports "${initial.renderer}". ` +
              'Run on a GPU-enabled device, or explicitly set MESH_BENCH_SOFTWARE=1.',
            );

            const rect = await canvas.boundingBox();
            expect(rect).not.toBeNull();
            const cx = rect!.x + rect!.width * 0.5;
            const cy = rect!.y + rect!.height * 0.55;

            const phases: Record<string, Awaited<ReturnType<typeof recordPhase>>> = {};
            phases.idle = await recordPhase(page,
              () => page.waitForTimeout(1200));
            phases.orbit = await recordPhase(page, async () => {
              await page.mouse.move(cx, cy);
              await page.mouse.down();
              await page.mouse.move(cx + 140, cy + 56, { steps: 16 });
              await page.mouse.up();
            });
            await canvasImage(canvas, testInfo, 'ridge-orbit.png');
            phases.pan = await recordPhase(page, async () => {
              await page.mouse.move(cx, cy);
              await page.mouse.down({ button: 'right' });
              await page.mouse.move(cx - 65, cy + 55, { steps: 12 });
              await page.mouse.up({ button: 'right' });
            });
            phases.zoom = await recordPhase(page, async () => {
              await page.mouse.move(cx, cy);
              for (let i = 0; i < 7; i++) await page.mouse.wheel(0, -220);
            });
            await canvasImage(canvas, testInfo, 'near-cliff.png');
            phases.focus = await recordPhase(page, async () => {
              await canvas.dblclick({ position: {
                x: rect!.width * 0.48, y: rect!.height * 0.47,
              } });
            });
            phases.postLodIdle = await recordPhase(page,
              () => page.waitForTimeout(1100));

            // A reversible expanded-ground transition exercises the
            // terrain/apron boundary, geometry disposal, and real preview.
            const display = page.getByRole('button', { name: 'Display settings' });
            await display.click();
            await page.getByRole('checkbox', { name: 'Expand ground' }).check();
            await page.waitForTimeout(550);
            await canvasImage(canvas, testInfo, 'ground-apron.png');
            await page.getByRole('checkbox', { name: 'Expand ground' }).uncheck();
            await display.click();

            const after = await telemetry(canvas);
            expect(after.meshBuilds - after.meshDisposals).toBe(1);
            expect(after.geometryCount).toBeLessThan(40);
            expect(after.vertices).toBeGreaterThan(0);
            expect(after.bufferEstimateBytes).toBeLessThan(100_000_000);
            if (reference === 'uniform512')
              expect(after.triangles).toBe(8 * 8 * 2 * 64 * 64);

            const gpuTime = after.gpuTimerSupported
              ? timingDistribution(after.gpuSamples) : null;
            // A WebGL timer query, when supported, measures GPU work. RAF
            // gaps are scheduler/jank measurements, never called GPU time.
            const result = {
              schema: 1,
              deviceLabel: process.env.MESH_BENCH_DEVICE || 'unlabelled hardware',
              timestamp: new Date().toISOString(),
              environment: {
                gpuRenderer: after.renderer, gpuVendor: after.vendor,
                nodePlatform: process.platform,
                headless: process.env.MESH_BENCH_HEADLESS === '1',
                software: process.env.MESH_BENCH_SOFTWARE === '1',
                viewport: { width: 1440, height: 1000, dpr: after.dpr },
              },
              case: { resolution, quality, material, reference, exaggeration },
              readinessMs: readyMs,
              initial: { ...initial, gpuSamples: undefined },
              final: { ...after, gpuSamples: undefined },
              gpuDrawTimeMs: gpuTime,
              phases,
              caveats: [
                'RAF gaps include browser scheduling and JS stalls; they are not GPU timings.',
                'GPU timer values are supplied only when the WebGL disjoint timer extension works.',
                'Geometry byte sizes are CPU-side buffer estimates, not measured video RAM.',
                'A source 128² DEM cannot gain true new gullies from preview tessellation.',
              ],
            };
            const id = `${resolution}-${quality}-${material}-${reference}`;
            const dir = join(process.cwd(), 'mesh-benchmark-results', 'summary');
            await mkdir(dir, { recursive: true });
            const file = join(dir, `${id}.json`);
            await writeFile(file, JSON.stringify(result, null, 2));
            await testInfo.attach(`mesh-hardware-${id}.json`, {
              path: file, contentType: 'application/json',
            });
            const limit = Number(process.env.MESH_BENCH_MAX_RAF_P95_MS ?? 0);
            if (limit > 0)
              expect(phases.orbit.rafGapsMs.p95Ms).toBeLessThanOrEqual(limit);
          });
