import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createProject } from '../../src/model/presets';
import { createNode } from '../../src/model/registry';
import { STUDIO_DEFAULTS } from '../../src/model/noiseStudio';
import { parseGraphSnippet, createGraphSnippet } from '../../src/model/graphClipboard';

test.use({ video: 'off' });

function fixture(grouped: boolean) {
  const project = createProject();
  project.name = grouped ? 'Reusable ridge group' : 'Destination landscape';
  project.resolution = 64;
  const noise = createNode('noise', { x: 20, y: 60 }, grouped ? 'source-noise' : 'target-noise');
  noise.params = {
    ...STUDIO_DEFAULTS,
    noiseModel: 'v3',
    kernel: 'perlin',
    fractal: 'none',
    sampling: 'point',
  };
  const output = createNode(
    'output',
    { x: 600, y: 60 },
    grouped ? 'source-output' : 'target-output',
  );
  if (grouped) {
    const group = createNode('group', { x: 20, y: 20 }, 'bundle');
    group.label = 'Reusable terrain';
    group.width = 500;
    group.height = 440;
    const remap = createNode('remap', { x: 260, y: 60 }, 'source-remap');
    const note = createNode('note', { x: 20, y: 250 }, 'source-note');
    note.params.text = 'Reuse this controlled elevation range.';
    noise.parentId = remap.parentId = note.parentId = group.id;
    project.graph = {
      nodes: [group, noise, remap, note, output],
      edges: [
        { id: 'internal', source: noise.id, target: remap.id },
        { id: 'external', source: remap.id, target: output.id },
      ],
    };
  } else
    project.graph = {
      nodes: [noise, output],
      edges: [{ id: 'target-edge', source: noise.id, target: output.id }],
    };
  return project;
}
const graph = (page: Page) => page.getByRole('region', { name: 'Terrain node graph', exact: true });
async function load(page: Page, grouped: boolean) {
  await page.getByLabel('Import terrain project file').setInputFiles({
    name: 'source.nhterrain.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(fixture(grouped))),
  });
  await expect(page.locator('.project-name')).toHaveText(fixture(grouped).name);
  await page.getByRole('button', { name: '2D map', exact: true }).click();
  await graph(page).getByRole('button', { name: 'Fit', exact: true }).click();
}

test('exports a selected group, imports it across projects, and undoes the complete insertion', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await load(page, true);
  await graph(page).locator('.react-flow__node[data-id="bundle"] .ng-group-title').click();
  const downloadPromise = page.waitForEvent('download');
  await graph(page).getByRole('button', { name: 'Export selected graph', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.nhgraph\.json$/);
  const file = testInfo.outputPath('selected-group.nhgraph.json');
  await download.saveAs(file);
  const text = await readFile(file, 'utf8');
  const snippet = parseGraphSnippet(text);
  expect(snippet.graph.nodes).toHaveLength(4);
  expect(snippet.graph.edges).toHaveLength(1);
  expect(snippet.graph.nodes.some((node) => node.id === 'source-output')).toBe(false);

  await load(page, false);
  await expect(graph(page).locator('.react-flow__node')).toHaveCount(2);
  await graph(page)
    .getByLabel('Import graph snippet file')
    .setInputFiles({
      name: 'selected-group.nhgraph.json',
      mimeType: 'application/json',
      buffer: Buffer.from(text),
    });
  await expect(graph(page).locator('.react-flow__node')).toHaveCount(6);
  await expect(graph(page).locator('.react-flow__node-terrainGroup')).toHaveCount(1);
  await expect(graph(page).locator('.react-flow__edge')).toHaveCount(2);
  await expect(graph(page).locator('.react-flow__node[data-id="bundle"]')).toHaveCount(0);
  await expect(
    graph(page).getByRole('textbox', { name: 'Edit Annotation', exact: true }),
  ).toHaveValue('Reuse this controlled elevation range.');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(graph(page).locator('.react-flow__node')).toHaveCount(2);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(graph(page).locator('.react-flow__node')).toHaveCount(6);
  await page.screenshot({ path: testInfo.outputPath('graph-reuse.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('rejects malformed and over-capacity snippets without replacing the current graph', async ({
  page,
}) => {
  await page.goto('/');
  await load(page, false);
  await graph(page)
    .getByLabel('Import graph snippet file')
    .setInputFiles({
      name: 'invalid.nhgraph.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{"type":"foreign","version":1}'),
    });
  await expect(
    page.getByRole('status').filter({ hasText: 'Unsupported graph snippet' }),
  ).toBeVisible();
  await expect(graph(page).locator('.react-flow__node')).toHaveCount(2);
  const snippet = createGraphSnippet(fixture(true), ['bundle']);
  snippet.graph.nodes = Array.from({ length: 127 }, (_, i) =>
    createNode('note', { x: i, y: 0 }, `note-${i}`),
  );
  snippet.graph.edges = [];
  await graph(page)
    .getByLabel('Import graph snippet file')
    .setInputFiles({
      name: 'too-many.nhgraph.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(snippet)),
    });
  await expect(page.getByRole('status').filter({ hasText: '128-node' })).toBeVisible();
  await expect(graph(page).locator('.react-flow__node')).toHaveCount(2);
  await expect(page.locator('.project-name')).toHaveText('Destination landscape');
});
