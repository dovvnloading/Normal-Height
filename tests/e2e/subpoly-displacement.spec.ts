import { expect, test, type Locator, type Page } from '@playwright/test';
import type { TerrainProject } from '../../src/model/types';
import type { MeshBenchmarkHooks } from '../../src/render/TerrainScene';

test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

const flatProject = {
  version: 1, name: 'Displacement test plane', presetId: 'custom', seed: 7831,
  resolution: 128, worldSize: 128, heightScale: 32, surface: { detailStrength: 0, detailMeters: 8 },
  graph: {
    nodes: [
      { id: 'flat', kind: 'noise', label: 'Level ground', params: { amplitude: 0, offset: 0.5 },
        position: { x: 0, y: 0 } },
      { id: 'out', kind: 'output', label: 'Terrain output', params: {}, position: { x: 250, y: 0 } },
    ],
    edges: [{ id: 'field', source: 'flat', target: 'out', sourceHandle: 'height', targetHandle: 'in' }],
  },
} satisfies Omit<TerrainProject, 'surface'> & { surface: Partial<NonNullable<TerrainProject['surface']>> };

type BenchmarkWindow = Window & { __nhMeshBenchmark?: MeshBenchmarkHooks };

/** With a level DEM and a fixed grazing camera, a normal map cannot bend the horizon.
 * Find the first non-sky pixel in each central column of the actual WebGL frame. */
async function skyline(canvas: Locator) {
  return canvas.evaluate((source: HTMLCanvasElement) => {
    const { width, height } = source;
    const target = new OffscreenCanvas(width, height);
    const ctx = target.getContext('2d')!;
    ctx.drawImage(source, 0, 0);
    const { data } = ctx.getImageData(0, 0, width, height);
    const rows: number[] = [];
    for (let x = Math.floor(width * 0.2); x < width * 0.8; x += 2) {
      const sky = x * 4;
      let y = 1;
      for (; y < height; y++) {
        const i = (y * width + x) * 4;
        if (Math.max(Math.abs(data[i] - data[sky]), Math.abs(data[i + 1] - data[sky + 1]),
          Math.abs(data[i + 2] - data[sky + 2])) > 20) break;
      }
      rows.push(y);
    }
    rows.sort((a, b) => a - b);
    const p10 = rows[Math.floor(rows.length * 0.1)], p90 = rows[Math.floor(rows.length * 0.9)];
    return { p10, p90, spread: p90 - p10, height };
  });
}

// Read the actual WebGL canvas without Playwright's compositor/layout-stability
// wait, which can stall under SwiftShader even after the pixel assertion passes.
async function captureCanvas(canvas: Locator): Promise<Buffer> {
  return Buffer.from(await canvas.evaluate((source: HTMLCanvasElement) =>
    source.toDataURL('image/png').split(',')[1]), 'base64');
}

/** Probe several interior points of every tile on the installed triangle mesh.
 * The level terrain fixture makes all observed height variation attributable to displacement. */
function displacedTiles(page: Page) {
  return page.evaluate(() => {
    const { heightAt } = (window as BenchmarkWindow).__nhMeshBenchmark!;
    let count = 0;
    for (let row = 0; row < 8; row++) for (let column = 0; column < 8; column++) {
      const heights: number[] = [];
      for (const v of [0.2, 0.5, 0.8]) for (const u of [0.2, 0.5, 0.8]) {
        const x = ((column + u) / 8 - 0.5) * 2.6;
        const z = ((row + v) / 8 - 0.5) * 2.6;
        const y = heightAt(x, z);
        if (y === null) throw new Error('No terrain triangle at ' + x + ', ' + z);
        heights.push(y);
      }
      if (Math.max(...heights) - Math.min(...heights) > 1e-5) count++;
    }
    return count;
  });
}

for (const mode of ['adaptive', 'uniform512'] as const) {
  test(`sub-polygon displacement changes the rendered ${mode} silhouette in every terrain material`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && /WebGLProgram|shader|GL_INVALID/i.test(message.text()))
        errors.push(message.text());
    });
    await page.goto(`/?meshBenchmark=${mode}`);
    await page.getByLabel('Import terrain project file', { exact: true }).setInputFiles({
      name: 'flat.nhterrain.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(flatProject)),
    });
    const canvas = page.getByRole('img', { name: /^Interactive 3D terrain/ });
    await expect(canvas).toHaveAttribute('data-mesh-source-resolution', '128', { timeout: 60_000 });
    await expect(page.locator('.status-bar')).toContainText('Terrain ready');
    await page.getByRole('button', { name: 'Scene', exact: true }).click();
    // This is a geometry/silhouette test, not a fragment-material benchmark.
    // The dedicated PBR acceptance suite exercises both analytic and textured
    // close shading, so isolate geometry here (especially under SwiftShader).
    await page.getByRole('checkbox', { name: /Live close-up microdetail/ }).uncheck();
    const material = page.getByRole('combobox', { name: 'Surface material' });
    const quality = page.getByRole('combobox', { name: 'Terrain mesh fidelity' });
    await material.selectOption('clay');
    await page.evaluate(() => {
      // The level surface is y=0.325. Look just above its front skirt against the sky.
      (window as BenchmarkWindow).__nhMeshBenchmark!.setCamera([0, 0.32, 1.46], [0, 0.30, 1.15]);
    });
    await expect(canvas).toHaveAttribute('data-mesh-camera-position', '0.000000,0.320000,1.460000');
    const flat = await skyline(canvas);
    expect(await displacedTiles(page)).toBe(0);
    expect(flat.p10).toBeGreaterThan(flat.height * 0.1);
    expect(flat.p90).toBeLessThan(flat.height * 0.9);
    expect(flat.spread).toBeLessThanOrEqual(1);
    await testInfo.attach('zero-displacement-skyline.png', { body: await captureCanvas(canvas), contentType: 'image/png' });

    // An older release has no worker-status attribute. Its flat silhouette is
    // still a valid negative control when the test is run against that build.
    const reportsBakes = await canvas.getAttribute('data-displacement-status') !== null;
    const depth = page.locator('#param-detailStrength');
    await depth.focus();
    await depth.press('End');
    await expect(depth).toHaveValue('2');
    if (reportsBakes) await expect(canvas).toHaveAttribute('data-displacement-status', 'ready', { timeout: 45_000 });

    const measurements: Array<{ fidelity: string; surface: string; spread: number }> = [];
    const qualities = mode === 'adaptive' ? ['balanced', 'high', 'ultra'] : ['high'];
    for (const fidelity of qualities) {
      await quality.selectOption(fidelity);
      await expect(canvas).toHaveAttribute('data-mesh-quality', fidelity);
      for (const surface of ['clay', 'alpine', 'height', 'pbr']) {
        await test.step(`${fidelity} / ${surface}`, async () => {
          await material.selectOption(surface);
          if (surface === 'pbr')
            await expect(canvas).toHaveAttribute('data-material-status', 'ready', { timeout: 30_000 });
          // Include the material switch's first rendered frame.
          await canvas.evaluate(() => new Promise<void>(resolve =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          const horizon = await skyline(canvas);
          expect(horizon.spread, 'Terrain outline must rise and fall with material relief').toBeGreaterThan(2);
          expect(await displacedTiles(page), 'Every terrain tile must contain displaced triangles').toBe(64);
          measurements.push({ fidelity, surface, ...horizon });
        });
      }
    }
    await testInfo.attach('displaced-skyline.png', { body: await captureCanvas(canvas), contentType: 'image/png' });
    await testInfo.attach('skyline-pixels.json', { body: JSON.stringify({ flat, measurements }), contentType: 'application/json' });
    await depth.focus();
    await depth.press('Home');
    await expect(depth).toHaveValue('0');
    if (reportsBakes) await expect(canvas).toHaveAttribute('data-displacement-status', 'ready', { timeout: 45_000 });
    await expect.poll(async () => {
      const reset = await skyline(canvas);
      return Math.max(Math.abs(reset.p10 - flat.p10), Math.abs(reset.p90 - flat.p90));
    }).toBeLessThanOrEqual(1);
    await expect.poll(() => displacedTiles(page)).toBe(0);
    expect(errors).toEqual([]);
  });
}
