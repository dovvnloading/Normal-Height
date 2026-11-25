import { expect, test } from '@playwright/test';
import { createProject } from '../../src/model/presets';

test('cinematic water is drawn, adjustable, coastline-linked, persistent, and optional', async ({
  page,
}, testInfo) => {
  const shaderErrors: string[] = [];
  page.on('pageerror', (error) => shaderErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' &&
        /THREE.WebGLProgram|shader|ERROR: 0:|VALIDATE_STATUS|GL_INVALID/i.test(message.text())) {
      shaderErrors.push(message.text());
    }
  });
  // Playwright supplies a fresh isolated browser context per test.
  // Do not clear storage via addInitScript: it also runs on reload and
  // would silently invalidate the persisted-settings assertion.
  await page.goto('/');
  await expect(page.locator('.nh-viewport-toolbar')).toBeVisible();

  const project = createProject('volcanic-island');
  project.resolution = 128;
  await page.getByLabel('Import terrain project file', { exact: true }).setInputFiles({
    name: 'volcanic-island.nhterrain.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(project)),
  });
  const canvas = page.getByRole('img', { name: /^Interactive 3D terrain/ });
  await expect(canvas).toHaveAttribute('data-displacement-status', 'ready', { timeout: 90_000 });
  await expect(canvas).toHaveAttribute('data-water-status', 'inactive');

  // The same completed mesh must render different pixels when the water pass
  // is enabled. This also catches shader errors that do not throw JS errors.
  const clip = await canvas.boundingBox();
  expect(clip).not.toBeNull();
  const dry = await page.screenshot({ clip: clip!, timeout: 30_000 });
  const toggle = page.getByRole('button', { name: 'Toggle water rendering' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(canvas).toHaveAttribute('data-water-status', 'ready');
  await expect(canvas).toHaveAttribute('data-water-level-meters', '504.00');
  await page.waitForTimeout(300);
  const wet = await page.screenshot({ clip: clip!, timeout: 30_000 });
  expect(wet.equals(dry), 'water must change actual pixels').toBe(false);
  await testInfo.attach('volcanic-island-with-water.png', {
    body: wet, contentType: 'image/png',
  });

  await page.getByRole('button', { name: 'Display settings' }).click();
  await page.getByRole('button', { name: 'Apply Tropical noon scene' }).click();
  await expect(canvas).toHaveAttribute('data-water-level-meters', '504.00');
  await expect(page.getByRole('checkbox', { name: 'Extend ocean horizon' })).toBeChecked();
  await page.waitForTimeout(450);
  const cinematic = await page.screenshot({ clip: clip!, timeout: 30_000 });
  expect(cinematic.equals(wet), 'cinematic lighting and ocean must change rendered pixels').toBe(false);
  await testInfo.attach('cinematic-tropical-island.png', { body: cinematic, contentType: 'image/png' });
  await expect(page.getByRole('region', { name: 'Display settings' })).toContainText(
    'Water & coastline',
  );
  await page.getByRole('button', { name: 'Open ocean' }).click();
  await expect(page.getByRole('button', { name: 'Open ocean' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.nh-water-readout')).toContainText('Open ocean');
  await page.getByRole('button', { name: 'Custom' }).click();
  await expect(page.getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-pressed', 'true');
  const level = page.getByRole('slider', { name: 'Water level' });
  await level.focus();
  await level.press('ArrowRight');
  await expect.poll(async () =>
    Number(await canvas.getAttribute('data-water-level-meters'))
  ).toBeGreaterThan(504);
  await expect(page.getByRole('slider', { name: 'Water clarity' })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Shoreline foam' })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Water wave height' })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Water wave speed' })).toBeVisible();
  await page.getByRole('button', { name: 'Follow coastline' }).click();
  await expect(canvas).toHaveAttribute('data-water-level-meters', '504.00');

  // Appearance persists independently from the graph. Imported projects are
  // kept as autosaved sessions and require an explicit restore after reload.
  await expect(page.locator('.save-state')).toContainText('Saved locally');
  await page.reload();
  await page.getByRole('button', { name: 'Restore last session' }).click();
  const restored = page.getByRole('img', { name: /^Interactive 3D terrain/ });
  await expect(page.locator('.nh-viewport')).toHaveAttribute('data-displayed-world-size', '4800', { timeout: 90_000 });
  await expect(restored).toHaveAttribute('data-water-status', 'ready', { timeout: 90_000 });
  await expect(restored).toHaveAttribute('data-water-level-meters', '504.00');
  await expect(page.locator('.nh-water-readout')).toContainText('Open ocean');

  await page.getByRole('button', { name: 'Toggle water rendering' }).click();
  await expect(restored).toHaveAttribute('data-water-status', 'inactive');
  await expect(page.locator('.nh-water-readout')).toHaveCount(0);
  expect(shaderErrors, 'WebGL water shader must compile without errors').toEqual([]);
});
