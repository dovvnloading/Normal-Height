import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { unzipSync } from 'fflate';
import type { TerrainProject } from '../../src/model/types';

async function savedProject(page: Page, testInfo: TestInfo, name: string) {
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  const download = await downloading;
  const path = testInfo.outputPath(name);
  await download.saveAs(path);
  return JSON.parse(await readFile(path, 'utf8')) as TerrainProject;
}

async function addNoise(page: Page) {
  await page.goto('/');
  await page.locator('.library-node').filter({ hasText: 'Procedural noise' }).click();
  await expect(page.getByLabel('Noise Studio', { exact: true })).toBeVisible();
  await expect(page.locator('.studio-live-preview canvas').first()).toHaveAttribute('width', '160');
}

async function captureStudio(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(name);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

test('noise browser cancellation is inert and a preset is one undo step', async ({
  page,
}, testInfo) => {
  await addNoise(page);
  const before = await savedProject(page, testInfo, 'before-studio-preset.json');
  const noise = before.graph.nodes.at(-1)!;
  expect(noise.params.noiseModel).toBe('v3');
  await page.getByRole('button', { name: 'Noise library', exact: true }).click();
  const library = page.getByRole('dialog', { name: 'Noise library', exact: true });
  await library.getByRole('textbox', { name: 'Search noise library' }).fill('Gabor ripples');
  const card = library.locator('.studio-noise-card').filter({ hasText: 'Gabor ripples' });
  await expect(card.locator('canvas')).toHaveAttribute('width', '96');
  await card.click();
  await captureStudio(page, testInfo, 'studio-noise-library.png');
  await library.getByRole('textbox', { name: 'Search noise library' }).fill('crater');
  await expect(library.getByRole('button', { name: 'Apply noise', exact: true })).toBeDisabled();
  await library.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await savedProject(page, testInfo, 'cancelled-studio-preset.json')).toEqual(before);

  await page.getByRole('button', { name: 'Noise library', exact: true }).click();
  await library.getByRole('textbox', { name: 'Search noise library' }).fill('Gabor ripples');
  await library.locator('.studio-noise-card').filter({ hasText: 'Gabor ripples' }).click();
  await library.getByRole('button', { name: 'Apply noise', exact: true }).click();
  const changed = await savedProject(page, testInfo, 'applied-studio-preset.json');
  const updated = changed.graph.nodes.find((node) => node.id === noise.id)!;
  expect(updated.params.kernel).toBe('gabor');
  expect(updated.params.fractal).toBe('none');
  expect(updated.params.seed).toBe(noise.params.seed);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await savedProject(page, testInfo, 'undone-studio-preset.json')).toEqual(before);
});

test('locked streams survive world-seed edits and disable seed mutations', async ({ page }) => {
  await addNoise(page);
  const effective = page.getByLabel('Effective noise seed');
  await page.getByRole('textbox', { name: 'Noise seed name' }).fill('north-ridge');
  const captured = await effective.textContent();
  await page.getByRole('button', { name: 'Lock seed', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Randomize selected noise seed' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Explore 9 seeds', exact: true })).toBeDisabled();
  const worldSeed = page.getByRole('spinbutton', { name: 'World seed', exact: true });
  await worldSeed.fill('187654');
  await worldSeed.press('Enter');
  await expect(effective).toHaveText(captured!);
  await page.getByRole('button', { name: 'Locked', exact: true }).click();
  await expect(effective).not.toHaveText(captured!);
  await page.getByRole('combobox', { name: 'Noise seed mode' }).selectOption('fixed');
  const independent = await effective.textContent();
  await worldSeed.fill('87213');
  await worldSeed.press('Enter');
  await expect(effective).toHaveText(independent!);
});

test('seed contact sheet renders real variations, supports favorites, and cancels safely', async ({
  page,
}, testInfo) => {
  await addNoise(page);
  const before = await savedProject(page, testInfo, 'before-seed-explorer.json');
  await page.getByRole('button', { name: 'Explore 9 seeds', exact: true }).click();
  const explorer = page.getByRole('dialog', { name: 'Seed explorer', exact: true });
  await expect(explorer.locator('.studio-seed-select')).toHaveCount(9);
  await expect(explorer.locator('canvas[width="112"]')).toHaveCount(9);
  const fingerprints = await explorer
    .locator('canvas')
    .evaluateAll((elements) =>
      elements.map((element) => (element as HTMLCanvasElement).toDataURL()),
    );
  expect(new Set(fingerprints).size).toBe(9);
  await explorer.locator('.studio-seed-select').nth(1).click();
  await explorer.locator('.studio-favorite').nth(1).click();
  await captureStudio(page, testInfo, 'studio-seed-explorer.png');
  await explorer.getByRole('button', { name: /^Favorites/ }).click();
  await expect(explorer.locator('.studio-seed-card')).toHaveCount(1);
  await explorer.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await savedProject(page, testInfo, 'cancelled-seed-explorer.json')).toEqual(before);
  await page.getByRole('button', { name: 'Explore 9 seeds', exact: true }).click();
  await explorer.getByRole('button', { name: /^Favorites/ }).click();
  await expect(explorer.locator('.studio-seed-card')).toHaveCount(1);
  await explorer.locator('.studio-seed-select').click();
  await explorer.getByRole('button', { name: 'Apply look', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Locked', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('recipe import validates before applying and restores complete settings atomically', async ({
  page,
}, testInfo) => {
  await addNoise(page);
  const before = await savedProject(page, testInfo, 'before-noise-recipe.json');
  await page.getByRole('button', { name: 'Recipe', exact: true }).click();
  const recipe = page.getByRole('dialog', { name: 'Noise recipe', exact: true });
  const exported = JSON.parse(
    await recipe.getByRole('textbox', { name: 'Current noise recipe' }).inputValue(),
  );
  await recipe.getByRole('button', { name: 'Paste recipe', exact: true }).click();
  const editor = recipe.getByRole('textbox', { name: 'Paste noise recipe' });
  await editor.fill('{"format":"unsupported"}');
  await expect(recipe.getByRole('button', { name: 'Apply recipe', exact: true })).toBeDisabled();
  exported.params.kernel = 'dunes';
  exported.params.fractal = 'none';
  exported.params.seedMode = 'fixed';
  exported.params.seedText = 'studio-recipe';
  exported.params.curve = '[[0,0],[0.4,0.1],[1,1]]';
  await editor.fill(JSON.stringify(exported));
  await expect(recipe.getByText('Recipe validated', { exact: true })).toBeVisible();
  await recipe.getByRole('button', { name: 'Apply recipe', exact: true }).click();
  const after = await savedProject(page, testInfo, 'applied-noise-recipe.json');
  const applied = after.graph.nodes.at(-1)!;
  expect(applied.params.kernel).toBe('dunes');
  expect(applied.params.seedText).toBe('studio-recipe');
  expect(applied.params.curve).toBe('[[0,0],[0.4,0.1],[1,1]]');
  await page
    .locator('.studio-parameter-section > summary')
    .filter({ hasText: /^Output$/ })
    .click();
  const point = page.getByRole('slider', { name: 'Curve point 2', exact: true });
  await point.focus();
  await point.press('ArrowUp');
  const reshaped = await savedProject(page, testInfo, 'keyboard-noise-curve.json');
  expect(JSON.parse(String(reshaped.graph.nodes.at(-1)!.params.curve))[1]).toEqual([0.4, 0.11]);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await savedProject(page, testInfo, 'undone-noise-curve.json')).toEqual(after);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await savedProject(page, testInfo, 'undone-noise-recipe.json')).toEqual(before);
});

test('source export cancels a large job and downloads a valid 16-bit map with its recipe', async ({
  page,
}, testInfo) => {
  await addNoise(page);
  const expectedSeed = Number(await page.getByLabel('Effective noise seed').textContent());
  let downloadCount = 0;
  page.on('download', () => downloadCount++);
  await page.getByRole('button', { name: 'Export source', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export noise source', exact: true });
  await dialog.getByRole('combobox', { name: 'Noise export resolution' }).selectOption('4096');
  await dialog.getByRole('button', { name: 'Export source bundle', exact: true }).click();
  await dialog.getByRole('button', { name: 'Cancel export', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'Export source bundle', exact: true }),
  ).toBeEnabled();
  expect(downloadCount).toBe(0);
  await dialog.getByRole('combobox', { name: 'Noise export resolution' }).selectOption('256');
  const downloading = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export source bundle', exact: true }).click();
  const download = await downloading;
  const path = testInfo.outputPath('studio-source-256.zip');
  await download.saveAs(path);
  expect(downloadCount).toBe(1);
  const archive = unzipSync(new Uint8Array(await readFile(path)));
  const metadata = JSON.parse(new TextDecoder().decode(archive['metadata.json']));
  const recipe = JSON.parse(new TextDecoder().decode(archive['source.nhnoise.json']));
  const png = Object.entries(archive).find(([name]) => name.endsWith('.png'))![1];
  expect(metadata.resolution).toEqual([256, 256]);
  expect(metadata.resolvedSeed).toBe(expectedSeed);
  expect(metadata.valueMax).toBeGreaterThan(metadata.valueMin);
  expect(recipe.engine).toBe(3);
  expect(new DataView(png.buffer, png.byteOffset, png.byteLength).getUint32(16)).toBe(256);
  expect(png[24]).toBe(16);
  expect(png[25]).toBe(0);
  await expect(dialog.getByRole('status').filter({ hasText: 'Downloaded' })).toBeVisible();
  await captureStudio(page, testInfo, 'studio-source-export-complete.png');
});

test('dark noise library fits a small viewport and supports scrolling and keyboard navigation', async ({
  page,
}, testInfo) => {
  await addNoise(page);
  await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Noise library', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Noise library', exact: true });
  const cards = dialog.locator('.studio-noise-card');
  await expect(cards).toHaveCount(18);
  await expect(dialog.locator('canvas[width="96"]')).toHaveCount(18, { timeout: 30_000 });

  await cards.first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(cards.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(cards.nth(4)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(cards.nth(4)).toHaveAttribute('aria-pressed', 'true');
  await captureStudio(page, testInfo, 'studio-noise-library-desktop-dark.png');

  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(async () => {
      const bounds = await dialog.boundingBox();
      return Boolean(
        bounds &&
        bounds.x >= 0 &&
        bounds.y >= 0 &&
        bounds.x + bounds.width <= 391 &&
        bounds.y + bounds.height <= 845,
      );
    })
    .toBe(true);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const scroll = dialog.locator('.studio-browser-scroll');
  expect(await scroll.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true,
  );
  await cards.first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(cards.nth(2)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(cards.nth(2)).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('End');
  await expect(cards.last()).toBeFocused();
  await expect(cards.last()).toBeInViewport({ ratio: 1 });
  expect(await scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport({
    ratio: 1,
  });
  await expect(dialog.getByRole('button', { name: 'Apply noise', exact: true })).toBeInViewport({
    ratio: 1,
  });
  await page.keyboard.press('Home');
  await expect(cards.first()).toBeFocused();
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(2);
  await captureStudio(page, testInfo, 'studio-noise-library-dark-390x844.png');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
