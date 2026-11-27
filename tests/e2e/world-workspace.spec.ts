import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { createProject } from '../../src/model/presets';
import { STUDIO_DEFAULTS } from '../../src/model/noiseStudio';

test.use({ video: 'off' });

async function openWorkspace(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const project = createProject('studio-dunes');
  project.name = 'World workspace acceptance';
  project.resolution = 64;
  project.worldSize = 8000;
  const source = project.graph.nodes[0],
    output = project.graph.nodes.at(-1)!;
  source.params = {
    ...STUDIO_DEFAULTS,
    noiseModel: 'v3',
    kernel: 'perlin',
    fractal: 'none',
    warpType: 'none',
    sampling: 'point',
  };
  project.graph = {
    nodes: [source, output],
    edges: [
      {
        id: 'world-source-output',
        source: source.id,
        target: output.id,
        sourceHandle: 'height',
        targetHandle: 'in',
      },
    ],
  };
  await page.getByLabel('Import terrain project file').setInputFiles({
    name: 'world-workspace.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(
    page.getByRole('contentinfo').getByText('Terrain ready', { exact: true }),
  ).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'World Studio', exact: true }).click();
  const studio = page.getByRole('region', { name: 'World Studio', exact: true });
  await expect(studio.getByText('World overview ready', { exact: true })).toBeVisible({
    timeout: 90_000,
  });
  // Keep these interaction tests deterministic: sampling itself has separate real-worker gates.
  await studio.getByLabel('Automatic world previews').uncheck();
  await studio.getByText('Preview behaviour', { exact: true }).click();
  await studio.getByLabel('Automatic regional refinement').uncheck();
  return { studio, errors, project };
}

async function mapBounds(studio: Locator) {
  return {
    frame: (await studio
      .getByRole('region', { name: 'Interactive world map', exact: true })
      .boundingBox())!,
    terrain: (await studio.locator('.wv-plane').boundingBox())!,
  };
}

test('undo between imported legacy projects restores the inherited world domain', async ({
  page,
}) => {
  const { studio, errors, project } = await openWorkspace(page);
  await studio.getByRole('tab', { name: 'Setup', exact: true }).click();
  await expect(studio.getByLabel('Width', { exact: true })).toHaveValue('8000');
  await expect(studio.getByLabel('Height scale', { exact: true })).toHaveValue(
    String(project.heightScale),
  );

  const replacement = {
    ...structuredClone(project),
    name: 'Smaller legacy world',
    worldSize: 2000,
    heightScale: 600,
  };
  await page.getByLabel('Import terrain project file').setInputFiles({
    name: 'smaller-legacy-world.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(replacement)),
  });
  await expect(page.getByRole('button', { name: replacement.name, exact: true })).toBeVisible();
  await studio.getByRole('tab', { name: 'Setup', exact: true }).click();
  await expect(studio.getByLabel('Width', { exact: true })).toHaveValue('2000');
  await expect(studio.getByLabel('Height scale', { exact: true })).toHaveValue('600');

  // Import remounts the workspace; history restoration updates the existing instance.
  // Both projects omit project.world, so their legacy dimensions must also drive sync.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: project.name, exact: true })).toBeVisible();
  await studio.getByRole('tab', { name: 'Setup', exact: true }).click();
  await expect(studio.getByLabel('Width', { exact: true })).toHaveValue('8000');
  await expect(studio.getByLabel('Depth', { exact: true })).toHaveValue('8000');
  await expect(studio.getByLabel('Height scale', { exact: true })).toHaveValue(
    String(project.heightScale),
  );
  await expect(
    studio.getByRole('button', { name: 'Enable world in project', exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

async function waitForMapPaint(studio: Locator) {
  const map = studio.getByRole('region', { name: 'Interactive world map', exact: true });
  await expect.poll(async () => (await map.boundingBox())?.width ?? 0).toBeGreaterThan(320);
  await expect.poll(async () => (await map.boundingBox())?.height ?? 0).toBeGreaterThan(240);
  const canvas = studio.locator('.wv-plane > .wv-field > canvas.wv-raster').last();
  await expect
    .poll(() =>
      canvas.evaluate((element) => {
        const surface = element as HTMLCanvasElement;
        return surface
          .getContext('2d')
          ?.getImageData(Math.floor(surface.width / 2), Math.floor(surface.height / 2), 1, 1)
          .data[3];
      }),
    )
    .toBe(255);
}

async function waitForTerrainPaint(canvas: Locator) {
  await expect(canvas).toHaveAttribute('data-rendered', 'true');
  // Allow queued control changes and the composited WebGL frame to reach the screenshot surface.
  await canvas.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function screenshotPixels(page: Page, png: Buffer) {
  // Decode the browser's composited screenshot. Reading a WebGL drawing buffer
  // after presentation can return zeros when preserveDrawingBuffer is disabled.
  return page.evaluate(async (encoded) => {
    const image = new Image();
    image.src = `data:image/png;base64,${encoded}`;
    await image.decode();
    const surface = document.createElement('canvas');
    surface.width = surface.height = 128;
    const context = surface.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(image, 0, 0, 128, 128);
    return Array.from(context.getImageData(0, 0, 128, 128).data);
  }, png.toString('base64'));
}

test('map navigation preserves physical anchors, keyboard selection, and graph shortcuts', async ({
  page,
}, info) => {
  const { studio, errors } = await openWorkspace(page);
  await waitForMapPaint(studio);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await studio
    .getByRole('heading', { name: 'A world worth getting lost in.', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('world-workspace-light-map.png') });
  const map = studio.getByRole('region', { name: 'Interactive world map', exact: true });
  const before = await mapBounds(studio);
  const cursor = {
    x: before.terrain.x + before.terrain.width * 0.68,
    y: before.terrain.y + before.terrain.height * 0.43,
  };
  await page.mouse.move(cursor.x, cursor.y);
  await page.mouse.wheel(0, -160);
  await expect
    .poll(async () => (await studio.locator('.wv-plane').boundingBox())!.width)
    .toBeGreaterThan(before.terrain.width * 1.5);
  const after = (await mapBounds(studio)).terrain;
  expect(Math.abs(after.x + after.width * 0.68 - cursor.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.y + after.height * 0.43 - cursor.y)).toBeLessThanOrEqual(1);

  await map.focus();
  await page.keyboard.press('Home');
  await expect(studio.locator('.wv-map-zoom')).toHaveText('100%');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  const selection = studio.locator('.wv-selected-region');
  await expect(selection).toBeVisible();
  expect(await selection.evaluate((element) => (element as HTMLElement).style.left)).toBe('25%');
  await page.keyboard.press('Shift+ArrowDown');
  expect(await selection.evaluate((element) => (element as HTMLElement).style.height)).toBe('50%');
  await page.keyboard.press('f');
  const framed = await mapBounds(studio),
    selected = (await selection.boundingBox())!;
  // DOM percentages use the terrain's bordered box, while camera size uses integer client
  // dimensions. Allow one CSS pixel of presentation rounding; analytic camera tests stay exact.
  expect(
    Math.abs(selected.x + selected.width / 2 - (framed.frame.x + framed.frame.width / 2)),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(selected.y + selected.height / 2 - (framed.frame.y + framed.frame.height / 2)),
  ).toBeLessThanOrEqual(1);
  await page.keyboard.press('Shift+G');
  await expect(studio.getByRole('button', { name: 'Show tile grid', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.keyboard.press('g');
  await expect(
    studio.getByRole('region', { name: 'World graph editor', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('g');
  await expect(studio.getByRole('region', { name: 'World graph editor', exact: true })).toHaveCount(
    0,
  );
  await page.keyboard.press('Escape');
  await expect(selection).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('region bookmarks and workspace presentation survive leaving World Studio', async ({
  page,
}) => {
  const { studio, errors } = await openWorkspace(page);
  const map = studio.getByRole('region', { name: 'Interactive world map', exact: true });
  await map.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await studio.getByLabel('Bookmark name', { exact: true }).fill('South ridge');
  await studio.getByRole('button', { name: 'Save region bookmark', exact: true }).click();
  await expect(studio.getByRole('button', { name: 'South ridge', exact: true })).toBeVisible();
  await studio.getByRole('tab', { name: 'Analyze', exact: true }).click();
  await expect(studio.getByRole('img', { name: /^Elevation histogram/ })).toBeVisible();
  await studio.getByRole('tab', { name: 'Explore', exact: true }).click();
  await studio.getByRole('button', { name: 'South ridge', exact: true }).click();
  await expect(studio.locator('.wv-selected-region')).toBeVisible();
  await expect(studio.locator('.wv-map-zoom')).not.toHaveText('100%');
  await studio.getByRole('button', { name: 'Close World Studio', exact: true }).click();
  await page.getByRole('button', { name: 'World Studio', exact: true }).click();
  await expect(studio.getByRole('button', { name: 'South ridge', exact: true })).toBeVisible();
  await expect(studio.locator('.wv-selected-region')).toBeVisible();
  await expect(studio.locator('.wv-map-zoom')).not.toHaveText('100%');
  const persisted = await page.evaluate(() =>
    localStorage.getItem('normal-height.world-bookmarks.v1'),
  );
  expect(persisted).toContain('South ridge');
  expect(errors).toEqual([]);
});

test('physical 3D and split views own one renderer and release it when hidden', async ({
  page,
}, info) => {
  const { studio, errors } = await openWorkspace(page);
  const modes = studio.getByRole('group', { name: 'World view mode', exact: true });
  await modes.getByRole('button', { name: 'Terrain', exact: true }).click();
  const canvas = studio.getByRole('img', {
    name: 'Three-dimensional sampled world terrain',
    exact: true,
  });
  await expect(canvas).toBeVisible();
  await waitForTerrainPaint(canvas);
  await studio
    .getByRole('heading', { name: 'A world worth getting lost in.', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('world-workspace-physical-terrain.png') });
  const size = (await canvas.boundingBox())!;
  expect(size.width).toBeGreaterThan(500);
  expect(size.height).toBeGreaterThan(300);
  await studio.getByRole('button', { name: 'Orthographic projection', exact: true }).click();
  await expect(
    studio.getByRole('button', { name: 'Orthographic projection', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await studio.getByRole('button', { name: 'Show terrain wireframe', exact: true }).click();
  await studio.getByLabel('Terrain vertical exaggeration', { exact: true }).focus();
  await page.keyboard.press('End');
  await expect(studio.getByLabel('Terrain vertical exaggeration', { exact: true })).toHaveValue(
    '4',
  );
  await modes.getByRole('button', { name: 'Map', exact: true }).click();
  await expect(studio.locator('.wv-terrain-canvas canvas')).toHaveCount(0);
  await modes.getByRole('button', { name: 'Split', exact: true }).click();
  await expect(canvas).toBeVisible();
  await expect(
    studio.getByRole('region', { name: 'Interactive world map', exact: true }),
  ).toBeVisible();
  await expect(studio.locator('.wv-terrain-canvas canvas')).toHaveCount(1);
  await expect(studio.getByLabel('Terrain vertical exaggeration', { exact: true })).toHaveValue(
    '4',
  );
  // Capture the physical, solid surface as well as exercising persistent display controls.
  await studio.getByRole('button', { name: 'Orthographic projection', exact: true }).click();
  await studio.getByRole('button', { name: 'Show terrain wireframe', exact: true }).click();
  await studio.getByLabel('Terrain vertical exaggeration', { exact: true }).focus();
  await page.keyboard.press('Home');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await expect(studio.getByLabel('Terrain vertical exaggeration', { exact: true })).toHaveValue(
    '1',
  );
  await expect(
    studio.getByRole('button', { name: 'Orthographic projection', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
  await expect(
    studio.getByRole('button', { name: 'Show terrain wireframe', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
  await studio.getByRole('button', { name: 'Reset terrain camera', exact: true }).click();
  await waitForMapPaint(studio);
  await waitForTerrainPaint(canvas);
  await page.screenshot({ path: info.outputPath('world-workspace-physical-split.png') });
  await studio.getByRole('button', { name: 'Close World Studio', exact: true }).click();
  await expect(page.locator('.wv-terrain-canvas canvas')).toHaveCount(0);
  await page.getByRole('button', { name: 'World Studio', exact: true }).click();
  await expect(canvas).toBeVisible();
  await expect(studio.locator('.wv-terrain-canvas canvas')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('World PBR shading uses a worker, preserves the visible renderer across builds and recovers context loss', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const { studio, errors } = await openWorkspace(page);
  const modes = studio.getByRole('group', { name: 'World view mode', exact: true });
  await modes.getByRole('button', { name: 'Terrain', exact: true }).click();
  const canvas = studio.getByRole('img', {
    name: 'Three-dimensional sampled world terrain',
    exact: true,
  });
  await expect(canvas).toHaveAttribute('data-material-state', 'ready', { timeout: 60_000 });
  await expect(canvas).toHaveAttribute('data-shading', 'material');
  const sceneId = await canvas.getAttribute('data-scene-id');
  const updates = Number(await canvas.getAttribute('data-mesh-updates'));
  await waitForTerrainPaint(canvas);
  const material = await screenshotPixels(page, await canvas.screenshot());
  const toggle = studio.getByRole('button', { name: 'Show authored PBR material', exact: true });
  await toggle.click();
  await expect(canvas).toHaveAttribute('data-shading', 'diagnostic');
  await waitForTerrainPaint(canvas);
  const diagnostic = await screenshotPixels(page, await canvas.screenshot());
  let changed = 0,
    differenceSum = 0,
    minimumIntensity = 255,
    maximumIntensity = 0;
  const colors = new Set<number>();
  for (let p = 0; p < material.length; p += 4) {
    const difference =
      (Math.abs(material[p] - diagnostic[p]) +
        Math.abs(material[p + 1] - diagnostic[p + 1]) +
        Math.abs(material[p + 2] - diagnostic[p + 2])) /
      3;
    if (difference > 2) changed++;
    differenceSum += difference;
    const intensity = (material[p] + material[p + 1] + material[p + 2]) / 3;
    minimumIntensity = Math.min(minimumIntensity, intensity);
    maximumIntensity = Math.max(maximumIntensity, intensity);
    colors.add((material[p] << 16) | (material[p + 1] << 8) | material[p + 2]);
  }
  expect(colors.size).toBeGreaterThan(64);
  expect(maximumIntensity - minimumIntensity).toBeGreaterThan(40);
  expect(changed / (128 * 128)).toBeGreaterThan(0.02);
  expect(differenceSum / (128 * 128)).toBeGreaterThan(0.5);
  await info.attach('world-pbr-render-metrics.json', {
    body: JSON.stringify({
      colors: colors.size,
      minimumIntensity,
      maximumIntensity,
      changedFraction: changed / (128 * 128),
      meanRGBDifference: differenceSum / (128 * 128),
    }),
    contentType: 'application/json',
  });
  await expect(canvas).toHaveAttribute('data-scene-id', sceneId!);
  await expect(canvas).toHaveAttribute('data-mesh-updates', String(updates));
  await toggle.click();
  await expect(canvas).toHaveAttribute('data-material-state', 'ready');
  await expect(canvas).toHaveAttribute('data-shading', 'material');

  // A completed replacement changes geometry resources, not the renderer or
  // camera controller. While the graph is stale it keeps its prior material.
  await studio.getByRole('tab', { name: 'Setup', exact: true }).click();
  await studio.getByLabel('Height scale', { exact: true }).fill('600');
  await studio.getByLabel('Height scale', { exact: true }).press('Tab');
  await expect(canvas).toHaveAttribute('data-scene-id', sceneId!);
  await studio.getByRole('button', { name: 'Build preview', exact: true }).click();
  await expect
    .poll(async () => Number(await canvas.getAttribute('data-mesh-updates')))
    .toBeGreaterThan(updates);
  await expect(canvas).toHaveAttribute('data-material-state', 'ready', { timeout: 60_000 });
  await expect(canvas).toHaveAttribute('data-scene-id', sceneId!);
  await expect(studio.locator('.wv-terrain-canvas canvas')).toHaveCount(1);
  await waitForTerrainPaint(canvas);
  const screenshot = info.outputPath('world-pbr-ready.png');
  await canvas.screenshot({ path: screenshot });
  await info.attach('world-pbr-ready.png', {
    path: screenshot,
    contentType: 'image/png',
  });

  await canvas.evaluate((surface: HTMLCanvasElement) => {
    const gl = surface.getContext('webgl2');
    const extension = gl?.getExtension('WEBGL_lose_context');
    if (!extension)
      throw new Error('Context-loss extension is unavailable in the qualification browser.');
    extension.loseContext();
  });
  await expect(studio.getByText('3D view unavailable', { exact: true })).toBeVisible();
  await expect(studio.locator('.wv-terrain-canvas canvas')).toHaveCount(0);
  await studio.getByRole('button', { name: 'Retry 3D', exact: true }).click();
  await expect(canvas).toHaveAttribute('data-material-state', 'ready', { timeout: 60_000 });
  expect(await canvas.getAttribute('data-scene-id')).not.toBe(sceneId);
  await expect(studio.locator('.wv-terrain-canvas canvas')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('comparison uses real metre differences and remains usable in dark and compact layouts', async ({
  page,
}, info) => {
  const { studio, errors } = await openWorkspace(page);
  await studio.getByRole('tab', { name: 'Analyze', exact: true }).click();
  await studio.getByRole('button', { name: 'Pin current terrain', exact: true }).click();
  await studio.getByRole('tab', { name: 'Setup', exact: true }).click();
  await studio.getByLabel('Local datum', { exact: true }).fill('100');
  await studio.getByLabel('Local datum', { exact: true }).press('Enter');
  await expect(studio.getByText('Changes ready to build', { exact: true })).toBeVisible();
  await studio.getByRole('button', { name: 'Build preview', exact: true }).click();
  await expect(studio.getByText('World overview ready', { exact: true })).toBeVisible();
  await studio.getByRole('tab', { name: 'Analyze', exact: true }).click();
  const comparison = studio.getByRole('group', { name: 'Terrain comparison', exact: true });
  await comparison.getByRole('button', { name: 'Difference', exact: true }).click();
  await expect(studio.locator('.wv-legend')).toContainText('Elevation change');
  await expect(studio.locator('.wv-legend')).toContainText('+100 m');
  await comparison.getByRole('button', { name: 'Wipe', exact: true }).click();
  const wipe = studio.getByLabel('Compare terrain wipe position', { exact: true });
  await wipe.focus();
  await page.keyboard.press('End');
  await expect(wipe).toHaveValue('100');
  await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: info.outputPath('world-workspace-dark.png') });
  await page.setViewportSize({ width: 760, height: 780 });
  await expect(
    studio.getByRole('button', { name: 'Show world controls', exact: true }),
  ).toBeVisible();
  await expect(
    studio.getByRole('region', { name: 'Interactive world map', exact: true }),
  ).toBeVisible();
  expect(await studio.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
  const shell = (await studio.boundingBox())!;
  expect(shell.width).toBeLessThanOrEqual(760);
  expect(shell.y + shell.height).toBeLessThanOrEqual(781);
  await studio.getByRole('tab', { name: 'Setup', exact: true }).click();
  await expect(studio.getByLabel('Width', { exact: true })).toBeVisible();
  await studio.getByRole('button', { name: 'Close controls panel', exact: true }).click();
  await expect(
    studio.getByRole('region', { name: 'Interactive world map', exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath('world-workspace-compact.png') });
  expect(errors).toEqual([]);
});
