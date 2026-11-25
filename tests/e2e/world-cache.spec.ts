import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { createProject } from '../../src/model/presets';

test.use({ video: 'off' });

async function openWorld(page: Page): Promise<Locator> {
  await page.goto('/');
  const project = createProject('studio-dunes');
  project.resolution = 64;
  project.name = 'World cache acceptance';
  const source = project.graph.nodes[0],
    output = project.graph.nodes.at(-1)!;
  project.graph = {
    nodes: [source, output],
    edges: [
      {
        id: 'source-output',
        source: source.id,
        target: output.id,
        sourceHandle: 'height',
        targetHandle: 'in',
      },
    ],
  };
  await page.getByLabel('Import terrain project file').setInputFiles({
    name: 'world-cache.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(page.getByText('Terrain ready', { exact: true })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'World Studio', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'World Studio', exact: true });
  await expect(dialog.getByText('World overview ready', { exact: true })).toBeVisible({
    timeout: 90_000,
  });
  await dialog.getByRole('tab', { name: 'Compute', exact: true }).click();
  return dialog;
}

async function build(dialog: Locator): Promise<void> {
  await dialog.getByRole('button', { name: 'Build world', exact: true }).click();
  await expect(dialog.getByText('World overview ready', { exact: true })).toBeVisible({
    timeout: 90_000,
  });
}

test('CPU region caching is opt-in, survives worker close/reopen, and clears independently of projects', async ({
  page,
}) => {
  test.setTimeout(180_000);
  let dialog = await openWorld(page);
  await expect(dialog.getByLabel('Remember completed CPU regions')).not.toBeChecked();
  const databases = await page.evaluate(async () =>
    (await indexedDB.databases()).map((value) => value.name),
  );
  expect(databases).not.toContain('normal-height.world-cache');
  await dialog.getByLabel('World compute backend').selectOption('cpu-reference');
  await dialog.getByLabel('Remember completed CPU regions').check();
  await build(dialog);
  await expect(dialog.getByText(/On-device cache · 1 regions/)).toBeVisible();
  await expect(dialog.getByText('Loaded from cache', { exact: true })).toHaveCount(0);
  await build(dialog);
  await expect(dialog.getByText('Loaded from cache', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close World Studio' }).click();

  // A fresh worker has no JS memory from the prior modal; this hit proves the
  // completed region was committed to IndexedDB and independently validated.
  await page.getByRole('button', { name: 'World Studio', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'World Studio', exact: true });
  await expect(dialog.getByText('World overview ready', { exact: true })).toBeVisible();
  await dialog.getByRole('tab', { name: 'Compute', exact: true }).click();
  await expect(dialog.getByLabel('Remember completed CPU regions')).not.toBeChecked();
  await dialog.getByLabel('World compute backend').selectOption('cpu-reference');
  await dialog.getByLabel('Remember completed CPU regions').check();
  await build(dialog);
  await expect(dialog.getByText('Loaded from cache', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Clear stored world regions', exact: true }).click();
  await expect(
    dialog.getByText('Stored world regions cleared. Authored projects are preserved.'),
  ).toBeVisible();
  await build(dialog);
  await expect(dialog.getByText('Loaded from cache', { exact: true })).toHaveCount(0);
  await expect(dialog.getByText('World cache acceptance', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/On-device cache · 1 regions/)).toBeVisible();
});

test('corrupt disk regions regenerate and backend selection cannot return an ambiguously labeled cache hit', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const dialog = await openWorld(page);
  await dialog.getByLabel('World compute backend').selectOption('cpu-reference');
  await dialog.getByLabel('Remember completed CPU regions').check();
  await build(dialog);
  const recordsBefore = await page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open('normal-height.world-cache', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction('regions', 'readwrite');
          let count = 0;
          const entries = transaction.objectStore('regions').getAll();
          entries.onsuccess = () => {
            count = entries.result.length;
            for (const entry of entries.result)
              transaction.objectStore('regions').put({ ...entry, checksum: 'corrupt' }, entry.key);
          };
          transaction.oncomplete = () => {
            db.close();
            resolve(count);
          };
          transaction.onabort = () => {
            db.close();
            reject(transaction.error);
          };
        };
      }),
  );
  expect(recordsBefore).toBe(1);
  await build(dialog);
  await expect(dialog.getByText('Loaded from cache', { exact: true })).toHaveCount(0);
  await build(dialog);
  await expect(dialog.getByText('Loaded from cache', { exact: true })).toBeVisible();
  await dialog.getByLabel('World compute backend').selectOption('auto');
  await build(dialog);
  await expect(dialog.getByText('Loaded from cache', { exact: true })).toHaveCount(0);
  await dialog.getByLabel('World compute backend').selectOption('cpu-reference');
  await build(dialog);
  await expect(dialog.getByText('Loaded from cache', { exact: true })).toBeVisible();
});
