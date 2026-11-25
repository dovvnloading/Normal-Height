import { expect, test } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { createNode } from '../../src/model/registry';
import type { TerrainProject } from '../../src/model/types';

function centerPixel(canvas: Locator) {
  return canvas.evaluate((element: HTMLCanvasElement) => {
    const { width, height } = element;
    return Array.from(element.getContext('2d')!.getImageData(width >> 1, height >> 1, 1, 1).data);
  });
}

test('previews a quarter mask in absolute grayscale and restores terrain units', async ({
  page,
}) => {
  await page.goto('/');
  const source = createNode('noise', { x: 0, y: 110 }, 'constant');
  source.params.amplitude = 0;
  source.params.offset = 0.25;
  const mask = createNode('maskOutput', { x: 270, y: 0 }, 'coverage');
  mask.label = 'Quarter coverage';
  const output = createNode('output', { x: 270, y: 220 }, 'terrain');
  const project: TerrainProject = {
    version: 1,
    name: 'Quarter mask',
    presetId: 'custom',
    seed: 0,
    resolution: 64,
    worldSize: 1000,
    heightScale: 200,
    graph: {
      nodes: [source, mask, output],
      edges: [mask, output].map((node) => ({
        id: node.id + '-input',
        source: source.id,
        sourceHandle: 'height',
        target: node.id,
        targetHandle: 'in',
      })),
    },
  };
  await page.getByLabel('Import terrain project file', { exact: true }).setInputFiles({
    name: 'quarter.nhterrain.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await page.getByTitle('Fit graph (Home)').click();
  await page.getByRole('button', { name: 'Preview Quarter coverage', exact: true }).click();
  await expect(page.getByRole('button', { name: '2D map', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const legend = page.locator('.nh-map-legend');
  await expect(legend).toContainText('Mask weight');
  await expect(legend.getByText('0%', { exact: true })).toBeVisible();
  await expect(legend.getByText('100%', { exact: true })).toBeVisible();
  const map = page.getByRole('img', { name: /^Mask weight map/ });
  const thumb = page.getByLabel('Quarter coverage mask preview', { exact: true });
  for (const canvas of [map, thumb]) {
    await expect.poll(() => centerPixel(canvas)).toEqual([64, 64, 64, 255]);
  }
  await map.hover();
  await expect(page.locator('.nh-map-sample')).toContainText('25.0% weight');

  // A named output is a scalar mask, not terrain material coverage. Both the
  // visible action and its keyboard shortcut must leave that preview intact.
  const paint = page.getByRole('button', { name: 'Paint terrain', exact: true });
  await expect(paint).toBeDisabled();
  await expect(paint).toHaveAttribute('title', 'Return to Terrain output to resume painting.');
  await map.focus();
  await page.keyboard.press('b');
  await expect(paint).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByLabel('Map channel', { exact: true })).toHaveValue('height');
  await expect(map).toBeVisible();
  await expect(page.getByRole('region', { name: 'Painting studio', exact: true })).toHaveCount(0);
  await expect.poll(() => centerPixel(map)).toEqual([64, 64, 64, 255]);

  await page.getByRole('button', { name: 'Return to Terrain output', exact: true }).click();
  await expect(legend).toContainText('Elevation');
  await expect(legend.getByText('200 m', { exact: true })).toBeVisible();
  await expect(paint).toBeEnabled();
  await page.locator('.nh-map > canvas').focus();
  await page.keyboard.press('b');
  await expect(paint).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'Painting studio', exact: true })).toBeVisible();
});
