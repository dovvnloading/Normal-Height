import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { createNode } from '../../src/model/registry';
import { STUDIO_DEFAULTS } from '../../src/model/noiseStudio';
import { createWorldDefinition } from '../../src/model/world';
import type { TerrainProject } from '../../src/model/types';
import { verifyWorldProfileArchive } from './helpers/world-profile-archive';

// Manual/label-triggered qualification, deliberately skipped by normal CI:
// WORLD_BROWSER_PROFILE=1 npx playwright test tests/e2e/world-highres.spec.ts --workers=1
// Run against the normal production build/preview, not a mocked evaluator.
test.use({ video: 'off', trace: 'off' });
test.describe.configure({ retries: 0 });

function fixture(): TerrainProject {
  const source = createNode('noise', { x: 0, y: 0 }, 'source');
  source.label = 'Native Perlin';
  source.params = {
    ...STUDIO_DEFAULTS,
    noiseModel: 'v3',
    kernel: 'perlin',
    fractal: 'none',
    warpType: 'none',
    scale: 8.4,
    seed: 713,
    sampling: 'point',
    rotation: 17,
    amplitude: 1,
    offset: 0,
  };
  const remap = createNode('remap', { x: 240, y: 0 }, 'remap');
  remap.params = { contrast: 1.2, brightness: -0.05, gamma: 1.15, clamp: false };
  const terrace = createNode('terrace', { x: 480, y: 0 }, 'terrace');
  terrace.params = { steps: 19, softness: 0.75 };
  const output = createNode('output', { x: 720, y: 0 }, 'output');
  const nodes = [source, remap, terrace, output];
  const project: TerrainProject = {
    version: 2,
    name: 'World browser native graph profile',
    seed: 24062,
    resolution: 128,
    worldSize: 12000,
    heightScale: 1800,
    presetId: 'custom',
    graph: {
      nodes,
      edges: nodes.slice(1).map((node, i) => ({
        id: `edge-${i}`,
        source: nodes[i].id,
        target: node.id,
        sourceHandle: 'height',
        targetHandle: 'in',
      })),
    },
  };
  project.world = createWorldDefinition(project);
  project.world.domain.cellsX = project.world.domain.cellsZ = 8192;
  project.world.tileCells = 256;
  project.world.globalResolution = 64;
  project.world.backend = 'cpu-reference';
  return project;
}

interface HeapReading {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}
interface BrowserObservation {
  elapsedMs: number;
  heartbeat: {
    intervalMs: number;
    observedGaps: number;
    p95GapMs: number;
    maxGapMs: number;
    p95ExcessDelayMs: number;
    maxExcessDelayMs: number;
  };
  heap: {
    available: boolean;
    before: HeapReading | null;
    after: HeapReading | null;
    peakSampledUsedJSHeapSizeBytes: number | null;
    samples: number;
    caveat: string;
  };
}
type ProfileWindow = Window & { __stopWorldBrowserProfile?: () => BrowserObservation };

async function startBrowserObservation(page: Page) {
  await page.evaluate(() => {
    const target = window as ProfileWindow;
    target.__stopWorldBrowserProfile?.();
    const intervalMs = 25;
    const started = performance.now();
    let last = started,
      peakHeap = 0,
      heapSamples = 0;
    const gaps: number[] = [];
    const heap = (): HeapReading | null => {
      const value = (performance as Performance & { memory?: HeapReading }).memory;
      if (!value || !Number.isFinite(value.usedJSHeapSize)) return null;
      heapSamples++;
      peakHeap = Math.max(peakHeap, value.usedJSHeapSize);
      return {
        usedJSHeapSize: value.usedJSHeapSize,
        totalJSHeapSize: value.totalJSHeapSize,
        jsHeapSizeLimit: value.jsHeapSizeLimit,
      };
    };
    const before = heap();
    const timer = window.setInterval(() => {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
      heap();
    }, intervalMs);
    target.__stopWorldBrowserProfile = () => {
      window.clearInterval(timer);
      const finished = performance.now();
      gaps.push(finished - last);
      const after = heap();
      const sorted = [...gaps].sort((a, b) => a - b);
      const p95 = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
      const max = sorted.at(-1)!;
      return {
        elapsedMs: finished - started,
        heartbeat: {
          intervalMs,
          observedGaps: gaps.length,
          p95GapMs: p95,
          maxGapMs: max,
          p95ExcessDelayMs: Math.max(0, p95 - intervalMs),
          maxExcessDelayMs: Math.max(0, max - intervalMs),
        },
        heap: {
          available: before !== null || after !== null,
          before,
          after,
          peakSampledUsedJSHeapSizeBytes: heapSamples ? peakHeap : null,
          samples: heapSamples,
          caveat:
            'Chromium performance.memory is nonstandard and may be quantized or shared. These sampled renderer JavaScript heap values are not total browser/process memory, worker heap, GPU memory, or a complete allocation peak.',
        },
      };
    };
  });
}

async function stopBrowserObservation(page: Page) {
  return page.evaluate(() => {
    const target = window as ProfileWindow;
    const result = target.__stopWorldBrowserProfile?.() ?? null;
    delete target.__stopWorldBrowserProfile;
    return result;
  });
}

test('actual CPU World UI downloads and independently verifies 4096 and 8192 PNG16 samples', async ({
  page,
  browser,
}, info) => {
  test.skip(
    process.env.WORLD_BROWSER_PROFILE !== '1',
    'Opt in with WORLD_BROWSER_PROFILE=1; this is a measured 4K/8K browser profile.',
  );
  test.setTimeout(600_000);
  const project = fixture();
  const projectJSON = JSON.stringify(project);
  const errors: string[] = [];
  const downloads: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  const results: Record<string, unknown>[] = [];
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    status: 'running',
    startedAt: new Date().toISOString(),
    source: {
      githubSHA: process.env.GITHUB_SHA ?? null,
      githubHeadRef: process.env.GITHUB_HEAD_REF ?? null,
      githubRun: process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : null,
      buildProvenance:
        'Each verified export includes its actual manifest.build below; GITHUB_SHA can be the CI merge commit.',
    },
    environment: {
      node: process.version,
      os: `${platform()} ${release()}`,
      cpu: cpus()[0]?.model ?? null,
      browser: browser.browserType().name(),
      browserVersion: browser.version(),
      viewport: info.project.use.viewport,
      headless: info.project.use.headless ?? true,
      editorViewportMode:
        '2D map, explicitly selected before opening World Studio; the 3D viewport is hidden and terrain drawing is paused.',
    },
    fixture: { sha256: createHash('sha256').update(projectJSON).digest('hex'), project },
    scope: {
      export:
        'Actual World Studio button through production export worker, ACK/backpressure, in-memory Blob download, and completed Playwright download. Each export starts a fresh worker; requested dimensions are samples, not intervals.',
      heartbeat:
        'A renderer main-thread 25 ms timer runs from immediately before the export button action until the download completes. Gaps include UI updates, Blob publication, automation scheduling, and browser/host contention. No universal performance threshold is asserted.',
      verification:
        'Separate Node phase; independent ZIP central-directory/CRC32 and PNG chunk CRC32/zlib/filter decoding, every tile and shared edge. Verification time is excluded from browser export time.',
      memory:
        'Only optional sampled performance.memory renderer heap is measured. Manifest memory values are conservative estimates and are labelled separately.',
      limitations:
        'One simple native CPU graph, height PNG16 only, one run per size. No erosion, global simulations, masks, normals, diagnostics, transport, GPU compute, file-system picker sink, or external engine import is qualified by this profile.',
    },
    results,
  };
  try {
    await page.goto('/');
    await page.getByLabel('Import terrain project file').setInputFiles({
      name: 'world-browser-profile.nhterrain.json',
      mimeType: 'application/json',
      buffer: Buffer.from(projectJSON),
    });
    await expect(page.getByRole('button', { name: project.name, exact: true })).toBeVisible();
    await expect(
      page.getByRole('contentinfo').getByText('Terrain ready', { exact: true }),
    ).toBeVisible({ timeout: 90_000 });
    await page.getByRole('button', { name: '2D map', exact: true }).click();
    await expect(page.getByRole('button', { name: '2D map', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('.nh-three-pane')).toBeHidden();
    report.browserEnvironment = await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemoryGiB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
      devicePixelRatio,
      visibilityState: document.visibilityState,
    }));
    await page.getByRole('button', { name: 'World Studio', exact: true }).click();
    const dialog = page.getByRole('region', { name: 'World Studio', exact: true });
    await expect(dialog.getByText('World overview ready', { exact: true })).toBeVisible({
      timeout: 90_000,
    });
    await dialog.getByRole('tab', { name: 'Simulate', exact: true }).click();
    await dialog.getByText('Compute & local cache', { exact: true }).click();
    await expect(dialog.getByLabel('World compute backend')).toHaveValue('cpu-reference');
    await expect(dialog.getByLabel('Remember completed CPU regions')).not.toBeChecked();
    await expect(dialog.getByLabel('Enable world transport')).not.toBeChecked();
    await dialog.getByRole('tab', { name: 'Deliver', exact: true }).click();
    await dialog.getByLabel('World export profile').selectOption('generic');
    await dialog.getByLabel('World height format').selectOption('png16');
    await dialog.getByLabel('Flow, wear & deposition', { exact: true }).uncheck();
    await dialog.getByLabel('Terrain normal map', { exact: true }).uncheck();
    const button = dialog.getByRole('button', { name: 'Download world package', exact: true });
    const map = dialog.locator('.wv-plane > .wv-field > canvas.wv-raster').last();
    const previewHash = async () =>
      createHash('sha256')
        .update(await map.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL()))
        .digest('hex');

    // Cancel real worker computation, retain the last complete preview, and
    // immediately run another export. Any late cancelled download is caught by
    // the observed filenames/count through the two complete runs below.
    const beforeCancel = await previewHash();
    await dialog.getByLabel('World export samples').selectOption('8192');
    await expect(button).toBeEnabled();
    const cancelStart = performance.now();
    await button.click();
    await expect(dialog.locator('.we-export-job-stage')).toContainText(
      'Measuring common elevation range',
      {
        timeout: 90_000,
      },
    );
    const cancelledPhase = await dialog.locator('.we-export-job-stage').innerText();
    const cancelActionStart = performance.now();
    await dialog.getByRole('button', { name: 'Cancel export', exact: true }).click();
    await expect(
      dialog.getByText('Export cancelled. Your world is unchanged.', { exact: true }),
    ).toBeVisible();
    const cancelActionThroughVisibleStatusMs = performance.now() - cancelActionStart;
    await expect(button).toBeEnabled();
    const afterCancel = await previewHash();
    expect(afterCancel).toBe(beforeCancel);
    expect(downloads).toEqual([]);
    report.cancellation = {
      requestedSamples: [8192, 8192],
      observedPhase: cancelledPhase,
      elapsedUntilCancelledMs: performance.now() - cancelStart,
      cancelActionThroughVisibleStatusMs,
      lastCompletePreviewSha256: beforeCancel,
      retainedPreviewSha256: afterCancel,
      retainedCompletePreview: true,
      downloadsImmediatelyAfterCancel: 0,
      observation:
        'The cancelled run is followed by two full exports; no cancelled/stale download may appear during either run.',
    };

    for (const samples of [4096, 8192]) {
      const result: Record<string, unknown> = { samples: [samples, samples], status: 'running' };
      results.push(result);
      await dialog.getByLabel('World export samples').selectOption(String(samples));
      await expect(button).toBeEnabled();
      await startBrowserObservation(page);
      const begin = performance.now();
      let downloadedPath: string | null = null;
      try {
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 480_000 }),
          button.click(),
        ]);
        downloadedPath = await download.path();
        result.exportThroughCompletedDownloadMs = performance.now() - begin;
        result.filename = download.suggestedFilename();
        expect(await download.failure()).toBeNull();
        expect(downloadedPath).toBeTruthy();
        expect(download.suggestedFilename()).toContain(String(samples));
      } finally {
        result.browserObservation = await stopBrowserObservation(page).catch(() => null);
      }
      await expect(dialog.getByRole('button', { name: 'Cancel export', exact: true })).toHaveCount(
        0,
      );
      await expect(button).toBeEnabled();
      await expect(
        dialog.getByRole('region', { name: 'Last completed world export' }),
      ).toContainText(result.filename as string);
      const verificationStart = performance.now();
      result.archive = verifyWorldProfileArchive(await readFile(downloadedPath!), {
        samples,
        seed: project.seed,
        stageKinds: ['noise', 'remap', 'terrace', 'output'],
      });
      result.independentVerificationMs = performance.now() - verificationStart;
      result.status = 'verified';
      expect(downloads).toHaveLength(results.length);
      expect(await previewHash()).toBe(beforeCancel);
      const observation = result.browserObservation as BrowserObservation;
      expect(observation.heartbeat.observedGaps).toBeGreaterThan(1);
      expect(Number.isFinite(observation.heartbeat.maxGapMs)).toBe(true);
      // Persist each completed result so a later failure does not erase actual
      // measurements already obtained at the smaller dimension.
      await writeFile(
        info.outputPath('world-browser-profile.json'),
        JSON.stringify(report, null, 2),
      );
    }
    expect(downloads).toHaveLength(2);
    expect(errors).toEqual([]);
    report.status = 'passed';
    report.noStaleDownloadAfterCancellation = true;
    try {
      await page.screenshot({
        path: info.outputPath('world-browser-8192-complete.png'),
        timeout: 30_000,
      });
    } catch (error) {
      report.screenshotError = error instanceof Error ? error.message : String(error);
    }
  } catch (error) {
    report.status = 'failed';
    report.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    report.observedDownloads = downloads;
    report.pageErrors = errors;
    const path = info.outputPath('world-browser-profile.json');
    await writeFile(path, JSON.stringify(report, null, 2));
    await info.attach('world-browser-profile', { path, contentType: 'application/json' });
  }
});
