import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { createProject } from '../../src/model/presets';

test.use({ video: 'off' });

function cacheFixture(): Buffer {
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
  return Buffer.from(JSON.stringify(project));
}

async function openWorld(page: Page, fixture: Buffer, reload = false): Promise<Locator> {
  if (reload) await page.reload();
  else await page.goto('/');
  await page.getByLabel('Import terrain project file').setInputFiles({
    name: 'world-cache.json',
    mimeType: 'application/json',
    buffer: fixture,
  });
  await expect(
    page.getByRole('contentinfo').getByText('Terrain ready', { exact: true }),
  ).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'World Studio', exact: true }).click();
  const workspace = page.getByRole('region', { name: 'World Studio', exact: true });
  // Keep explicit builds observable; camera settling must not replace their
  // cache result with an unrelated in-memory regional preview. Disable camera
  // refinement while the first overview is still preparing, then switch edits
  // to manual only after that initial result has arrived.
  await workspace.getByRole('tab', { name: 'Explore', exact: true }).click();
  await workspace.getByText('Preview behaviour', { exact: true }).click();
  await workspace.getByLabel('Automatic regional refinement').uncheck();
  await expect(workspace.getByText('World overview ready', { exact: true })).toBeVisible({
    timeout: 90_000,
  });
  await workspace.getByLabel('Automatic world previews').uncheck();
  await workspace.getByRole('tab', { name: 'Simulate', exact: true }).click();
  await workspace.getByText('Compute & local cache', { exact: true }).click();
  return workspace;
}

async function build(workspace: Locator): Promise<void> {
  await workspace.getByRole('button', { name: 'Build world', exact: true }).click();
  await expect(workspace.getByText('World overview ready', { exact: true })).toBeVisible({
    timeout: 90_000,
  });
  await expect(workspace.getByRole('button', { name: 'Build world', exact: true })).toBeEnabled();
}

async function storedRegions(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ key: string; checksum: string; backend: string }[]>((resolve, reject) => {
        const request = indexedDB.open('normal-height.world-cache', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction('regions', 'readonly');
          const entries = transaction.objectStore('regions').getAll();
          transaction.oncomplete = () => {
            database.close();
            resolve(
              entries.result.map((entry) => ({
                key: entry.key,
                checksum: entry.checksum,
                backend: entry.result.backend,
              })),
            );
          };
          transaction.onabort = () => {
            database.close();
            reject(transaction.error);
          };
        };
      }),
  );
}

const diskRestoreReason = 'Restored a validated CPU reference region from the local cache.';

test('CPU region caching is opt-in, survives page reload, and clears independently of projects', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const fixture = cacheFixture();
  let workspace = await openWorld(page, fixture);
  await expect(workspace.getByLabel('Remember completed CPU regions')).not.toBeChecked();
  const databases = await page.evaluate(async () =>
    (await indexedDB.databases()).map((value) => value.name),
  );
  expect(databases).not.toContain('normal-height.world-cache');
  await workspace.getByLabel('World compute backend').selectOption('cpu-reference');
  await workspace.getByLabel('Remember completed CPU regions').check();
  await build(workspace);
  await expect(workspace.getByText(/On-device cache · 1 regions/)).toBeVisible();
  await expect(workspace.getByText('Loaded from cache', { exact: true })).toHaveCount(0);
  expect(await storedRegions(page)).toEqual([
    expect.objectContaining({ backend: 'cpu-reference' }),
  ]);
  await build(workspace);
  await expect(workspace.getByText('Loaded from cache', { exact: true })).toBeVisible();
  await workspace.getByRole('button', { name: 'Close World Studio' }).click();
  await expect(page.getByRole('main', { name: 'Terrain workspace', exact: true })).toBeVisible();

  // Workspace switching intentionally retains the worker and memory LRU. A real
  // document reload retires both, so this first preview must validate disk data.
  // Import the exact same fixture and preserve the opted-in cache preference.
  workspace = await openWorld(page, fixture, true);
  await expect(workspace.getByLabel('Remember completed CPU regions')).toBeChecked();
  await expect(workspace.getByText('Loaded from cache', { exact: true })).toBeVisible();
  await expect(workspace.getByText(diskRestoreReason, { exact: true })).toBeVisible();
  await workspace.getByRole('button', { name: 'Clear stored world regions', exact: true }).click();
  await expect(
    workspace.getByText('Stored world regions cleared. Authored projects are preserved.'),
  ).toBeVisible();
  expect(await storedRegions(page)).toHaveLength(0);
  await build(workspace);
  await expect(workspace.getByText('Loaded from cache', { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'World cache acceptance', exact: true }),
  ).toBeVisible();
  await expect(workspace.getByText(/On-device cache · 1 regions/)).toBeVisible();
});

test('corrupt disk regions regenerate and backend selection cannot return an ambiguously labeled cache hit', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const fixture = cacheFixture();
  let workspace = await openWorld(page, fixture);
  await workspace.getByLabel('World compute backend').selectOption('cpu-reference');
  await workspace.getByLabel('Remember completed CPU regions').check();
  await build(workspace);
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

  // A repeat build in this document could legitimately return the immutable
  // memory LRU entry. Reload to force the corrupt IndexedDB record through its
  // checksum validation and observe a regenerated, repaired CPU field.
  workspace = await openWorld(page, fixture, true);
  await expect(workspace.getByLabel('Remember completed CPU regions')).toBeChecked();
  await expect(workspace.getByText('Loaded from cache', { exact: true })).toHaveCount(0);
  await expect(workspace.getByText(diskRestoreReason, { exact: true })).toHaveCount(0);
  const repaired = await storedRegions(page);
  expect(repaired).toHaveLength(1);
  expect(repaired[0].checksum).not.toBe('corrupt');
  expect(repaired[0].backend).toBe('cpu-reference');
  await build(workspace);
  await expect(workspace.getByText('Loaded from cache', { exact: true })).toBeVisible();

  await workspace.getByLabel('World compute backend').selectOption('auto');
  await build(workspace);
  await expect(workspace.getByLabel('World compute backend')).toHaveValue('auto');
  await expect(workspace.getByText('Loaded from cache', { exact: true })).toHaveCount(0);
  await expect(workspace.getByText(diskRestoreReason, { exact: true })).toHaveCount(0);
  // Auto may qualify a GPU or fall back to CPU, but neither path may read or
  // overwrite the explicit CPU-reference disk cache under an ambiguous identity.
  expect(await storedRegions(page)).toEqual(repaired);
  await workspace.getByLabel('World compute backend').selectOption('cpu-reference');
  await build(workspace);
  await expect(workspace.getByLabel('World compute backend')).toHaveValue('cpu-reference');
  await expect(workspace.getByText('Loaded from cache', { exact: true })).toBeVisible();
});
