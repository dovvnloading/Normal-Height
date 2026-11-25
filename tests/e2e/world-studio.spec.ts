import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { createProject } from '../../src/model/presets';
import { createNode } from '../../src/model/registry';

// Exercises real production workers, immutable cache transfer, domain editing,
// regional sampling, streamed download/ack, and portable project persistence.
test.use({ video: 'off' });

test('World Studio builds, refines, exports aligned tiles, and saves explicit world projects', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const project = createProject('studio-dunes');
  project.resolution = 128;
  project.name = 'World acceptance';
  const source = project.graph.nodes[0];
  Object.assign(source.params, { kernel: 'perlin', fractal: 'none', octaves: 2, warpMode: 'none' });
  const remap = createNode('remap', { x: 280, y: 100 }, 'world-shape');
  const mask = createNode('mask', { x: 280, y: 260 }, 'world-mask');
  mask.label = 'Elevation band';
  const output = project.graph.nodes.at(-1)!;
  project.graph = {
    nodes: [source, remap, mask, output],
    edges: [
      {
        id: 'source-shape',
        source: source.id,
        target: remap.id,
        sourceHandle: 'height',
        targetHandle: 'in',
      },
      {
        id: 'shape-output',
        source: remap.id,
        target: output.id,
        sourceHandle: 'height',
        targetHandle: 'in',
      },
      {
        id: 'source-mask',
        source: source.id,
        target: mask.id,
        sourceHandle: 'height',
        targetHandle: 'in',
      },
    ],
  };
  // Preset parser validates values; use the existing versioned settings except
  // the known valid kernel. Avoid assuming undocumented fractal aliases.
  delete source.params.fractal;
  await page
    .getByLabel('Import terrain project file')
    .setInputFiles({
      name: 'world-test.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(project)),
    });
  await expect(page.getByText('Terrain ready', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Build terrain', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Compute diagnostics' })).toContainText('3 cached');
  await page.getByRole('button', { name: 'World Studio', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'World Studio', exact: true });
  await expect(dialog.getByText('World overview ready', { exact: true })).toBeVisible({
    timeout: 90_000,
  });
  await dialog.getByLabel('World depth', { exact: true }).fill('4000');
  await dialog.getByLabel('South intervals', { exact: true }).fill('512');
  await dialog.getByRole('button', { name: 'Build world', exact: true }).click();
  await expect(dialog.getByText('World overview ready', { exact: true })).toBeVisible();
  const map = dialog.getByRole('button', { name: /^World region map/ });
  // The physical 8 km × 4 km rectangle must fit without distorting terrain.
  // A generic dialog width or max-width clamp must not silently squeeze it.
  expect((await dialog.boundingBox())!.width).toBeGreaterThan(1100);
  await expect
    .poll(async () => {
      const bounds = await map.boundingBox();
      return bounds!.width / bounds!.height;
    })
    .toBeCloseTo(2, 2);
  await map.focus();
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByText('Region selected', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Refine region', exact: true }).click();
  await expect(dialog.getByText('Region ready', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(dialog.getByText('World overview ready', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Enable World project', exact: true }).click();
  await expect(dialog.getByText('WORLD PROJECT', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('world-studio.png') });
  await dialog.getByRole('tab', { name: 'Export', exact: true }).click();
  await dialog.getByLabel('World export samples').selectOption('512');
  await dialog.getByLabel('World height format').selectOption('raw32');
  await dialog.getByLabel('Mask: Elevation band', { exact: true }).check();
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download world package', exact: true }).click();
  const download = await pending;
  const path = await download.path();
  expect(path).toBeTruthy();
  const files = unzipSync(new Uint8Array(await readFile(path!)));
  const manifestPath = Object.keys(files).find((name) => name.endsWith('manifest.json'))!;
  const manifest = JSON.parse(strFromU8(files[manifestPath]));
  expect(manifest.dimensions.samples).toEqual([512, 257]);
  expect(manifest.dimensions.widthMeters).toBe(8000);
  expect(manifest.dimensions.depthMeters).toBe(4000);
  expect(manifest.tiles.length).toBe(2);
  expect(manifest.stages.some((stage: { kind: string }) => stage.kind === 'remap')).toBe(true);
  const rawFiles = manifest.tiles.map(
    (tile: { files: { format: string; map: string; path: string }[] }) =>
      tile.files.find((f) => f.map === 'height')!.path,
  );
  const left = new DataView(
    files[rawFiles[0]].buffer,
    files[rawFiles[0]].byteOffset,
    files[rawFiles[0]].byteLength,
  );
  const right = new DataView(
    files[rawFiles[1]].buffer,
    files[rawFiles[1]].byteOffset,
    files[rawFiles[1]].byteLength,
  );
  const lw = manifest.tiles[0].samples[0],
    rw = manifest.tiles[1].samples[0];
  for (let row = 0; row < 257; row++)
    expect(left.getUint32((row * lw + lw - 1) * 4, true)).toBe(right.getUint32(row * rw * 4, true));
  expect(Object.keys(files).some((name) => name.includes('elevation-band'))).toBe(true);
  await dialog.getByRole('button', { name: 'Close World Studio' }).click();
  const saved = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  const savedFile = await saved;
  const portable = JSON.parse(await readFile((await savedFile.path())!, 'utf8'));
  expect(portable.version).toBe(2);
  expect(portable.world.domain.depth).toBe(4000);
  expect(portable.graph.nodes[0].params.noiseModel).toBe('v3');
  expect(errors).toEqual([]);
});

test('cancelled world work cannot publish and the modal fits a compact viewport', async ({
  page,
}, info) => {
  await page.goto('/');
  await expect(page.getByText('Terrain ready', { exact: true })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'World Studio', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'World Studio', exact: true });
  await dialog.getByRole('button', { name: 'Cancel build', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('cancelled');
  await page.setViewportSize({ width: 760, height: 780 });
  const bounds = await dialog.boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(760);
  expect(bounds!.height).toBeLessThanOrEqual(780);
  expect(bounds!.width).toBeGreaterThan(700);
  const buildBounds = await dialog
    .getByRole('button', { name: 'Build world', exact: true })
    .boundingBox();
  expect(buildBounds!.x + buildBounds!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath('world-compact.png') });
  await dialog.getByRole('button', { name: 'Close World Studio' }).click();
  await expect(dialog).toHaveCount(0);
});
