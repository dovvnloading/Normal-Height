import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { unzipSync, unzlibSync } from 'fflate';
import type { TerrainProject } from '../../src/model/types';

function fastProject(resolution: 512 | 1024): TerrainProject {
  // A real, fast procedural mountain -> output graph. Full-size PBR generation
  // is exercised without unrelated, multi-minute hydraulic erosion runs.
  return {
    version: 1, name: `PBR acceptance ${resolution}`,
    seed: 48271, resolution, worldSize: 8000, heightScale: 2400,
    presetId: 'custom',
    graph: {
      nodes: [
        { id: 'source', kind: 'mountain', label: 'Analytic-fast source',
          params: { profile: 'massif', scale: 3.2 }, position: { x: 80, y: 100 } },
        { id: 'out', kind: 'output', label: 'Terrain output',
          params: {}, position: { x: 390, y: 100 } },
      ],
      edges: [{ id: 'height-to-output', source: 'source', target: 'out',
        sourceHandle: 'height', targetHandle: 'in' }],
    },
  };
}

async function loadFastProject(page: Page, n: 512 | 1024) {
  await page.goto('/');
  await page.getByLabel('Import terrain project file', { exact: true }).setInputFiles({
    name: 'pbr-acceptance.nhterrain.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(fastProject(n))),
  });
  await expect(page.locator('.project-name')).toContainText(`PBR acceptance ${n}`);
  await expect(page.locator('.status-bar')).toContainText('Terrain ready', { timeout: 90_000 });
  await expect(page.locator('.nh-render-progress')).toHaveCount(0);
  await expect(page.locator('.graph-error')).toHaveCount(0);
}

function mapCanvas(page: Page) {
  return page.locator('.nh-map canvas').first();
}

async function mapColors(page: Page) {
  return mapCanvas(page).evaluate((canvas: HTMLCanvasElement) => {
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set<number>();
    for (let i = 0; i < data.length; i += 388)
      if (data[i + 3]) colors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    return colors.size;
  });
}

async function mapHash(page: Page) {
  return mapCanvas(page).evaluate((canvas: HTMLCanvasElement) => {
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    for (let i = 0; i < pixels.length; i += 97)
      hash = Math.imul(hash ^ pixels[i], 16777619);
    return hash >>> 0;
  });
}

function decodePNG(bytes: Uint8Array) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  expect(Array.from(bytes.subarray(0, 8))).toEqual(signature);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const compressed: Uint8Array[] = [];
  let width = 0, height = 0, depth = 0, type = 0;
  for (let off = 8; off < bytes.length;) {
    const length = view.getUint32(off);
    const tag = new TextDecoder().decode(bytes.subarray(off + 4, off + 8));
    const chunk = bytes.subarray(off + 8, off + 8 + length);
    if (tag === 'IHDR') {
      const hdr = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      width = hdr.getUint32(0); height = hdr.getUint32(4);
      depth = chunk[8]; type = chunk[9];
    } else if (tag === 'IDAT') compressed.push(chunk);
    off += length + 12;
    if (tag === 'IEND') break;
  }
  expect(type === 6 || type === 0).toBe(true);
  const length = compressed.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const part of compressed) { joined.set(part, offset); offset += part.length; }
  const inflated = unzlibSync(joined);
  const pixelBytes = depth === 16 && type === 0 ? 2 : 4;
  const rowBytes = width * pixelBytes;
  expect(inflated.length).toBe(height * (rowBytes + 1));
  const pixels = new Uint8Array(height * rowBytes);
  for (let row = 0; row < height; row++) {
    // Normal Height intentionally emits filter-0 scanlines; this also
    // verifies each row boundary and north-first orientation is preserved.
    expect(inflated[row * (rowBytes + 1)]).toBe(0);
    pixels.set(inflated.subarray(row * (rowBytes + 1) + 1, (row + 1) * (rowBytes + 1)), row * rowBytes);
  }
  return { width, height, depth, type, pixels };
}

for (const resolution of [512, 1024] as const) {
  test(`rapid material edits use a responsive worker at ${resolution}² (#10)`, async ({ page }, testInfo) => {
    test.skip(resolution === 1024 && !process.env.PBR_BROWSER_BENCH,
      '1K performance profile runs in the opt-in browser QA workflow.');
    test.setTimeout(150_000);
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await loadFastProject(page, resolution);
    await page.getByRole('button', { name: 'Split', exact: true }).click();
    await page.getByRole('combobox', { name: 'Map channel' }).selectOption('basecolor');
    const gl = page.getByRole('img', { name: /^Interactive 3D terrain/ });
    await expect(gl).toHaveAttribute('data-material-status', 'ready', { timeout: 45_000 });
    await expect.poll(() => mapColors(page), { timeout: 45_000 }).toBeGreaterThan(8);
    const original = await mapHash(page);
    await page.getByRole('button', { name: 'Scene', exact: true }).click();

    await page.evaluate(() => {
      const state = { frames: 0, maxFrameGapMs: 0, gaps: [] as number[], last: performance.now(), active: true };
      (window as typeof window & { __pbrFrameAudit?: typeof state }).__pbrFrameAudit = state;
      const tick = (t: number) => {
        if (!state.active) return;
        state.frames++;
        state.gaps.push(t - state.last);
        state.maxFrameGapMs = Math.max(state.maxFrameGapMs, t - state.last);
        state.last = t;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    for (const biome of ['volcanic', 'alpine', 'arid']) {
      await page.getByLabel('Material biome').selectOption(biome);
    }
    await expect.poll(() => mapHash(page), { timeout: 60_000 }).not.toBe(original);
    await expect(gl).toHaveAttribute('data-material-status', 'ready', { timeout: 60_000 });
    const stats = await page.evaluate(() => {
      const audit = (window as typeof window & {
        __pbrFrameAudit: { frames: number; maxFrameGapMs: number; gaps: number[]; active: boolean }
      }).__pbrFrameAudit;
      audit.active = false;
      const sorted = [...audit.gaps].sort((a, b) => a - b);
      const percentile = (p: number) => sorted[Math.floor((sorted.length - 1) * p)] ?? 0;
      return {
        frames: audit.frames,
        maxFrameGapMs: audit.maxFrameGapMs,
        p95FrameGapMs: percentile(0.95),
        p99FrameGapMs: percentile(0.99),
      };
    });
    await testInfo.attach(`pbr-latency-${resolution}.json`, {
      body: JSON.stringify(stats, null, 2), contentType: 'application/json',
    });
    expect(stats.frames).toBeGreaterThan(8);
    // A single cold SwiftShader texture upload or headless scheduling pause
    // can take >1.5 s, so the maximum is recorded rather than misrepresented
    // as an interactive FPS budget. Require sustained frame responsiveness
    // (p95), plus a coarse guard against completely wedged UI execution.
    expect(stats.p95FrameGapMs).toBeLessThan(500);
    expect(stats.maxFrameGapMs).toBeLessThan(5000);
    expect(errors).toEqual([]);
    const file = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save project', exact: true }).click();
    const download = await file;
    const target = testInfo.outputPath(`accepted-${resolution}.nhterrain.json`);
    await download.saveAs(target);
    const project = JSON.parse(await readFile(target, 'utf8')) as TerrainProject;
    expect(project.surface?.biome).toBe('arid');
  });
}

test('1K browser export decodes every PBR PNG and aligns with the visible 2D map (#17)', async ({ page }, testInfo) => {
  test.skip(!process.env.PBR_BROWSER_BENCH,
    '1K full ZIP pixel audit runs in opt-in browser QA, not every commit.');
  test.setTimeout(240_000);
  await loadFastProject(page, 1024);
  await page.getByRole('button', { name: '2D map', exact: true }).click();
  await page.getByRole('combobox', { name: 'Map channel' }).selectOption('basecolor');
  await expect.poll(() => mapColors(page), { timeout: 60_000 }).toBeGreaterThan(8);
  const previews = await mapCanvas(page).evaluate((canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect();
    const side = Math.max(1, Math.min(rect.width - 84, rect.height - 82));
    const left = (rect.width - side) / 2, top = (rect.height - side) / 2;
    const ctx = canvas.getContext('2d')!;
    return [[0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8], [0.5, 0.5]].map(([u, v]) => {
      const x = Math.min(canvas.width - 1, Math.floor((left + u * side) * canvas.width / rect.width));
      const y = Math.min(canvas.height - 1, Math.floor((top + v * side) * canvas.height / rect.height));
      return { u, v, rgb: Array.from(ctx.getImageData(x, y, 1, 1).data.subarray(0, 3)) };
    });
  });
  await page.getByRole('button', { name: 'Export maps', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export your landscape', exact: true });
  await dialog.getByRole('combobox', { name: 'Export format' }).selectOption('pbr');
  await dialog.getByRole('combobox', { name: 'Export resolution' }).selectOption('1024');
  const downloading = page.waitForEvent('download', { timeout: 180_000 });
  await dialog.getByRole('button', { name: 'Export bundle', exact: true }).click();
  const download = await downloading;
  const path = testInfo.outputPath('pbr-1024-pixel-audit.zip');
  await download.saveAs(path);
  const files = unzipSync(new Uint8Array(await readFile(path)));
  const prefix = 'pbr-acceptance-1024-1024-';
  const channels = [
    'basecolor', 'normal-gl', 'normal-dx', 'detailnormal-gl', 'roughness',
    'ao', 'metallic', 'orm', 'splat-rgba', 'curvature', 'unity-hdrp-mask',
  ] as const;
  const decoded = Object.fromEntries(channels.map(name => {
    const image = decodePNG(files[prefix + name + '.png']);
    expect([image.width, image.height, image.depth, image.type]).toEqual([1024, 1024, 8, 6]);
    return [name, image];
  })) as Record<(typeof channels)[number], ReturnType<typeof decodePNG>>;
  const height = decodePNG(files[prefix + 'height16.png']);
  expect([height.width, height.height, height.depth, height.type]).toEqual([1024, 1024, 16, 0]);
  const metadata = JSON.parse(new TextDecoder().decode(files['pbr-acceptance-1024-material-metadata.json']));
  expect(metadata.sampleSpacingMeters).toBeCloseTo(8000 / 1023, 7);
  expect(metadata.textureChannels.basecolor.colorSpace).toBe('sRGB');

  const pixels = (name: (typeof channels)[number]) => decoded[name].pixels;
  const gl = pixels('normal-gl'), dx = pixels('normal-dx'), detail = pixels('detailnormal-gl');
  const rough = pixels('roughness'), ao = pixels('ao'), orm = pixels('orm');
  const mask = pixels('unity-hdrp-mask'), splat = pixels('splat-rgba');
  for (let i = 0; i < 1024 * 1024; i += 37) {
    const p = i * 4;
    expect(dx[p]).toBe(gl[p]);
    expect(dx[p + 1] + gl[p + 1]).toBe(255);
    expect(dx[p + 2]).toBe(gl[p + 2]);
    expect(detail[p + 3]).toBe(255);
    expect(orm[p]).toBe(ao[p]);
    expect(orm[p + 1]).toBe(rough[p]);
    expect(orm[p + 2]).toBe(0);
    expect(mask[p]).toBe(0);
    expect(mask[p + 1]).toBe(ao[p]);
    expect(mask[p + 2]).toBe(255);
    expect(mask[p + 3]).toBe(255 - rough[p]);
    expect(splat[p] + splat[p + 1] + splat[p + 2] + splat[p + 3]).toBe(255);
  }
  const albedo = pixels('basecolor');
  for (const { u, v, rgb } of previews) {
    const x = Math.floor(u * 1023), y = Math.floor(v * 1023);
    const offset = (y * 1024 + x) * 4;
    // Canvas preview is downsampled with bilinear filtering; exported data is
    // an unfiltered 1024² texture in the same north-first world orientation.
    for (let c = 0; c < 3; c++)
      expect(Math.abs(rgb[c] - albedo[offset + c])).toBeLessThanOrEqual(35);
  }
});

test('PBR bundle exports a source-only graph with shared diagnostic buffers (#11)', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await loadFastProject(page, 512);
  await page.getByRole('button', { name: 'Export maps', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export your landscape', exact: true });
  await dialog.getByRole('combobox', { name: 'Export format' }).selectOption('pbr');
  await dialog.getByRole('combobox', { name: 'Export resolution' }).selectOption('256');
  const downloading = page.waitForEvent('download', { timeout: 60_000 });
  await dialog.getByRole('button', { name: 'Export bundle', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('pbr-acceptance-512-256-pbr.zip');
  const target = testInfo.outputPath('pbr-source-only-shared-buffers.zip');
  await download.saveAs(target);
  const files = unzipSync(new Uint8Array(await readFile(target)));
  expect(files['pbr-acceptance-512-256-basecolor.png']).toBeDefined();
  expect(files['pbr-acceptance-512-256-height16.png']).toBeDefined();
  expect(errors).toEqual([]);
});

test('2K PBR preflight fails gracefully on constrained devices before starting a Worker (#11)', async ({ page }) => {
  await loadFastProject(page, 512);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'deviceMemory', { value: 2, configurable: true });
    const scope = window as Window & typeof globalThis & { __workersCreated: number };
    scope.__workersCreated = 0;
    const Original = window.Worker;
    window.Worker = class extends Original {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        scope.__workersCreated++;
      }
    };
  });
  const before = await page.evaluate(() => (window as Window & typeof globalThis & { __workersCreated: number }).__workersCreated);
  await page.getByRole('button', { name: 'Export maps', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export your landscape', exact: true });
  await dialog.getByRole('combobox', { name: 'Export format' }).selectOption('pbr');
  await dialog.getByRole('combobox', { name: 'Export resolution' }).selectOption('2048');
  await dialog.getByRole('button', { name: 'Export bundle', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('above the');
  await expect(dialog.getByRole('alert')).toContainText('Choose a smaller resolution');
  const after = await page.evaluate(() => (window as Window & typeof globalThis & { __workersCreated: number }).__workersCreated);
  expect(after).toBe(before);
});
