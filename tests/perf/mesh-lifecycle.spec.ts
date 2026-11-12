import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  assertHardwareRenderer, buildTerrain, gpuProcessId, gpuProcessMemory, heapAfterGc,
  installLongTaskObserver, installWorkerCounter, longTasksSince, pageNow, parseList,
  settleMesh, workerStarts,
} from './meshBench';
import type { Quality } from './meshBench';

/**
 * Issue #34 memory/lifetime audit on real hardware: repeated camera zooms,
 * 3D → 2D → split → 3D transitions and PBR material edits must not grow GPU
 * memory, JS heap, live geometries/textures, or rerun terrain/PBR workers
 * because of camera motion. VRAM comes from the Windows per-process GPU
 * counters (Task Manager's source), not from estimates.
 */
const resolutions = parseList('MESH_LIFE_RESOLUTIONS', '512')
  .map(Number).filter((n) => [128, 256, 512, 1024].includes(n));
const quality = (process.env.MESH_LIFE_QUALITY || 'ultra') as Quality;
const cycles = Math.max(3, Number(process.env.MESH_LIFE_CYCLES || 6));
const MB = 1024 * 1024;

for (const resolution of resolutions)
  test(`mesh lifecycle audit: ${resolution}² ${quality} pbr`, async ({ page, browser }, testInfo) => {
    test.setTimeout(900_000);
    await installWorkerCounter(page);
    await installLongTaskObserver(page);
    await page.goto('/?meshBenchmark=adaptive');
    const canvas = await buildTerrain(page, resolution, quality, 'pbr', 1);
    const renderer = await assertHardwareRenderer(canvas);
    const cdp = await page.context().newCDPSession(page);
    const gpuPid = await gpuProcessId(browser);
    const rect = (await canvas.boundingBox())!;
    const cx = rect.x + rect.width * 0.5, cy = rect.y + rect.height * 0.55;
    const counter = async (name: string) => Number(await canvas.getAttribute(name) ?? 0);
    const detail = page.getByRole('spinbutton', { name: 'Microdetail depth value' });

    const sample = async (label: string) => {
      await settleMesh(canvas, page);
      // Draw once in 3D so renderer.info counters are current.
      await page.mouse.move(cx, cy);
      await page.waitForTimeout(150);
      const heap = await heapAfterGc(cdp);
      return {
        label,
        ...heap,
        gpuProcess: gpuProcessMemory(gpuPid),
        liveGeometries: await counter('data-mesh-renderer-geometries'),
        liveTextures: await counter('data-mesh-renderer-textures'),
        liveTerrainMeshes: await counter('data-mesh-build-count') -
          await counter('data-mesh-dispose-count'),
        meshBuilds: await counter('data-mesh-build-count'),
        meshBufferBytes: await counter('data-mesh-buffer-bytes'),
        pbrRequests: await counter('data-pbr-request-count'),
        pbrUploads: await counter('data-pbr-upload-count'),
        workers: await workerStarts(page),
      };
    };

    const samples = [await sample('warm')];
    const phases: Array<Record<string, number[]>> = [];
    for (let cycle = 1; cycle <= cycles; cycle++) {
      const stalls: Record<string, number[]> = {};
      // Camera: fast zoom in, orbit, zoom back out. Must never touch PBR or
      // terrain workers; LOD rebuilds are sliced.
      let mark = await pageNow(page);
      await page.mouse.move(cx, cy);
      for (let i = 0; i < 7; i++) await page.mouse.wheel(0, -240);
      await page.mouse.down();
      await page.mouse.move(cx + 160, cy + 40, { steps: 14 });
      await page.mouse.up();
      for (let i = 0; i < 7; i++) await page.mouse.wheel(0, 240);
      await settleMesh(canvas, page);
      stalls.camera = await longTasksSince(page, mark);
      const afterCamera = await sample(`cycle ${cycle} camera`);

      // Views: 3D → 2D → split → 3D, as an artist compares maps.
      mark = await pageNow(page);
      await page.getByRole('button', { name: '2D map', exact: true }).click();
      await page.waitForTimeout(500);
      await page.getByRole('button', { name: 'Split', exact: true }).click();
      await page.waitForTimeout(700);
      await page.getByRole('button', { name: '3D terrain', exact: true }).click();
      await expect(canvas).toBeVisible();
      await settleMesh(canvas, page);
      stalls.views = await longTasksSince(page, mark);
      const afterViews = await sample(`cycle ${cycle} views`);
      expect(afterViews.pbrUploads, 'view switches must not re-upload PBR maps')
        .toBe(afterCamera.pbrUploads);

      // PBR edit: one microdetail change → exactly one new material upload.
      mark = await pageNow(page);
      await detail.fill(cycle % 2 ? '1.35' : '0.65');
      await detail.press('Enter');
      await expect(canvas).toHaveAttribute('data-pbr-upload-count',
        String(afterViews.pbrUploads + 1), { timeout: 120_000 });
      await expect(canvas).toHaveAttribute('data-material-status', 'ready');
      await page.waitForTimeout(400);
      stalls.pbrEdit = await longTasksSince(page, mark);
      const afterEdit = await sample(`cycle ${cycle} pbr edit`);
      samples.push(afterCamera, afterViews, afterEdit);
      phases.push(stalls);

      expect(afterCamera.pbrUploads, 'camera motion must not re-upload PBR maps')
        .toBe(samples[samples.length - 4].pbrUploads);
      expect(afterEdit.pbrRequests).toBe(afterViews.pbrRequests + 1);
      expect(afterEdit.pbrUploads).toBe(afterViews.pbrUploads + 1);
      for (const s of [afterCamera, afterViews, afterEdit])
        expect(s.liveTerrainMeshes).toBe(1);
    }

    const first = samples[0];
    const end = samples[samples.length - 1];
    // Cycle 1 allocates one-time resources (2D canvases, the edited PBR
    // variant), so growth is judged from cycle 2 on. Each phase (after camera,
    // after views, after PBR edit) is compared only with itself: the GPU
    // process also holds compositor surfaces that differ ±15 MB between
    // phases. A least-squares slope per cycle separates a leak from that noise.
    const baseline = samples[6];
    type Sample = typeof first;
    const slope = (values: number[]) => {
      const mean = (values.length - 1) / 2;
      const average = values.reduce((total, v) => total + v, 0) / values.length;
      let num = 0, den = 0;
      values.forEach((v, i) => { num += (i - mean) * (v - average); den += (i - mean) ** 2; });
      return den ? num / den : 0;
    };
    const trend = (pick: (s: Sample) => number | null) => {
      const slopes = ['camera', 'views', 'pbr edit'].map((kind) => {
        const series = samples.filter((s) => s.label.endsWith(kind)).slice(1)
          .map(pick).filter((v): v is number => v !== null);
        return series.length >= 3 ? slope(series) : null;
      }).filter((v): v is number => v !== null);
      return slopes.length ? Math.max(...slopes) : null;
    };
    const growth = {
      jsHeapMBPerCycle: trend((s) => s.jsHeapUsedBytes / MB),
      arrayBufferMBPerCycle: trend((s) => s.arrayBufferBytes === null ? null : s.arrayBufferBytes / MB),
      gpuDedicatedMBPerCycle: trend((s) => s.gpuProcess ? s.gpuProcess.dedicatedBytes / MB : null),
      gpuSharedMBPerCycle: trend((s) => s.gpuProcess ? s.gpuProcess.sharedBytes / MB : null),
      liveGeometries: end.liveGeometries - baseline.liveGeometries,
      liveTextures: end.liveTextures - baseline.liveTextures,
    };
    const worst = (key: string) => Math.max(0, ...phases.flatMap((p) => p[key] ?? []));
    const result = {
      schema: 1,
      deviceLabel: process.env.MESH_BENCH_DEVICE || 'unlabelled hardware',
      timestamp: new Date().toISOString(),
      renderer,
      gpuProcessId: gpuPid,
      case: { resolution, quality, material: 'pbr', cycles },
      growthFromCycle2: growth,
      worstStallMs: { camera: worst('camera'), views: worst('views'), pbrEdit: worst('pbrEdit') },
      stallsPerCycle: phases,
      terrainWorkerStarts: { warm: first.workers.terrain ?? 0, end: end.workers.terrain ?? 0 },
      pbrWorkerStarts: { warm: first.workers.pbr ?? 0, end: end.workers.pbr ?? 0 },
      samples,
    };
    const dir = join(process.cwd(), 'mesh-benchmark-results', 'lifecycle');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${resolution}-${quality}-pbr.json`);
    await writeFile(file, JSON.stringify(result, null, 2));
    await testInfo.attach(`mesh-lifecycle-${resolution}.json`, {
      path: file, contentType: 'application/json',
    });

    // No terrain recomputation from camera, view or material changes.
    expect(end.workers.terrain ?? 0).toBe(first.workers.terrain ?? 0);
    // Nothing accumulates once every resource has been created once.
    // Live geometry/texture counts are exact leak detectors at any size. The
    // trends bound what they cannot see; a leaked 1024² PBR texture set would
    // add ~16 MB of video memory per cycle.
    expect(growth.liveGeometries).toBeLessThanOrEqual(0);
    expect(growth.liveTextures).toBeLessThanOrEqual(0);
    expect(growth.jsHeapMBPerCycle!).toBeLessThan(1);
    if (growth.arrayBufferMBPerCycle !== null)
      expect(growth.arrayBufferMBPerCycle).toBeLessThan(2);
    if (growth.gpuDedicatedMBPerCycle !== null)
      expect(growth.gpuDedicatedMBPerCycle).toBeLessThan(8);
  });
