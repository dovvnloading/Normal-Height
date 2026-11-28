import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createProject } from '../../src/model/presets';
import { parseProject } from '../../src/model/project';
import { STUDIO_DEFAULTS } from '../../src/model/noiseStudio';
import { createWorldDefinition } from '../../src/model/world';

test.use({ video: 'off' });

async function openGenesisWorkspace(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const project = createProject('studio-dunes');
  project.version = 2;
  project.name = 'Genesis formation acceptance';
  project.resolution = 64;
  project.worldSize = 4000;
  const source = project.graph.nodes[0];
  const output = project.graph.nodes.at(-1)!;
  source.params = {
    ...STUDIO_DEFAULTS,
    noiseModel: 'v3',
    kernel: 'perlin',
    fractal: 'fbm',
    warpType: 'none',
    sampling: 'point',
  };
  project.graph = {
    nodes: [source, output],
    edges: [
      {
        id: 'genesis-source-output',
        source: source.id,
        target: output.id,
        sourceHandle: 'height',
        targetHandle: 'in',
      },
    ],
  };
  project.world = createWorldDefinition(project);
  project.world.globalResolution = 64;
  project.world.domain.depth = 2000;
  project.world.domain.boundary = 'open';
  await page.getByLabel('Import terrain project file').setInputFiles({
    name: 'genesis-acceptance.nhterrain.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(page.locator('.project-name')).toHaveText(project.name);
  await expect(
    page.getByRole('contentinfo').getByText('Terrain ready', { exact: true }),
  ).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'World Studio', exact: true }).click();
  const studio = page.getByRole('region', { name: 'World Studio', exact: true });
  await expect(studio.getByText('World overview ready', { exact: true })).toBeVisible({
    timeout: 90_000,
  });
  await studio.getByLabel('Automatic world previews').uncheck();
  await studio.getByText('Preview behaviour', { exact: true }).click();
  await studio.getByLabel('Automatic regional refinement').uncheck();
  await studio.getByRole('tab', { name: 'Simulate', exact: true }).click();
  return { studio, project, errors };
}

async function setNumber(studio: Locator, label: string, value: string) {
  const input = studio.getByLabel(label, { exact: true });
  await input.fill(value);
  await input.press('Enter');
}

async function build(studio: Locator) {
  await studio.getByRole('button', { name: 'Build world', exact: true }).click();
  await expect(studio.getByText('World overview ready', { exact: true })).toBeVisible({
    timeout: 90_000,
  });
  await expect(studio.getByRole('button', { name: 'Build world', exact: true })).toBeEnabled();
}

async function report(page: Page, studio: Locator) {
  await studio.getByRole('tab', { name: 'Analyze', exact: true }).click();
  const pending = page.waitForEvent('download');
  await studio.getByRole('button', { name: 'Download stage report', exact: true }).click();
  const download = await pending;
  return JSON.parse(await readFile((await download.path())!, 'utf8'));
}

test('artists author a geological world, inspect real diagnostics and save reproducible settings', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const { studio, project, errors } = await openGenesisWorkspace(page);
  const enable = studio.getByLabel('Enable World Genesis', { exact: true });
  await expect(enable).not.toBeChecked();
  await studio.getByRole('tab', { name: 'Explore', exact: true }).click();
  await expect(studio.getByRole('button', { name: 'Lithology', exact: true })).toBeDisabled();
  await studio.getByRole('tab', { name: 'Simulate', exact: true }).click();
  await enable.focus();
  await page.keyboard.press('Space');
  await expect(enable).toBeChecked();
  await studio.getByRole('button', { name: /Layered badlands/ }).click();
  await expect(studio.getByLabel('Peak uplift', { exact: true })).toHaveValue('90');
  await expect(studio.getByLabel('Enable world transport', { exact: true })).not.toBeChecked();
  await studio.getByText('Uplift & erosion controls', { exact: true }).click();
  await setNumber(studio, 'Formation iterations', '3');
  await studio.getByLabel('Global reference', { exact: true }).selectOption('128');
  await build(studio);
  await expect(studio.getByText('Last Genesis formation', { exact: true })).toBeVisible();
  await expect(studio.getByText('Formation spacing', { exact: true })).toBeVisible();
  await studio
    .getByRole('heading', { name: 'World Genesis', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('genesis-formation-controls.png') });
  const result = await report(page, studio);
  expect(result.genesis).toMatchObject({
    algorithmVersion: 'world-genesis-1',
    mode: 'multiscale-stream-power',
    width: 128,
    height: 65,
  });
  expect(result.genesis.incisedVolumeM3).toBeGreaterThan(0);
  expect(result.genesis.maxDrainageAreaM2).toBeGreaterThan(0);
  expect(result.genesis.levels.length).toBeGreaterThan(1);
  expect(result.genesis.spacingX).toBeCloseTo(4000 / 127);
  expect(result.genesis.spacingZ).toBeCloseTo(2000 / 64);
  expect(result.transportBudget).toBeUndefined();
  expect(result.world.genesis).toMatchObject({ enabled: true, iterations: 3, upliftMeters: 90 });
  expect(result.stages.some((stage: { nodeId: string }) => stage.nodeId === 'world-genesis')).toBe(
    true,
  );
  await info.attach('genesis-formation-report', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });

  await studio.getByRole('tab', { name: 'Explore', exact: true }).click();
  await studio.getByRole('button', { name: 'Lithology', exact: true }).click();
  await expect(studio.getByLabel('Lithology legend', { exact: true })).toBeVisible();
  await expect(
    studio.getByLabel('Lithology legend', { exact: true }).getByText('Sandstone', { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath('genesis-lithology.png') });
  await studio.getByRole('tab', { name: 'Analyze', exact: true }).click();
  const map = studio.getByRole('region', { name: 'Interactive world map', exact: true });
  const bounds = (await map.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5);
  await expect(
    studio.getByRole('heading', { name: 'Geology & catchment probe', exact: true }),
  ).toBeVisible();
  await expect(studio.getByText('Rock class', { exact: true })).toBeVisible();
  await expect(studio.getByText('Contributing area', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('genesis-analysis.png') });

  await studio.getByRole('tab', { name: 'Explore', exact: true }).click();
  await studio.getByRole('button', { name: 'Rock hardness', exact: true }).click();
  await page.screenshot({ path: info.outputPath('genesis-hardness.png') });
  await studio.getByRole('button', { name: 'Shaded relief', exact: true }).click();
  const modes = studio.getByRole('group', { name: 'World view mode', exact: true });
  await modes.getByRole('button', { name: 'Terrain', exact: true }).click();
  const terrain = studio.locator('.wv-terrain-canvas canvas');
  await expect(terrain).toHaveAttribute('data-rendered', 'true');
  const material = studio.getByRole('button', { name: 'Show authored PBR material', exact: true });
  if ((await material.getAttribute('aria-pressed')) !== 'true') await material.click();
  await expect(terrain).toHaveAttribute('data-material-state', 'ready', { timeout: 60_000 });
  await expect(terrain).toHaveAttribute('data-shading', 'material');
  await terrain.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.screenshot({ path: info.outputPath('genesis-formed-terrain-3d.png') });

  await studio.getByRole('button', { name: 'Close World Studio', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  const saved = JSON.parse(await readFile((await (await pending).path())!, 'utf8'));
  expect(saved.world.genesis).toEqual(result.world.genesis);
  expect(saved.graph).toEqual(parseProject(project).graph);
  expect(errors).toEqual([]);
});

test('cancelling a more detailed formation retains the last completed diagnostic fields', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { studio, errors } = await openGenesisWorkspace(page);
  await studio.getByLabel('Enable World Genesis', { exact: true }).check();
  await studio.getByText('Uplift & erosion controls', { exact: true }).click();
  await setNumber(studio, 'Formation iterations', '2');
  await build(studio);
  const before = await report(page, studio);
  await studio.getByRole('tab', { name: 'Simulate', exact: true }).click();
  await studio.getByLabel('Global reference', { exact: true }).selectOption('512');
  await setNumber(studio, 'Formation iterations', '64');
  await studio.getByRole('button', { name: 'Build world', exact: true }).click();
  await studio.getByRole('button', { name: 'Cancel preview', exact: true }).click();
  await expect(studio.getByRole('button', { name: 'Cancel preview', exact: true })).toHaveCount(0);
  await expect(studio.getByRole('button', { name: 'Build world', exact: true })).toBeEnabled();
  const retained = await report(page, studio);
  expect(retained.genesis).toEqual(before.genesis);
  expect(retained.stale).toBe(true);
  expect(retained.world.globalResolution).toBe(64);
  await studio.getByRole('tab', { name: 'Explore', exact: true }).click();
  await expect(studio.getByRole('button', { name: 'Drainage area', exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});
