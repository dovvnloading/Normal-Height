import { inflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import type { Download, Page } from '@playwright/test';
import type { TerrainProject } from '../../src/model/types';

async function connect(page: Page, source: string, target: string) {
  await page.getByTitle('Fit graph (Home)').click();
  const from = page.getByLabel(source, { exact: true });
  const to = page.getByLabel(target, { exact: true });
  // Node-added notifications can cover the lower destination port. Let
  // Playwright check both endpoints are reachable before starting the wire.
  await to.hover();
  await from.hover();
  // Chromium can scroll React Flow's wrapper during locator.hover(). React
  // Flow then restores its native scroll position, leaving the mouse beside
  // the small port. Read fresh coordinates after that reset before dragging.
  await expect.poll(() => page.getByTestId('rf__wrapper').evaluate((element) =>
    [element.scrollLeft, element.scrollTop])).toEqual([0, 0]);
  const [start, end] = await Promise.all([from.boundingBox(), to.boundingBox()]);
  expect(start).not.toBeNull();
  expect(end).not.toBeNull();
  const sourcePoint = { x: start!.x + start!.width / 2, y: start!.y + start!.height / 2 };
  const targetPoint = { x: end!.x + end!.width / 2, y: end!.y + end!.height / 2 };
  const nodePosition = await from.evaluate((element) =>
    element.closest<HTMLElement>('.react-flow__node')!.style.transform);
  await page.mouse.move(sourcePoint.x, sourcePoint.y);
  expect(await from.evaluate((element, point) =>
    document.elementFromPoint(point.x, point.y) === element, sourcePoint)).toBe(true);
  expect(await to.evaluate((element, point) =>
    document.elementFromPoint(point.x, point.y) === element, targetPoint)).toBe(true);
  await page.mouse.down();
  await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 16 });
  await page.mouse.up();
  // A successful port gesture must not accidentally move its source node.
  await expect.poll(() => from.evaluate((element) =>
    element.closest<HTMLElement>('.react-flow__node')!.style.transform)).toBe(nodePosition);
}

/** Read the bytes handed to the browser's download manager while the Blob URL is live. */
async function downloadBytes(page: Page, download: Download) {
  return Buffer.from(await page.evaluate(async (url) => {
    const response = await fetch(url);
    return Array.from(new Uint8Array(await response.arrayBuffer()));
  }, download.url()));
}

test('imports a survey, shapes a coast and exports a named water mask after session restore', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.locator('.auto-build input').uncheck();
  await page.getByRole('button', { name: '2D map', exact: true }).click();
  // A blank working tile avoids evaluating an unrelated erosion preset. Build
  // the rest through the library, inspector and graph's actual port controls.
  const project: TerrainProject = {
    version: 1, name: 'Coast survey', presetId: 'custom', seed: 17,
    resolution: 128, worldSize: 1000, heightScale: 100,
    graph: {
      nodes: [{ id: 'out', kind: 'output', label: 'Terrain output', params: {}, position: { x: 0, y: 0 } }],
      edges: [],
    },
  };
  const projectInput = page.getByLabel('Import terrain project file', { exact: true });
  await projectInput.setInputFiles({
    name: 'survey.nhterrain.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(page.locator('.toast')).toContainText('Opened Coast survey.');
  const library = page.getByRole('complementary', { name: 'Node library' });
  await library.getByRole('button', { name: /Heightmap import/ }).click();
  // Two rows rising west to east from zero to full unsigned 16-bit elevation.
  const raw = Buffer.from([0, 0, 255, 255, 0, 0, 255, 255]);
  await page.getByLabel('Import heightmap file', { exact: true }).setInputFiles({
    name: 'eastward.r16', mimeType: 'application/octet-stream', buffer: raw,
  });
  await expect(page.getByRole('region', { name: 'Heightmap source file' })).toContainText('eastward.r16');
  await connect(page, 'Heightmap import: Height output', 'Terrain output: Height input');
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await library.getByRole('button', { name: /Coastal shelf/ }).click();
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  const seaLevel = page.getByRole('spinbutton', { name: 'Sea level value', exact: true });
  await seaLevel.fill('0.5');
  await seaLevel.press('Enter');
  await library.getByRole('button', { name: /Mask output/ }).click();
  await page.getByRole('textbox', { name: 'Node name', exact: true }).fill('Ocean coverage');
  await connect(page, 'Coastal shelf: Water mask output', 'Ocean coverage: Mask input');
  await expect(page.locator('.react-flow__edge')).toHaveCount(3);

  const saving = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  const download = await saving;
  const savedBytes = await downloadBytes(page, download);
  const saved: TerrainProject = JSON.parse(savedBytes.toString('utf8'));
  const source = saved.graph.nodes.find((node) => node.kind === 'heightImport')!;
  const coast = saved.graph.nodes.find((node) => node.kind === 'coast')!;
  const mask = saved.graph.nodes.find((node) => node.kind === 'maskOutput')!;
  expect(source.raster?.data).toBe(raw.toString('base64'));
  expect(saved.graph.edges).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: source.id, target: coast.id, sourceHandle: 'height' }),
    expect.objectContaining({ source: coast.id, target: 'out', sourceHandle: 'height' }),
    expect.objectContaining({ source: coast.id, target: mask.id, sourceHandle: 'water' }),
  ]));

  await projectInput.setInputFiles({
    name: download.suggestedFilename(), mimeType: 'application/json', buffer: savedBytes,
  });
  await expect(page.locator('.toast')).toContainText('Opened Coast survey.');
  await expect(page.locator('.save-state')).toHaveText('Saved locally');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '2D map', exact: true }).click({ timeout: 45_000 });
  await page.getByRole('button', { name: 'Restore last session' }).click({ timeout: 45_000 });
  await expect(page.locator('.toast')).toContainText('Restored Coast survey.');
  await expect(page.locator('.status-bar')).toContainText('Terrain ready', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Export maps', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export your landscape' });
  await dialog.getByLabel('Export format').selectOption({ label: 'Ocean coverage' });
  await dialog.getByLabel('Export resolution').selectOption('256');
  await dialog.getByRole('checkbox').uncheck();
  const exporting = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export map', exact: true }).click();
  const exported = await exporting;
  expect(exported.suggestedFilename()).toBe('coast-survey-256-ocean-coverage-mask16.png');
  const png = await downloadBytes(page, exported);
  await testInfo.attach(exported.suggestedFilename(), { body: png, contentType: 'image/png' });
  expect([png.readUInt32BE(16), png.readUInt32BE(20), png[24], png[25]]).toEqual([256, 256, 16, 0]);
  const chunks: Buffer[] = [];
  for (let start = 8; start < png.length;) {
    const end = start + 8 + png.readUInt32BE(start);
    if (png.toString('ascii', start + 4, start + 8) === 'IDAT')
      chunks.push(png.subarray(start + 8, end));
    start = end + 4;
  }
  const rows = inflateSync(Buffer.concat(chunks));
  // The imported linear ramp crosses sea level halfway across the tile.
  // In each row, all 128 western samples are water and all eastern ones are dry.
  const row = Buffer.alloc(513);
  row.fill(255, 1, 257);
  expect(rows.equals(Buffer.concat(Array<Buffer>(256).fill(row)))).toBe(true);
  expect(errors).toEqual([]);
});
