import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import type { TerrainProject } from '../../src/model/types';
import { resolveSurface } from '../../src/materials/pbr';
import { parseProject } from '../../src/model/project';

const fixture: TerrainProject = {
  version: 1, name: 'Painting studio acceptance', presetId: 'custom', resolution: 128,
  seed: 284, worldSize: 600, heightScale: 120, surface: resolveSurface({ biome: 'arid' }),
  graph: {
    nodes: [
      { id: 'mountain', kind: 'mountain', label: 'Massif', position: { x: 0, y: 0 }, params: { profile: 'massif' } },
      { id: 'out', kind: 'output', label: 'Output', position: { x: 240, y: 0 }, params: {} },
    ],
    edges: [{ id: 'terrain', source: 'mountain', target: 'out', sourceHandle: 'height', targetHandle: 'in' }],
  },
};

async function openStudio(page: Page, mode: '2d' | '3d' = '2d') {
  await page.goto('/');
  await page.getByLabel('Import terrain project file').setInputFiles({
    name: 'painting-studio.nhterrain.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await expect(page.locator('.nh-viewport')).toHaveAttribute('data-displayed-world-size', '600');
  await expect(page.locator('.nh-render-progress')).toHaveCount(0, { timeout: 60_000 });
  await page.getByRole('button', { name: 'Focus viewport', exact: true }).click();
  if (mode === '2d') await page.getByRole('button', { name: '2D map', exact: true }).click();
  await page.getByRole('button', { name: 'Paint terrain' }).click();
  await expect(page.getByRole('region', { name: 'Painting studio', exact: true })).toBeVisible();
}
async function storedProject(page: Page): Promise<TerrainProject> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('normal-height.project.v1') ?? '{}'));
}
async function strokeCount(page: Page) {
  const project = await storedProject(page);
  return project.paintLayers?.reduce((sum, layer) => sum + layer.strokes.length, 0) ?? project.materialPaint?.length ?? 0;
}
async function strokes(page: Page) {
  const project = await storedProject(page);
  return project.paintLayers?.flatMap(layer => layer.strokes) ?? project.materialPaint ?? [];
}
async function setNumber(page: Page, name: string, value: number) {
  const field = page.getByRole('spinbutton', { name, exact: true });
  await field.fill(String(value));
  await field.press('Enter');
  await expect.poll(async () => Number(await field.inputValue())).toBeCloseTo(value, 2);
}
async function inspectorTab(page: Page, name: 'Materials' | 'Brush' | 'Layers') {
  const open = page.getByRole('button', { name: 'Open paint inspector', exact: true });
  if (await open.isVisible()) await open.click();
  await page.getByRole('tab', { name: new RegExp(`^${name}`) }).click();
}
async function tilePoint(page: Page, u = 0.5, v = 0.5) {
  const rect = await page.locator('.nh-map-brush-preview').boundingBox();
  if (!rect) throw new Error('Paintable map footprint is missing');
  return { x: rect.x + rect.width * u, y: rect.y + rect.height * v };
}
async function dab(page: Page, u = 0.5, v = 0.5) {
  const point = await tilePoint(page, u, v);
  await page.mouse.click(point.x, point.y);
}
async function mapPixel(page: Page, u = 0.5, v = 0.5) {
  const rect = await page.locator('.nh-map-brush-preview').boundingBox();
  // The paint ring is intentionally absent while a layer is locked or before is shown.
  const map = page.locator('.nh-map > canvas');
  const bounds = (await map.boundingBox())!;
  const size = rect?.width ?? Math.max(1, Math.min(bounds.width - 84, bounds.height - 82));
  const x = (rect?.x ?? bounds.x + (bounds.width - size) / 2) + u * size;
  const y = (rect?.y ?? bounds.y + (bounds.height - size) / 2) + v * size;
  return map.evaluate((canvas: HTMLCanvasElement, point) => {
    const b = canvas.getBoundingClientRect();
    return canvas.getContext('2d')!.getImageData(Math.floor((point.x - b.x) * canvas.width / b.width),
      Math.floor((point.y - b.y) * canvas.height / b.height), 1, 1).data[0];
  }, { x, y });
}

// These exercise the actual browser input path, persisted projects and workers.
// They use a small graph so painting regressions do not require an erosion benchmark.
test.describe('painting studio', () => {
  test('composites named layers, opacity, visibility and order; locking cannot append paint', async ({ page }) => {
    await openStudio(page);
    await setNumber(page, 'Brush strength value', 100);
    await setNumber(page, 'Brush hardness value', 100);
    await setNumber(page, 'Brush radius value', 75);
    await page.getByRole('button', { name: 'Soil', exact: true }).click();
    await dab(page);
    await expect.poll(() => strokeCount(page)).toBe(1);
    await inspectorTab(page, 'Layers');
    await page.getByRole('button', { name: 'Add paint layer' }).click();
    const name = page.getByRole('textbox', { name: 'Paint layer name' });
    await name.fill('Snow accents'); await name.press('Enter');
    await page.getByRole('button', { name: 'Snow', exact: true }).click();
    await dab(page);
    await expect.poll(() => strokeCount(page)).toBe(2);
    await page.getByLabel('Map channel', { exact: true }).selectOption('snowWeight');
    await expect.poll(() => mapPixel(page)).toBe(255);

    await page.getByRole('button', { name: 'Hide Snow accents', exact: true }).click();
    await expect.poll(() => mapPixel(page)).toBe(0);
    await page.getByRole('button', { name: 'Show Snow accents', exact: true }).click();
    await expect.poll(() => mapPixel(page)).toBe(255);
    await setNumber(page, 'Layer opacity value', 25);
    await expect.poll(() => mapPixel(page)).toBeGreaterThanOrEqual(63);
    await expect.poll(() => mapPixel(page)).toBeLessThanOrEqual(65);
    await setNumber(page, 'Layer opacity value', 100);
    await page.getByRole('button', { name: 'Move layer down' }).click();
    await expect.poll(() => mapPixel(page)).toBe(0);
    await page.getByRole('button', { name: 'Move layer up' }).click();
    await expect.poll(() => mapPixel(page)).toBe(255);

    const point = await tilePoint(page);
    await page.getByRole('button', { name: 'Lock Snow accents', exact: true }).click();
    await expect(page.getByRole('spinbutton', { name: 'Layer opacity value' })).toBeDisabled();
    await page.mouse.click(point.x, point.y);
    await expect.poll(async () => (await storedProject(page)).paintLayers?.at(-1)?.locked).toBe(true);
    expect(await strokeCount(page)).toBe(2);
    await page.getByRole('button', { name: 'Unlock Snow accents', exact: true }).click();
    await dab(page, 0.62, 0.5);
    await expect.poll(() => strokeCount(page)).toBe(3);
    await page.getByRole('button', { name: 'Undo painting change' }).click();
    await expect.poll(() => strokeCount(page)).toBe(2);

    const saved = (await storedProject(page)).paintLayers;
    await page.getByRole('button', { name: 'Show original material' }).click();
    await expect.poll(() => mapPixel(page)).toBe(0);
    await page.getByRole('button', { name: 'Show original material' }).click();
    await expect.poll(() => mapPixel(page)).toBe(255);
    expect((await storedProject(page)).paintLayers).toEqual(saved);
    await page.getByRole('button', { name: 'Duplicate paint layer' }).click();
    await expect.poll(async () => (await storedProject(page)).paintLayers?.length).toBe(3);
    await page.getByRole('button', { name: 'Delete paint layer' }).click();
    await expect.poll(async () => (await storedProject(page)).paintLayers?.length).toBe(2);
    await page.getByRole('button', { name: 'Undo painting change' }).click();
    await expect.poll(async () => (await storedProject(page)).paintLayers?.length).toBe(3);
  });

  test('numeric controls and presets persist, while canvas shortcuts do not hijack typing', async ({ page }, info) => {
    await openStudio(page);
    await setNumber(page, 'Brush radius value', 60);
    await setNumber(page, 'Brush strength value', 73);
    await setNumber(page, 'Brush hardness value', 42);
    const map = page.locator('.nh-map > canvas');
    await page.getByRole('button', { name: 'Navigate terrain' }).click();
    await map.focus(); await page.keyboard.press('b');
    await expect(page.getByRole('button', { name: 'Paint terrain' })).toHaveAttribute('aria-pressed', 'true');
    await map.focus(); await page.keyboard.press('4');
    await expect(page.getByRole('button', { name: 'Snow', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('e');
    await expect(page.getByRole('button', { name: 'Erase', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('e');
    await expect(page.getByRole('button', { name: 'Snow', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press(']');
    await expect.poll(async () => Number(await page.getByLabel('Brush radius value').inputValue())).toBeGreaterThan(60);
    await page.keyboard.press('[');
    await expect.poll(async () => Number(await page.getByLabel('Brush radius value').inputValue())).toBeCloseTo(60, 1);
    await page.keyboard.down('Shift'); await page.keyboard.press('BracketRight'); await page.keyboard.up('Shift');
    await expect.poll(async () => Number(await page.getByLabel('Brush hardness value').inputValue())).toBeGreaterThan(42);
    // Digits in numeric fields must edit the number, not select a substrate.
    await setNumber(page, 'Brush strength value', 14);
    await expect(page.getByRole('button', { name: 'Snow', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await inspectorTab(page, 'Brush');
    await page.getByRole('button', { name: 'Soft wash', exact: true }).click();
    await expect(page.getByLabel('Brush strength value')).toHaveValue('35');
    await expect(page.getByLabel('Brush hardness value')).toHaveValue('8');
    await page.getByLabel('Pen pressure', { exact: true }).selectOption('both');
    await page.getByLabel('Brush radius unit', { exact: true }).selectOption('screen');
    await setNumber(page, 'Brush radius value', 48);
    await page.getByText('My brushes', { exact: true }).click();
    await page.getByRole('textbox', { name: 'Saved brush name' }).fill('Soft snow detail');
    await page.getByRole('button', { name: 'Save current brush preset' }).click();
    await expect(page.getByRole('button', { name: 'Use saved brush Soft snow detail' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Paint terrain' })).toBeEnabled({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Paint terrain' }).click();
    await expect(page.getByLabel('Brush strength value')).toHaveValue('35');
    await expect(page.getByLabel('Brush radius unit')).toHaveValue('screen');
    await expect(page.getByLabel('Brush radius value')).toHaveValue('48');
    await inspectorTab(page, 'Brush');
    await expect(page.getByLabel('Pen pressure', { exact: true })).toHaveValue('both');
    await page.getByText('My brushes', { exact: true }).click();
    await expect(page.getByRole('button', { name: 'Use saved brush Soft snow detail' })).toBeVisible();
    await page.setViewportSize({ width: 360, height: 740 });
    await expect(page.getByLabel('Brush strength value')).toBeInViewport();
    await expect(page.getByRole('slider', { name: 'Brush hardness', exact: true })).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Open paint inspector', exact: true })).toBeInViewport();
    await info.attach('Painting studio at 360 pixels', { body: await page.locator('.nh-viewport').screenshot(), contentType: 'image/png' });
    await page.getByRole('button', { name: 'Open paint inspector', exact: true }).click();
    await expect(page.getByRole('complementary', { name: 'Paint inspector' })).toBeInViewport();
    await info.attach('Painting tools drawer at 360 pixels', { body: await page.locator('.nh-viewport').screenshot(), contentType: 'image/png' });
  });

  test('Space navigation and a real two-touch pinch leave paint history unchanged', async ({ page }) => {
    await openStudio(page);
    const map = page.locator('.nh-map > canvas');
    const point = await tilePoint(page);
    const originalFootprint = await page.locator('.nh-map-brush-preview').boundingBox();
    await map.focus(); await page.keyboard.down('Space');
    await page.mouse.move(point.x, point.y); await page.mouse.down();
    await page.mouse.move(point.x + 50, point.y + 35, { steps: 6 }); await page.mouse.up();
    await page.keyboard.up('Space');
    await expect.poll(async () => (await page.locator('.nh-map-brush-preview').boundingBox())?.x).not.toBe(originalFootprint!.x);
    expect(await strokeCount(page)).toBe(0);
    await expect(page.getByRole('button', { name: 'Paint terrain' })).toHaveAttribute('aria-pressed', 'true');
    await map.focus(); await page.keyboard.press('Home');
    const center = await tilePoint(page);
    const client = await page.context().newCDPSession(page);
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
    const one = { x: Math.round(center.x - 30), y: Math.round(center.y), id: 1 };
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [one] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...one, x: one.x + 8 }] });
    const points = (span: number) => [{ x: Math.round(center.x - span), y: Math.round(center.y), id: 1 },
      { x: Math.round(center.x + span), y: Math.round(center.y), id: 2 }];
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(30) });
    for (const span of [45, 65, 85]) await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(span) });
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => page.locator('.nh-map-controls > span').innerText()).not.toBe('100%');
    expect(await strokeCount(page)).toBe(0);
    await expect(page.getByRole('button', { name: 'Paint terrain' })).toHaveAttribute('aria-pressed', 'true');
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await client.detach();
    await map.focus(); await page.keyboard.press('Home');
    await dab(page);
    await expect.poll(() => strokeCount(page)).toBe(1);
  });

  test('polygon and connected fills stay editable and honor their selection', async ({ page }) => {
    await openStudio(page);
    await setNumber(page, 'Brush strength value', 100);
    await setNumber(page, 'Brush hardness value', 100);
    await page.getByRole('button', { name: 'Snow', exact: true }).click();
    await inspectorTab(page, 'Materials');
    await page.getByRole('button', { name: 'Polygon select', exact: true }).click();
    for (const [u, v] of [[0.3, 0.3], [0.7, 0.3], [0.7, 0.7], [0.3, 0.7]]) await dab(page, u, v);
    await page.getByRole('button', { name: 'Apply polygon', exact: true }).click();
    await page.getByRole('button', { name: 'Fill selection', exact: true }).click();
    await expect.poll(() => strokeCount(page)).toBe(1);
    const [fill] = await strokes(page);
    expect(fill.fullTile).toBe(true);
    expect(fill.selection?.points).toHaveLength(4);
    await page.getByLabel('Map channel', { exact: true }).selectOption('snowWeight');
    await expect.poll(() => mapPixel(page)).toBe(255);
    await expect.poll(() => mapPixel(page, 0.15, 0.15)).toBe(0);
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await page.getByRole('button', { name: 'Vegetation', exact: true }).click();
    await page.getByRole('button', { name: 'Connected fill', exact: true }).click();
    await dab(page);
    await expect.poll(() => strokeCount(page)).toBe(2);
    const connected = (await strokes(page)).at(-1)!;
    expect(connected.fullTile).toBe(true);
    expect(connected.selection?.region?.runs.length).toBeGreaterThan(0);
    await page.getByLabel('Map channel', { exact: true }).selectOption('vegetationWeight');
    await expect.poll(() => mapPixel(page)).toBe(255);
    await page.getByRole('button', { name: 'Undo painting change' }).click();
    await expect.poll(() => strokeCount(page)).toBe(1);
    await page.getByLabel('Map channel', { exact: true }).selectOption('snowWeight');
    await expect.poll(() => mapPixel(page)).toBe(255);
  });

  test('renders a live PBR draft before release and commits exactly one undoable gesture', async ({ page }, info) => {
    await openStudio(page, '3d');
    await page.getByRole('button', { name: 'Snow', exact: true }).click();
    await setNumber(page, 'Brush strength value', 100);
    const terrain = page.locator('.nh-three-host canvas');
    await expect(terrain).toHaveAttribute('data-material-status', 'ready');
    const rect = (await terrain.boundingBox())!;
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + 24, y + 8, { steps: 8 });
    await expect(terrain).toHaveAttribute('data-brush-preview-status', 'live', { timeout: 30_000 });
    expect(await strokeCount(page)).toBe(0);
    await page.keyboard.press('Escape'); await page.mouse.up();
    await expect(terrain).toHaveAttribute('data-brush-preview-status', 'idle');
    expect(await strokeCount(page)).toBe(0);
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + 30, y - 10, { steps: 8 });
    await expect(terrain).toHaveAttribute('data-brush-preview-status', 'live');
    await page.mouse.up();
    await expect.poll(() => strokeCount(page)).toBe(1);
    await expect(terrain).toHaveAttribute('data-material-status', 'ready');
    await page.getByRole('button', { name: 'Undo painting change' }).click();
    await expect.poll(() => strokeCount(page)).toBe(0);
    await page.getByRole('button', { name: 'Redo painting change' }).click();
    await expect.poll(() => strokeCount(page)).toBe(1);
    await info.attach('Painting studio', { body: await page.locator('.nh-viewport').screenshot(), contentType: 'image/png' });
  });

  test('saved and exported projects roundtrip layers and terrain rules', async ({ page }) => {
    test.setTimeout(150_000);
    await openStudio(page);
    await inspectorTab(page, 'Layers');
    await page.getByRole('button', { name: 'Add paint layer' }).click();
    const name = page.getByRole('textbox', { name: 'Paint layer name' });
    await name.fill('Masked meadow'); await name.press('Enter');
    await page.getByRole('button', { name: 'Vegetation', exact: true }).click();
    await inspectorTab(page, 'Brush');
    await page.getByRole('checkbox', { name: 'Brush mask slope constraint' }).check();
    await setNumber(page, 'Brush mask slope maximum', 90);
    await dab(page);
    await expect.poll(() => strokeCount(page)).toBe(1);
    await inspectorTab(page, 'Layers');
    await setNumber(page, 'Layer opacity value', 65);
    await expect.poll(async () => (await storedProject(page)).paintLayers?.at(-1)?.opacity).toBe(0.65);
    const original = await storedProject(page);
    const save = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save project', exact: true }).click();
    const saved = await save;
    const savedBytes = await readFile((await saved.path())!);
    const savedProject = parseProject(JSON.parse(savedBytes.toString('utf8')));
    expect(savedProject.paintLayers).toEqual(original.paintLayers);

    await page.getByRole('button', { name: 'Export maps', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Export your landscape', exact: true });
    await dialog.getByLabel('Export format').selectOption('pbr');
    await dialog.getByLabel('Export resolution').selectOption('256');
    const download = page.waitForEvent('download', { timeout: 90_000 });
    await dialog.getByRole('button', { name: 'Export bundle', exact: true }).click();
    const exported = await download;
    const archive = unzipSync(await readFile((await exported.path())!));
    const projectName = Object.keys(archive).find(key => key.endsWith('.nhterrain.json'))!;
    const bundledProject = parseProject(JSON.parse(strFromU8(archive[projectName])));
    expect(bundledProject.paintLayers).toEqual(original.paintLayers);
    expect(Object.keys(archive).some(key => key.endsWith('-splat-rgba.png'))).toBe(true);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByLabel('Import terrain project file').setInputFiles({
      name: 'roundtrip.nhterrain.json', mimeType: 'application/json', buffer: savedBytes,
    });
    await expect.poll(async () => (await storedProject(page)).paintLayers).toEqual(original.paintLayers);
    expect((await strokes(page))[0].mask?.slope).toEqual([0, 90]);
  });

  test('IndexedDB preserves paint when project localStorage writes exceed quota', async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (this === window.localStorage && key === 'normal-height.project.v1')
          throw new DOMException('Project storage quota reached', 'QuotaExceededError');
        return original.call(this, key, value);
      };
    });
    const backup = () => page.evaluate(async () => {
      const databases = await indexedDB.databases();
      if (!databases.some(database => database.name === 'normal-height-studio-v1')) return null;
      return new Promise<{ project: TerrainProject; savedAt: number } | null>((resolve, reject) => {
        const request = indexedDB.open('normal-height-studio-v1', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains('session')) { database.close(); resolve(null); return; }
          const transaction = database.transaction('session', 'readonly');
          const read = transaction.objectStore('session').get('latest');
          read.onerror = () => reject(read.error);
          read.onsuccess = () => resolve(read.result ?? null);
          transaction.oncomplete = () => database.close();
          transaction.onabort = () => { database.close(); reject(transaction.error); };
        };
      });
    });
    await openStudio(page);
    await page.getByRole('button', { name: 'Snow', exact: true }).click();
    await setNumber(page, 'Brush strength value', 100);
    await dab(page);
    await expect.poll(async () => {
      const project = (await backup())?.project;
      return project?.paintLayers?.flatMap(layer => layer.strokes).length ?? project?.materialPaint?.length ?? 0;
    }).toBe(1);
    await expect(page.locator('.save-state')).toContainText('Saved locally');
    expect(await page.evaluate(() => localStorage.getItem('normal-height.project.v1'))).toBeNull();
    const saved = await backup();
    expect(saved?.project.name).toBe(fixture.name);
    expect(saved?.savedAt).toBeGreaterThan(0);
    const savedPaint = saved!.project.paintLayers?.flatMap(layer => layer.strokes) ?? saved!.project.materialPaint!;
    expect(savedPaint[0].layer).toBe('snow');

    await page.reload();
    const restore = page.getByRole('button', { name: 'Restore last session', exact: true });
    await expect(restore).toBeVisible();
    await restore.click();
    await expect(page.locator('.project-name')).toContainText(fixture.name);
    await expect(page.locator('.nh-viewport')).toHaveAttribute('data-displayed-world-size', '600');
    await expect(page.getByRole('button', { name: 'Paint terrain' })).toBeEnabled({ timeout: 60_000 });
    await page.getByRole('button', { name: '2D map', exact: true }).click();
    await page.getByRole('button', { name: 'Paint terrain' }).click();
    await page.getByLabel('Map channel', { exact: true }).selectOption('snowWeight');
    await expect.poll(() => mapPixel(page)).toBe(255);
    expect((await backup())?.project).toEqual(saved!.project);

    // A selection is transient workspace state, not part of an unrelated file.
    await inspectorTab(page, 'Materials');
    await page.getByRole('button', { name: 'Polygon select', exact: true }).click();
    for (const [u, v] of [[0.25, 0.25], [0.75, 0.25], [0.5, 0.75]]) await dab(page, u, v);
    await page.getByRole('button', { name: 'Apply polygon', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Fill selection', exact: true })).toBeEnabled();
    const unrelated = { ...fixture, name: 'Another painting session', seed: 285 };
    await page.getByLabel('Import terrain project file').setInputFiles({
      name: 'another-session.nhterrain.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(unrelated)),
    });
    await expect(page.locator('.project-name')).toContainText(unrelated.name);
    await expect(page.getByRole('button', { name: 'Paint terrain' })).toBeEnabled({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Paint terrain' }).click();
    await inspectorTab(page, 'Materials');
    await expect(page.getByRole('button', { name: 'Fill selection', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Polygon select', exact: true })).toHaveAttribute('aria-pressed', 'false');
  });

});
