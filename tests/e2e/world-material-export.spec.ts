import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { createNode } from '../../src/model/registry';
import { STUDIO_DEFAULTS } from '../../src/model/noiseStudio';
import { createWorldDefinition } from '../../src/model/world';
import type { TerrainProject } from '../../src/model/types';
import { parseProject } from '../../src/model/project';
import { WORLD_MATERIAL_MAPS } from '../../src/materials/worldMaterial';
import { verifyWorldArchive } from '../../src/cli/archive';
import type { WorldExportManifest } from '../../src/export/worldExport';

test.use({ video: 'off' });

test('designer exports a painted rectangular world with PBR and named masks through production workers', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const source = createNode('noise', { x: 0, y: 0 }, 'material-source');
  source.params = {
    ...STUDIO_DEFAULTS,
    noiseModel: 'v3',
    kernel: 'perlin',
    fractal: 'fbm',
    octaves: 2,
    warpType: 'none',
    sampling: 'point',
    scale: 5,
  };
  const output = createNode('output', { x: 260, y: 0 }, 'material-output');
  const mask = createNode('maskOutput', { x: 260, y: 200 }, 'material-mask');
  mask.label = 'Coverage delivery';
  const project: TerrainProject = {
    version: 2,
    name: 'World material delivery',
    seed: 63,
    resolution: 64,
    worldSize: 2560,
    heightScale: 400,
    presetId: 'custom',
    materialPaint: [
      {
        layer: 'soil',
        radius: 0.2,
        hardness: 0.7,
        strength: 0.8,
        texture: 'grain',
        points: [
          { u: 0.3, v: 0.4 },
          { u: 0.7, v: 0.6 },
        ],
      },
    ],
    graph: {
      nodes: [source, output, mask],
      edges: [output, mask].map((target) => ({
        id: target.id + '-edge',
        source: source.id,
        target: target.id,
        sourceHandle: 'height',
        targetHandle: 'in',
      })),
    },
  };
  project.world = createWorldDefinition(project);
  project.world.domain.depth = 1792;
  project.world.tileCells = 128;
  project.world.globalResolution = 64;
  await page.goto('/');
  await page.getByLabel('Import terrain project file').setInputFiles({
    name: 'world-material-delivery.nhterrain.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(page.getByRole('button', { name: project.name, exact: true })).toBeVisible();
  await expect(
    page.getByRole('contentinfo').getByText('Terrain ready', { exact: true }),
  ).toBeVisible();
  expect(errors, 'Project import and initial terrain layout').toEqual([]);
  await page.getByRole('button', { name: '2D map', exact: true }).click();
  await page.getByRole('button', { name: 'World Studio', exact: true }).click();
  const studio = page.getByRole('region', { name: 'World Studio', exact: true });
  await expect(studio.getByText('World overview ready', { exact: true })).toBeVisible();
  await studio.getByRole('tab', { name: 'Deliver', exact: true }).click();
  await studio.getByLabel('World export samples').selectOption('256');
  await studio.getByLabel('World height format').selectOption('raw32');
  await studio.getByLabel('Flow, wear & deposition', { exact: true }).uncheck();
  await studio.getByLabel('Terrain normal map', { exact: true }).uncheck();
  await studio.getByLabel('PBR material maps', { exact: true }).check();
  await studio.getByLabel('Mask: Coverage delivery', { exact: true }).check();
  const downloadPromise = page.waitForEvent('download');
  await studio.getByRole('button', { name: 'Download world package', exact: true }).click();
  const download = await downloadPromise;
  const path = testInfo.outputPath('world-material-delivery.zip');
  await download.saveAs(path);
  const verified = await verifyWorldArchive(path);
  expect(verified.dimensions).toEqual([256, 180]);
  expect(verified.verifiedMapFiles).toBe(verified.tiles * 12);
  const files = unzipSync(new Uint8Array(await readFile(path)));
  const manifest = JSON.parse(strFromU8(files['manifest.json'])) as WorldExportManifest;
  expect(manifest.material?.algorithm).toBe('surface-fabric-4');
  expect(manifest.material?.parameters.modelVersion).toBe(4);
  for (const tile of manifest.tiles) {
    expect(tile.files.map((file) => file.map).sort()).toEqual(
      ['height', 'mask:coverage-delivery', ...WORLD_MATERIAL_MAPS].sort(),
    );
    for (const file of tile.files.filter((file) => file.path.endsWith('.png'))) {
      const bytes = files[file.path],
        view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      expect([view.getUint32(16), view.getUint32(20)]).toEqual(tile.samples);
    }
  }
  const saved = parseProject(JSON.parse(strFromU8(files['project.nhterrain.json'])));
  expect(saved.materialPaint).toEqual(project.materialPaint);
  expect(saved.world).toEqual(project.world);
  await expect(studio.getByText('Download initiated', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('world-material-delivery.png') });
  expect(errors).toEqual([]);
});
