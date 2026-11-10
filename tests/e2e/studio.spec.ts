import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { unzipSync } from 'fflate';
import type { TerrainProject } from '../../src/model/types';

const runtimeErrors = new WeakMap<Page, string[]>();
const graph = (page: Page) => page.getByRole('region', { name: 'Terrain node graph', exact: true });
const terrainNodes = (page: Page) => graph(page).locator('.react-flow__node-terrain');
const mapCanvas = (page: Page) => page.locator('.nh-map canvas');

interface HeightAudit {
  jobId: number;
  resolution: number;
  outputNodeId: string;
  samples: number;
  sha256: string;
}
interface BrowserAudit {
  heights: HeightAudit[];
  raster?: ImageData;
}
type AuditedWindow = Window & typeof globalThis & { __terrainAudit: BrowserAudit };

/** Observe actual delivered worker buffers without adding test hooks to the application. */
async function observeHeightBuffers(page: Page) {
  await page.addInitScript(() => {
    const scope = window as AuditedWindow;
    scope.__terrainAudit = { heights: [] };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener('message', async (event: MessageEvent) => {
          const response = event.data;
          const height = response?.result?.field?.height;
          if (response?.type !== 'result' || !(height instanceof Float32Array)) return;
          // Copy before the application receives the message; audit every Float32 bit.
          const digest = await crypto.subtle.digest('SHA-256', height.slice().buffer);
          scope.__terrainAudit.heights.push({
            jobId: response.id,
            resolution: response.result.field.resolution,
            outputNodeId: response.result.outputNodeId,
            samples: height.length,
            sha256: Array.from(new Uint8Array(digest), (byte) =>
              byte.toString(16).padStart(2, '0'),
            ).join(''),
          });
        });
      }
    };
  });
}

async function heightAudits(page: Page) {
  return page.evaluate(() => (window as AuditedWindow).__terrainAudit.heights);
}

async function rememberRaster(page: Page) {
  await mapCanvas(page).evaluate((element: HTMLCanvasElement) => {
    (window as AuditedWindow).__terrainAudit.raster = element
      .getContext('2d')!
      .getImageData(0, 0, element.width, element.height);
  });
}

async function compareRaster(page: Page) {
  return mapCanvas(page).evaluate((element: HTMLCanvasElement) => {
    const before = (window as AuditedWindow).__terrainAudit.raster!;
    const after = element.getContext('2d')!.getImageData(0, 0, element.width, element.height);
    const sameDimensions = before.width === after.width && before.height === after.height;
    let changedPixels = 0,
      totalDelta = 0,
      maxChannelDelta = 0,
      centerMaxChannelDelta = 0;
    const halfCenter = Math.min(96, Math.floor(after.width / 4), Math.floor(after.height / 4));
    for (let i = 0; i < Math.min(before.data.length, after.data.length); i += 4) {
      let changed = false;
      const x = (i / 4) % after.width,
        y = Math.floor(i / 4 / after.width);
      const center =
        Math.abs(x - after.width / 2) < halfCenter && Math.abs(y - after.height / 2) < halfCenter;
      for (let channel = 0; channel < 4; channel++) {
        const delta = Math.abs(before.data[i + channel] - after.data[i + channel]);
        changed ||= delta > 0;
        totalDelta += delta;
        maxChannelDelta = Math.max(maxChannelDelta, delta);
        if (center) centerMaxChannelDelta = Math.max(centerMaxChannelDelta, delta);
      }
      if (changed) changedPixels++;
    }
    return {
      sameDimensions,
      width: after.width,
      height: after.height,
      changedPixels,
      maxChannelDelta,
      centerMaxChannelDelta,
      meanAbsoluteChannelDelta: totalDelta / after.data.length,
    };
  });
}

async function ready(page: Page) {
  await expect(page.locator('.status-bar')).toContainText('Terrain ready', { timeout: 60_000 });
  await expect(page.locator('.nh-render-progress')).toHaveCount(0);
  await expect(page.locator('.graph-error')).toHaveCount(0);
}

async function heightView(page: Page) {
  await page.getByRole('button', { name: '2D map', exact: true }).click();
  await page.getByRole('combobox', { name: 'Map channel' }).selectOption('height');
  await expect(page.getByRole('img', { name: /^Height map\./ })).toBeVisible();
  await expect.poll(() => mapColors(page)).toBeGreaterThan(12);
}

async function mapColors(page: Page) {
  return mapCanvas(page).evaluate((element: HTMLCanvasElement) => {
    const context = element.getContext('2d');
    if (!context || !element.width || !element.height) return 0;
    const pixels = context.getImageData(0, 0, element.width, element.height).data;
    const colors = new Set<number>();
    for (let i = 0; i < pixels.length; i += 388) {
      if (pixels[i + 3]) colors.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]);
    }
    return colors.size;
  });
}

async function mapFingerprint(page: Page) {
  return mapCanvas(page).evaluate((element: HTMLCanvasElement) => {
    const context = element.getContext('2d');
    if (!context || !element.width || !element.height) return 'empty';
    const pixels = context.getImageData(0, 0, element.width, element.height).data;
    let hash = 2166136261;
    for (let i = 0; i < pixels.length; i += 97) hash = Math.imul(hash ^ pixels[i], 16777619);
    return `${element.width}:${element.height}:${hash >>> 0}`;
  });
}

async function editNumber(field: Locator, value: string) {
  await field.fill(value);
  await field.press('Enter');
  await expect(field).toHaveValue(value);
}

async function capture(page: Page, testInfo: TestInfo, filename: string) {
  const path = testInfo.outputPath(filename);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await testInfo.attach(filename, { path, contentType: 'image/png' });
}

/** Capture the actual 3D framebuffer rather than asking a software GPU to
 * composite the entire editor during expensive grazing-angle weather views.
 * Keep a generous capture timeout while preserving the rendered pixel proof.
 */
async function captureTerrain(canvas: Locator, testInfo: TestInfo, filename: string) {
  const path = testInfo.outputPath(filename);
  await canvas.screenshot({ path, animations: 'disabled', timeout: 60_000 });
  await testInfo.attach(filename, { path, contentType: 'image/png' });
}

async function downloadProject(page: Page, testInfo: TestInfo, filename: string) {
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  const download = await downloading;
  const path = testInfo.outputPath(filename);
  await download.saveAs(path);
  expect(await download.failure()).toBeNull();
  const project = JSON.parse(await readFile(path, 'utf8')) as TerrainProject;
  return { path, project, filename: download.suggestedFilename() };
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  runtimeErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await observeHeightBuffers(page);
  await page.goto('/');
  await ready(page);
});

test.afterEach(async ({ page }) => {
  expect(
    runtimeErrors.get(page) ?? [],
    'The studio should not report browser or renderer errors',
  ).toEqual([]);
});

test('uses a legible light stone workspace with muted earth controls', async ({ page }, testInfo) => {
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
  await expect(page.locator('.app-header')).toHaveCSS('background-color', 'rgb(248, 248, 245)');
  await expect(page.locator('.library.panel')).toHaveCSS('background-color', 'rgb(244, 244, 241)');
  await expect(page.locator('.node-graph')).toHaveCSS('background-color', 'rgb(228, 231, 227)');
  await expect(page.locator('.ng-node').first()).toHaveCSS('background-color', 'rgb(252, 251, 248)');
  await expect(page.locator('.nh-viewport-toolbar')).toHaveCSS(
    'background-color',
    'rgb(238, 239, 236)',
  );
  await expect(page.locator('.ng-node-selected').first()).toBeVisible();

  // Check actual computed foreground/background contrast rather than matching only hex tokens.
  const contrast = await page.evaluate(() => {
    const luminance = (css: string) => {
      const components = css.match(/[0-9.]+/g)!.slice(0, 3).map(Number);
      const [r, g, b] = components.map((value) => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return r * 0.2126 + g * 0.7152 + b * 0.0722;
    };
    return ['.brand > span:last-child', '.ng-node', '.library-node strong'].map((selector) => {
      const el = document.querySelector(selector)!;
      const style = getComputedStyle(el);
      const background = getComputedStyle(
        selector === '.brand > span:last-child'
          ? document.querySelector('.app-header')!
          : selector === '.library-node strong'
            ? document.querySelector('.library-scroll')!
            : el,
      ).backgroundColor;
      const a = luminance(style.color);
      const b = luminance(background);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
  });
  for (const ratio of contrast) expect(ratio).toBeGreaterThan(4.5);

  await page.getByRole('button', { name: 'Display settings' }).click();
  await expect(page.getByRole('dialog', { name: 'Display settings' })).toHaveCSS(
    'background-color',
    'rgba(250, 250, 246, 0.98)',
  );
  await capture(page, testInfo, 'stone-earth-ui.png');
  await page.getByRole('button', { name: 'Close display settings' }).click();
});

test('supports charcoal mode, respects the OS, and retains a manual theme choice', async ({ page }, testInfo) => {
  const root = page.locator('html');
  const toggle = page.getByRole('button', { name: 'Dark mode' });
  await expect(root).toHaveAttribute('data-theme', 'light');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  const initialBuild = (await heightAudits(page)).at(-1)!;

  await toggle.click();
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await expect(root).toHaveCSS('color-scheme', 'dark');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.app-header')).toHaveCSS('background-color', 'rgb(48, 53, 53)');
  await expect(page.locator('.node-graph')).toHaveCSS('background-color', 'rgb(34, 39, 41)');
  await expect(page.locator('.ng-node').first()).toHaveCSS('background-color', 'rgb(48, 55, 54)');
  await expect(page.locator('.nh-viewport-toolbar')).toHaveCSS(
    'background-color',
    'rgb(41, 47, 48)',
  );
  await expect(page.locator('.nh-render-error')).toHaveCount(0);

  // Dark mode should not recompute the heightfield or restart erosion.
  await expect(page.locator('.nh-render-progress')).toHaveCount(0);
  expect((await heightAudits(page)).at(-1)?.sha256).toBe(initialBuild.sha256);
  const contrast = await page.evaluate(() => {
    const brightness = (css: string) => {
      const [r, g, b] = css.match(/[0-9.]+/g)!.slice(0, 3).map(Number).map((n) => {
        const c = n / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return r * 0.2126 + g * 0.7152 + b * 0.0722;
    };
    return [
      ['.brand > span:last-child', '.app-header'],
      ['.ng-node', '.ng-node'],
      ['.library-node strong', '.library-scroll'],
    ].map(([textSelector, backgroundSelector]) => {
      const fg = brightness(getComputedStyle(document.querySelector(textSelector)!).color);
      const bg = brightness(getComputedStyle(document.querySelector(backgroundSelector)!).backgroundColor);
      return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    });
  });
  contrast.forEach((ratio) => expect(ratio).toBeGreaterThan(4.5));
  await capture(page, testInfo, 'charcoal-dark-mode.png');

  await page.reload();
  await ready(page);
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(root).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await ready(page);
  await expect(root).toHaveAttribute('data-theme', 'light');

  // Without a saved choice, the workspace follows OS color-scheme changes.
  await page.evaluate(() => localStorage.removeItem('normal-height.theme.v1'));
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  await ready(page);
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(root).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(root).toHaveAttribute('data-theme', 'dark');
});

test('renders real 3D terrain and switches between split, flow, and normal maps', async ({
  page,
}, testInfo) => {
  const threeCanvas = page.getByRole('img', { name: /^Interactive 3D terrain\./ });
  await expect(threeCanvas).toBeVisible();
  await expect(page.getByRole('button', { name: '3D terrain', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('.nh-scene-resolution')).toHaveText('512² mesh');
  await expect(page.locator('.nh-render-error')).toHaveCount(0);
  await expect(terrainNodes(page)).toHaveCount(5);
  await expect(page.getByRole('textbox', { name: 'Node name' })).toHaveValue('Carve the watershed');

  // Inspect the real WebGL framebuffer, rather than accepting an empty canvas.
  await expect
    .poll(
      async () =>
        threeCanvas.evaluate((element: HTMLCanvasElement) => {
          const gl = element.getContext('webgl2');
          if (!gl) return 0;
          const width = gl.drawingBufferWidth,
            height = gl.drawingBufferHeight;
          const pixels = new Uint8Array(width * height * 4);
          gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          const colors = new Set<number>();
          for (let i = 0; i < pixels.length; i += 388)
            colors.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]);
          return colors.size;
        }),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(32);
  await capture(page, testInfo, 'studio-first-load-3d.png');

  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await expect(threeCanvas).toBeVisible();
  await expect(page.getByRole('img', { name: /^Height map\./ })).toBeVisible();
  await expect.poll(() => mapColors(page)).toBeGreaterThan(12);
  await page.getByRole('combobox', { name: 'Map channel' }).selectOption('flow');
  await expect(page.getByRole('img', { name: /^Water flow map\./ })).toBeVisible();
  await expect(page.locator('.nh-map-legend')).toContainText('Water flow · normalized');
  await page.getByRole('button', { name: '2D map', exact: true }).click();
  await expect(threeCanvas).toBeHidden();
  await expect.poll(() => mapColors(page)).toBeGreaterThan(12);
  await capture(page, testInfo, 'studio-2d-water-flow.png');

  await page.getByRole('combobox', { name: 'Map channel' }).selectOption('normal');
  await expect(page.getByRole('img', { name: /^Normals map\./ })).toBeVisible();
  await expect(page.locator('.nh-map-legend')).toContainText('OpenGL');
  await expect.poll(() => mapColors(page)).toBeGreaterThan(20);
});

test('seed and erosion parameter changes regenerate the actual height data', async ({ page }) => {
  await heightView(page);
  const original = await mapFingerprint(page);
  await editNumber(page.getByRole('spinbutton', { name: 'World seed', exact: true }), '97531');
  await expect.poll(() => mapFingerprint(page), { timeout: 60_000 }).not.toBe(original);
  await ready(page);
  const reseeded = await mapFingerprint(page);

  await editNumber(
    page.getByRole('spinbutton', { name: 'Erosion rate value', exact: true }),
    '0.46',
  );
  await expect.poll(() => mapFingerprint(page), { timeout: 60_000 }).not.toBe(reseeded);
  await ready(page);
  await expect(page.getByRole('spinbutton', { name: 'World seed', exact: true })).toHaveValue(
    '97531',
  );
  await expect(
    page.getByRole('spinbutton', { name: 'Erosion rate value', exact: true }),
  ).toHaveValue('0.46');
});

test('authors noise nodes, uses undo and redo, groups nodes, and edits a note', async ({
  page,
}) => {
  const library = page.getByRole('complementary', { name: 'Node library', exact: true });
  await library.getByRole('button', { name: /Procedural noise/ }).click();
  await expect(terrainNodes(page)).toHaveCount(6);
  await expect(page.getByRole('textbox', { name: 'Node name' })).toHaveValue('Procedural noise');
  const noiseFamily = page.getByRole('combobox', { name: 'Noise family', exact: true });
  await noiseFamily.selectOption('naki');
  await expect(noiseFamily).toHaveValue('naki');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(noiseFamily).toHaveValue('ridged');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(noiseFamily).toHaveValue('naki');

  await graph(page).getByRole('button', { name: 'Fit', exact: true }).click();
  const first = graph(page).locator('.react-flow__node[data-id="range"]');
  const second = graph(page).locator('.react-flow__node[data-id="warp"]');
  await first.getByText('Alpine spine', { exact: true }).click();
  await second.getByText('Break the symmetry', { exact: true }).click({ modifiers: ['Shift'] });
  await expect(graph(page).locator('.react-flow__node.selected')).toHaveCount(2);
  await graph(page).getByRole('button', { name: 'Group selected nodes', exact: true }).click();
  await expect(graph(page).locator('.react-flow__node-terrainGroup')).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: 'Node name' })).toHaveValue('Node group');
  await graph(page).getByRole('button', { name: 'Ungroup nodes', exact: true }).click();
  await expect(graph(page).locator('.react-flow__node-terrainGroup')).toHaveCount(0);
  await expect(terrainNodes(page)).toHaveCount(6);

  await graph(page).getByRole('button', { name: 'Add a note', exact: true }).click();
  const annotation = graph(page).getByRole('textbox', { name: 'Edit Annotation', exact: true });
  await annotation.fill('Keep the broad drainage, then refine the tributaries.');
  await annotation.press('Tab');
  await expect(page.getByRole('textbox', { name: 'Note', exact: true })).toHaveValue(
    'Keep the broad drainage, then refine the tributaries.',
  );
  await expect(graph(page).locator('.react-flow__node-annotation')).toHaveCount(1);
});

test('draws a real editable river and ridge, connects it before erosion, and saves the path', async ({
  page,
}, testInfo) => {
  await page.getByRole('combobox', { name: 'Working resolution' }).selectOption('128');
  await ready(page);
  const prior = (await heightAudits(page)).at(-1)!;

  const library = page.getByRole('complementary', { name: 'Node library', exact: true });
  await library.getByRole('button', { name: /River \/ ridge spline/ }).click();
  await expect(terrainNodes(page)).toHaveCount(6);
  await expect(page.getByRole('button', { name: '2D map', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Edit path on 2D map' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Finish editing' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.nh-spline-handle')).toHaveCount(5);
  await ready(page);
  const afterInsert = (await heightAudits(page)).at(-1)!;
  expect(afterInsert.sha256).not.toBe(prior.sha256);

  const point3 = page.getByRole('button', { name: 'Move spline point 3', exact: true });
  const pointX = page.getByRole('spinbutton', { name: 'Point 3 X percent' });
  const originalX = await pointX.inputValue();
  const bounds = await point3.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width / 2 + 45, bounds!.y + bounds!.height / 2 - 24, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => pointX.inputValue()).not.toBe(originalX);

  const layer = page.locator('.nh-spline-layer');
  const rect = await layer.boundingBox();
  expect(rect).not.toBeNull();
  await layer.click({ position: { x: rect!.width * 0.54, y: rect!.height * 0.26 } });
  await expect(page.locator('.nh-spline-handle')).toHaveCount(6);
  await expect(page.locator('.spline-editor-heading')).toContainText('6 points');
  await capture(page, testInfo, 'river-path-editor.png');

  const operation = page.getByRole('combobox', { name: 'Path operation' });
  await operation.selectOption('ridge');
  await ready(page);
  await expect(page.locator('.nh-spline-layer')).toHaveClass(/is-ridge/);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(operation).toHaveValue('river');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(operation).toHaveValue('ridge');

  const saved = await downloadProject(page, testInfo, 'river-ridge-path.nhterrain.json');
  const splines = saved.project.graph.nodes.filter((n) => n.kind === 'spline');
  expect(splines).toHaveLength(1);
  expect(splines[0].path).toHaveLength(6);
  expect(splines[0].params.mode).toBe('ridge');
  const edgeIntoErosion = saved.project.graph.edges.find((e) => e.target === 'erosion');
  expect(edgeIntoErosion?.source).toBe(splines[0].id);

  await page.getByRole('button', { name: 'Finish editing' }).click();
  await page.getByRole('button', { name: '3D terrain', exact: true }).click();
  await expect(page.getByRole('img', { name: /^Interactive 3D terrain\./ })).toBeVisible();

  // Round trip the portable project through the actual browser import control.
  await page.locator('input[type="file"]').setInputFiles(saved.path);
  await ready(page);
  await expect(terrainNodes(page)).toHaveCount(6);
  const restored = await downloadProject(page, testInfo, 'spline-reopened.nhterrain.json');
  expect(restored.project.graph.nodes.find((n) => n.kind === 'spline')?.path)
    .toEqual(splines[0].path);
});

test('downloads a project and restores its name, seed, graph, parameters, and notes', async ({
  page,
}, testInfo) => {
  await page.locator('.project-name').click();
  const projectDialog = page.getByRole('dialog', { name: 'Begin with a landscape', exact: true });
  await projectDialog
    .getByRole('textbox', { name: 'Project name', exact: true })
    .fill('Erosion study 07');
  await projectDialog
    .getByRole('button', { name: 'Close Begin with a landscape', exact: true })
    .click();
  await page.getByRole('textbox', { name: 'Node name' }).fill('Cut the channels');
  await editNumber(
    page.getByRole('spinbutton', { name: 'Erosion rate value', exact: true }),
    '0.35',
  );
  await graph(page).getByRole('button', { name: 'Add a note', exact: true }).click();
  const note = graph(page).getByRole('textbox', { name: 'Edit Annotation', exact: true });
  await note.fill('Rainfall first. Talus second. Preserve the seed.');
  await note.press('Tab');
  const saved = await downloadProject(page, testInfo, 'roundtrip-original.nhterrain.json');
  expect(saved.filename).toBe('erosion-study-07.nhterrain.json');
  expect(saved.project.graph.nodes.find((node) => node.id === 'erosion')?.params.erosion).toBe(
    0.35,
  );
  expect(saved.project.graph.nodes.find((node) => node.kind === 'note')?.params.text).toBe(
    'Rainfall first. Talus second. Preserve the seed.',
  );

  await page.locator('.project-name').click();
  await page
    .getByRole('dialog', { name: 'Begin with a landscape', exact: true })
    .getByRole('button', { name: /Granite massif/ })
    .click();
  await expect(page.locator('.project-name')).toContainText('Granite massif');
  await expect(graph(page).locator('.react-flow__node-annotation')).toHaveCount(0);
  await page.getByLabel('Import terrain project file', { exact: true }).setInputFiles(saved.path);
  await expect(page.locator('.project-name')).toContainText('Erosion study 07');
  await expect(page.getByRole('textbox', { name: 'Node name' })).toHaveValue('Cut the channels');
  await expect(page.getByRole('spinbutton', { name: 'World seed', exact: true })).toHaveValue(
    String(saved.project.seed),
  );
  await expect(
    page.getByRole('spinbutton', { name: 'Erosion rate value', exact: true }),
  ).toHaveValue('0.35');
  await expect(
    graph(page).getByRole('textbox', { name: 'Edit Annotation', exact: true }),
  ).toHaveValue('Rainfall first. Talus second. Preserve the seed.');
  await ready(page);
  const restored = await downloadProject(page, testInfo, 'roundtrip-restored.nhterrain.json');
  expect(restored.project).toEqual(saved.project);
});

test('a broken output connection reports an error, preserves terrain, and recovers with undo', async ({
  page,
}, testInfo) => {
  await heightView(page);
  const lastSuccessfulMap = await mapFingerprint(page);
  await expect.poll(async () => (await heightAudits(page)).length).toBeGreaterThan(0);
  const originalAudits = await heightAudits(page);
  const originalHeight = originalAudits.at(-1)!;
  await rememberRaster(page);
  await capture(page, testInfo, 'undo-original-heightmap.png');
  const connection = graph(page).getByRole('group', {
    name: 'Edge from thermal to output',
    exact: true,
  });
  await connection.focus();
  await connection.press('Enter');
  await expect(connection).toHaveClass(/selected/);
  await connection.press('Delete');
  await expect(graph(page).locator('.react-flow__edge')).toHaveCount(3);
  await expect(page.locator('.graph-error')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.graph-error')).toContainText(
    'The last successful terrain remains visible.',
  );
  await expect(page.locator('.status-bar')).toContainText('Graph needs attention');
  expect(await mapFingerprint(page)).toBe(lastSuccessfulMap);
  expect((await heightAudits(page)).length).toBe(originalAudits.length);

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(graph(page).locator('.react-flow__edge')).toHaveCount(4);
  await ready(page);
  // A fresh completed worker result is required, not merely the old ready state.
  await expect
    .poll(async () => (await heightAudits(page)).length, { timeout: 60_000 })
    .toBeGreaterThan(originalAudits.length);
  const restoredHeight = (await heightAudits(page)).at(-1)!;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const rasterDelta = await compareRaster(page);
  await testInfo.attach('undo-data-and-raster-audit.json', {
    body: JSON.stringify({ originalHeight, restoredHeight, rasterDelta }, null, 2),
    contentType: 'application/json',
  });
  await capture(page, testInfo, 'undo-restored-heightmap.png');
  expect(restoredHeight.resolution).toBe(originalHeight.resolution);
  expect(restoredHeight.samples).toBe(originalHeight.samples);
  expect(restoredHeight.outputNodeId).toBe(originalHeight.outputNodeId);
  expect(restoredHeight.sha256).toBe(originalHeight.sha256);
  expect(rasterDelta.sameDimensions).toBe(true);
  // Canvas readback can switch Chromium from GPU to CPU resampling. Require the
  // displayed terrain to agree within two 8-bit levels, while raw heights above
  // must be bit-for-bit identical across every sample. Exclude border antialiasing.
  expect(rasterDelta.centerMaxChannelDelta).toBeLessThanOrEqual(2);
});

test('protects the graph inside a modal and exports a real 512-square 16-bit PNG bundle', async ({
  page,
}, testInfo) => {
  await page.getByRole('button', { name: 'Export maps', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export your landscape', exact: true });
  await expect(dialog).toBeVisible();
  const exportButton = dialog.getByRole('button', { name: 'Export bundle', exact: true });
  await exportButton.focus();
  await page.keyboard.press('Delete');
  await expect(terrainNodes(page)).toHaveCount(5);
  await expect(graph(page).locator('.react-flow__edge')).toHaveCount(4);
  await dialog.getByRole('combobox', { name: 'Export format', exact: true }).selectOption('png16');
  await dialog
    .getByRole('combobox', { name: 'Export resolution', exact: true })
    .selectOption('512');
  await expect(dialog.getByRole('checkbox')).toBeChecked();
  const downloading = page.waitForEvent('download', { timeout: 60_000 });
  await exportButton.click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('alpine-watershed-512-png16.zip');
  const path = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(path);
  expect(await download.failure()).toBeNull();
  const files = unzipSync(new Uint8Array(await readFile(path)));
  const png = files['alpine-watershed-512-height16.png'];
  expect(png).toBeDefined();
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect(header.getUint32(16)).toBe(512);
  expect(header.getUint32(20)).toBe(512);
  expect(png[24]).toBe(16);
  expect(png[25]).toBe(0);
  const metadata = JSON.parse(new TextDecoder().decode(files['alpine-watershed-metadata.json']));
  expect(metadata.resolution).toEqual([512, 512]);
  expect(metadata.format).toBe('png16');
  expect(metadata.seed).toBe(48271);
  expect(metadata.elevationMaxMeters).toBeGreaterThan(metadata.elevationMinMeters);
  expect(files['alpine-watershed.nhterrain.json']).toBeDefined();
  await expect(dialog.getByRole('status')).toContainText(
    'Downloaded alpine-watershed-512-png16.zip',
  );
});


test('edits surface settings and exports aligned PBR textures in a browser', async ({
  page,
}, testInfo) => {
  await page.getByRole('button', { name: 'Scene', exact: true }).click();
  await page.getByLabel('Material biome').selectOption('volcanic');
  await page.getByRole('spinbutton', { name: 'Snow-line elevation value' }).fill('0.82');
  await page.getByRole('spinbutton', { name: 'Snow-line elevation value' }).press('Enter');
  await expect(page.getByLabel('Material biome')).toHaveValue('volcanic');
  await page.getByRole('button', { name: 'Export maps', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export your landscape', exact: true });
  await dialog.getByRole('combobox', { name: 'Export format' }).selectOption('pbr');
  await dialog.getByRole('combobox', { name: 'Export resolution' }).selectOption('256');
  await expect(dialog.getByRole('button', { name: 'Export bundle', exact: true })).toBeEnabled();
  const downloading = page.waitForEvent('download', { timeout: 90_000 });
  await dialog.getByRole('button', { name: 'Export bundle', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('alpine-watershed-256-pbr.zip');
  const filePath = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(filePath);
  expect(await download.failure()).toBeNull();
  const files = unzipSync(new Uint8Array(await readFile(filePath)));
  const prefix = 'alpine-watershed-256-';
  for (const suffix of [
    'height16.png', 'basecolor.png', 'normal-gl.png', 'normal-dx.png',
    'detailnormal-gl.png', 'roughness.png', 'ao.png', 'metallic.png', 'orm.png',
    'splat-rgba.png', 'curvature.png', 'unity-hdrp-mask.png',
  ]) {
    const png = files[prefix + suffix];
    expect(png, suffix + ' should be included').toBeDefined();
    const header = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect(header.getUint32(16)).toBe(256);
    expect(header.getUint32(20)).toBe(256);
  }
  const metadata = JSON.parse(
    new TextDecoder().decode(files['alpine-watershed-material-metadata.json']),
  );
  expect(metadata.surface.biome).toBe('volcanic');
  expect(metadata.surface.snowLine).toBe(0.82);
  expect(metadata.packedMaps.splat_rgba).toEqual(['rock', 'soil', 'vegetation', 'snow']);
  const project = JSON.parse(new TextDecoder().decode(files['alpine-watershed.nhterrain.json']));
  expect(project.surface).toEqual(metadata.surface);
  await expect(dialog.getByRole('status')).toContainText('Downloaded alpine-watershed-256-pbr.zip');
});

test('material edits repaint the visible 2D PBR canvas without rebuilding the erosion field', async ({ page }) => {
  await page.getByRole('button', { name: '2D map', exact: true }).click();
  await page.getByRole('combobox', { name: 'Map channel' }).selectOption('basecolor');
  await expect(page.getByRole('img', { name: /^PBR base color map/ })).toBeVisible();
  await expect.poll(() => mapColors(page), { timeout: 30_000 }).toBeGreaterThan(8);
  const before = await mapFingerprint(page);
  const auditedHeights = await heightAudits(page);
  await page.getByRole('button', { name: 'Scene', exact: true }).click();
  await page.getByLabel('Material biome').selectOption('volcanic');
  // No pan/zoom or channel toggle: the paint must respond to the material alone.
  await expect.poll(() => mapFingerprint(page), { timeout: 30_000 }).not.toBe(before);
  expect((await heightAudits(page)).map((entry) => entry.sha256))
    .toEqual(auditedHeights.map((entry) => entry.sha256));
});

test('PBR 3D material visibly updates after worker completion without moving the camera', async ({ page }) => {
  const canvas = page.getByRole('img', { name: /^Interactive 3D terrain/ });
  await expect(canvas).toHaveAttribute('data-material-status', 'ready', { timeout: 30_000 });
  const fingerprint = () => canvas.evaluate((element: HTMLCanvasElement) => {
    const png = element.toDataURL('image/png');
    let hash = 2166136261;
    for (let i = 0; i < png.length; i += 31)
      hash = Math.imul(hash ^ png.charCodeAt(i), 16777619);
    return `${element.width}:${element.height}:${hash >>> 0}`;
  });
  const before = await fingerprint();
  const heightsBefore = await heightAudits(page);
  await page.getByRole('button', { name: 'Scene', exact: true }).click();
  await page.getByLabel('Material biome').selectOption('arid');
  await expect(canvas).toHaveAttribute('data-material-status', 'ready', { timeout: 30_000 });
  await expect.poll(fingerprint, { timeout: 30_000 }).not.toBe(before);
  expect((await heightAudits(page)).map((h) => h.sha256))
    .toEqual(heightsBefore.map((h) => h.sha256));
});


test('the sky and expanded meadow change rendered pixels without rebuilding the terrain', async ({ page }, testInfo) => {
  const canvas = page.getByRole('img', { name: /^Interactive 3D terrain/ });
  await expect(canvas).toHaveAttribute('data-material-status', 'ready', { timeout: 30_000 });
  const heightsBefore = (await heightAudits(page)).map((h) => h.sha256);
  const fingerprint = () => canvas.evaluate((element: HTMLCanvasElement) => {
    const image = element.toDataURL('image/png');
    let hash = 2166136261;
    for (let i = 0; i < image.length; i += 41)
      hash = Math.imul(hash ^ image.charCodeAt(i), 16777619);
    return hash >>> 0;
  });

  await page.getByRole('button', { name: 'Display settings' }).click();
  const panel = page.getByRole('dialog', { name: 'Display settings' });
  // Freeze procedural drift while comparing the actual WebGL framebuffers.
  const wind = panel.getByRole('slider', { name: 'Wind speed' });
  await wind.focus();
  await wind.press('Home');
  await expect(wind).toHaveValue('0');

  // The expensive environment is opt-in; existing editor work stays light.
  const skyToggle = panel.getByRole('checkbox', { name: 'Enable sky dome' });
  await expect(skyToggle).not.toBeChecked();
  const studioLight = await fingerprint();
  await skyToggle.check();
  await expect.poll(fingerprint).not.toBe(studioLight);
  const withSky = await fingerprint();
  await skyToggle.uncheck();
  await expect.poll(fingerprint).not.toBe(withSky);
  await skyToggle.check();

  const withoutGround = await fingerprint();
  await panel.getByRole('checkbox', { name: 'Expand ground' }).check();
  await expect(panel.getByRole('slider', { name: 'Ground reach' })).toBeVisible();
  await expect(panel.getByRole('slider', { name: 'Grass density' })).toBeVisible();
  await expect.poll(fingerprint).not.toBe(withoutGround);
  await capture(page, testInfo, 'sky-and-expanded-grass.png');

  await panel.getByRole('checkbox', { name: 'Expand ground' }).uncheck();
  expect((await heightAudits(page)).map((h) => h.sha256)).toEqual(heightsBefore);
  await expect(page.locator('.nh-render-progress')).toHaveCount(0);
});

test('sky look presets survive a reload and keep the split map responsive', async ({ page }, testInfo) => {
  const canvas = page.getByRole('img', { name: /^Interactive 3D terrain/ });
  await expect(canvas).toHaveAttribute('data-material-status', 'ready', { timeout: 30_000 });
  const fingerprint = () => canvas.evaluate((element: HTMLCanvasElement) => {
    const png = element.toDataURL('image/png');
    let hash = 2166136261;
    for (let i = 0; i < png.length; i += 43)
      hash = Math.imul(hash ^ png.charCodeAt(i), 16777619);
    return hash >>> 0;
  });
  await page.getByRole('button', { name: 'Display settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Display settings' });
  await dialog.getByRole('slider', { name: 'Wind speed' }).focus();
  await dialog.getByRole('slider', { name: 'Wind speed' }).press('Home');
  await dialog.getByRole('button', { name: 'Clear day sky preset' }).click();
  await expect(dialog.getByRole('checkbox', { name: 'Enable sky dome' })).toBeChecked();
  const clear = await fingerprint();
  await capture(page, testInfo, 'atmosphere-clear-day.png');

  await dialog.getByRole('button', { name: 'Golden hour sky preset' }).click();
  await expect.poll(fingerprint).not.toBe(clear);
  const golden = await fingerprint();
  await capture(page, testInfo, 'atmosphere-golden-hour.png');

  await dialog.getByRole('button', { name: 'Overcast sky preset' }).click();
  await expect.poll(fingerprint).not.toBe(golden);
  await dialog.getByRole('checkbox', { name: 'Expand ground' }).check();
  await dialog.getByRole('slider', { name: 'Grass density' }).focus();
  await dialog.getByRole('slider', { name: 'Grass density' }).press('End');
  await capture(page, testInfo, 'atmosphere-overcast-meadow.png');

  // Reload preserves artist controls; 2D inspection still repaints accurately
  // while the physical sky and grass are enabled.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await ready(page);
  await page.getByRole('button', { name: 'Display settings' }).click();
  const restored = page.getByRole('dialog', { name: 'Display settings' });
  await expect(restored.getByRole('checkbox', { name: 'Enable sky dome' })).toBeChecked();
  await expect(restored.getByRole('checkbox', { name: 'Expand ground' })).toBeChecked();
  await expect(restored.getByRole('slider', { name: 'Cloud cover' })).toHaveValue('0.88');
  await expect(restored.getByRole('slider', { name: 'Grass density' })).toHaveValue('1.5');
  await page.getByRole('button', { name: 'Close display settings' }).click();
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await expect(page.getByRole('img', { name: /^Height map\./ })).toBeVisible();
  await expect.poll(() => mapColors(page), { timeout: 30_000 }).toBeGreaterThan(12);

  // These conditions also exercise actual cloud shadows without moving the
  // camera: turning off the direct-light attenuation must change terrain pixels.
  await page.getByRole('button', { name: '3D terrain', exact: true }).click();
  await page.getByRole('button', { name: 'Display settings' }).click();
  const weather = page.getByRole('dialog', { name: 'Display settings' });
  const shadows = weather.getByRole('slider', { name: 'Cloud shadow strength' });
  await shadows.focus();
  await shadows.press('Home');
  const shadowsOff = await fingerprint();
  await shadows.press('End');
  await expect.poll(fingerprint, { timeout: 30_000 }).not.toBe(shadowsOff);
  await page.getByRole('button', { name: 'Close display settings' }).click();

  // Lower the camera to inspect clouds near the horizon rather than checking
  // only the top-down terrain tile.
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width * 0.48, bounds!.y + bounds!.height * 0.48);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width * 0.48, bounds!.y + bounds!.height * 0.72, { steps: 9 });
  await page.mouse.up();
  await captureTerrain(canvas, testInfo, 'atmosphere-overcast-horizon.png');

  await page.getByRole('button', { name: 'Display settings' }).click();
  await page.getByRole('dialog', { name: 'Display settings' })
    .getByRole('button', { name: 'Golden hour sky preset' }).click();
  await page.getByRole('button', { name: 'Close display settings' }).click();
  await captureTerrain(canvas, testInfo, 'atmosphere-golden-horizon.png');
});

test('export resolution and mandatory PBR bundle controls match their actual state', async ({ page }) => {
  // Do not run an unrelated, expensive 768-grid erosion simulation.
  await page.locator('.auto-build input').uncheck();
  await page.getByRole('combobox', { name: 'Working resolution' }).selectOption('768');
  await page.getByRole('button', { name: 'Export maps', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export your landscape', exact: true });
  const resolution = dialog.getByRole('combobox', { name: 'Export resolution' });
  const format = dialog.getByRole('combobox', { name: 'Export format' });
  const bundle = dialog.getByRole('checkbox');
  await expect(resolution).toHaveValue('768');
  await expect(dialog).toContainText('768 × 768');
  await bundle.uncheck();
  await expect(bundle).not.toBeChecked();
  await format.selectOption('pbr');
  await expect(bundle).toBeChecked();
  await expect(bundle).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Export bundle', exact: true })).toBeEnabled();
  await format.selectOption('basecolor');
  await expect(bundle).not.toBeChecked();
  await expect(bundle).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Export map', exact: true })).toBeEnabled();
});

