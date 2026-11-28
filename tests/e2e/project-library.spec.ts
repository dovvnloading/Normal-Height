import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createProject } from '../../src/model/presets';
import { parseProject } from '../../src/model/project';
import { STUDIO_DEFAULTS } from '../../src/model/noiseStudio';

test.use({ video: 'off' });
const databaseName = 'normal-height.project-library.v1';

async function openFastProject(page: Page, name = 'Library canyon') {
  await page.goto('/');
  const project = createProject('studio-dunes');
  project.name = name;
  project.resolution = 64;
  const source = project.graph.nodes[0],
    output = project.graph.nodes.at(-1)!;
  source.params = {
    ...STUDIO_DEFAULTS,
    noiseModel: 'v3',
    kernel: 'perlin',
    fractal: 'none',
    warpType: 'none',
    sampling: 'point',
  };
  project.graph = {
    nodes: [source, output],
    edges: [
      {
        id: 'library-source-output',
        source: source.id,
        target: output.id,
        sourceHandle: 'height',
        targetHandle: 'in',
      },
    ],
  };
  await page.getByLabel('Import terrain project file').setInputFiles({
    name: 'library-test.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(page.locator('.project-name')).toHaveText(name);
  await page.getByRole('button', { name: '2D map', exact: true }).click();
  return project;
}

async function library(page: Page) {
  await page.getByRole('button', { name: 'Projects and revisions', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Projects & revisions', exact: true });
  await expect(dialog.getByRole('button', { name: 'Save checkpoint', exact: true })).toBeEnabled();
  return dialog;
}

async function rename(page: Page, name: string) {
  await page.locator('.project-name').click();
  const dialog = page.getByRole('dialog', { name: 'Begin with a landscape', exact: true });
  await dialog.getByRole('textbox', { name: 'Project name', exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'Close Begin with a landscape', exact: true }).click();
}

async function storedIndex(page: Page) {
  return page.evaluate(
    async (name) =>
      new Promise<{
        projects: { id: string; name: string; headRevisionId: string }[];
        revisions: { id: string; projectId: string; contentHash: string; label: string }[];
        snapshotCount: number;
      }>((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(['projects', 'revisions', 'snapshots'], 'readonly');
          const projects = tx.objectStore('projects').getAll();
          const revisions = tx.objectStore('revisions').getAll();
          const count = tx.objectStore('snapshots').count();
          tx.oncomplete = () => {
            db.close();
            resolve({
              projects: projects.result,
              revisions: revisions.result,
              snapshotCount: count.result,
            });
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
    databaseName,
  );
}

test('checkpoints round-trip, restore safely, survive reload and preserve document identity through undo', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const fixture = await openFastProject(page);
  let dialog = await library(page);
  await dialog.getByLabel('Checkpoint note').fill('Initial shape');
  await dialog.getByRole('button', { name: 'Save checkpoint', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Checkpoint saved');
  await dialog.getByRole('button', { name: 'Close Projects & revisions' }).click();
  await rename(page, 'Library canyon revised');
  dialog = await library(page);
  await dialog.getByLabel('Checkpoint note').fill('Ridge pass');
  await dialog.getByRole('button', { name: 'Save checkpoint', exact: true }).click();
  await expect(dialog.getByRole('radio')).toHaveCount(2);
  await dialog.getByRole('radio', { name: /Initial shape/ }).check();
  await dialog.getByRole('button', { name: 'Open selected revision', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.project-name')).toHaveText(fixture.name);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.project-name')).toHaveText('Library canyon revised');
  dialog = await library(page);
  await dialog.getByRole('button', { name: 'Save checkpoint', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('already matches its latest checkpoint');
  await expect(dialog.getByRole('radio')).toHaveCount(2);
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download revision', exact: true }).click();
  const download = await downloadPromise;
  const file = testInfo.outputPath('verified-library-revision.nhterrain.json');
  await download.saveAs(file);
  const restored = JSON.parse(await readFile(file, 'utf8'));
  expect(restored.name).toBe('Library canyon revised');
  expect(restored.seed).toBe(fixture.seed);
  expect(restored.graph).toEqual(parseProject(fixture).graph);
  expect((await storedIndex(page)).projects).toHaveLength(1);
  await page.reload();
  dialog = await library(page);
  await expect(dialog.getByRole('radio')).toHaveCount(2);
  await expect(dialog.getByRole('region', { name: 'Saved projects' })).toContainText(
    'Library canyon revised',
  );
  await page.keyboard.press('Shift+Tab');
  expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Projects and revisions', exact: true }),
  ).toBeFocused();
  dialog = await library(page);
  await testInfo.attach('project-library-desktop.png', {
    body: await dialog.screenshot(),
    contentType: 'image/png',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const box = await dialog.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(390);
  expect(await dialog.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(false);
  await testInfo.attach('project-library-mobile.png', {
    body: await dialog.screenshot(),
    contentType: 'image/png',
  });
  expect(errors).toEqual([]);
});

test('failed checkpoint transactions roll back every store, recover on retry, and reject corrupt revisions', async ({
  page,
}) => {
  await openFastProject(page);
  let dialog = await library(page);
  await dialog.getByLabel('Checkpoint note').fill('Safe original');
  await dialog.getByRole('button', { name: 'Save checkpoint', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Checkpoint saved');
  const before = await storedIndex(page);
  await dialog.getByRole('button', { name: 'Close Projects & revisions' }).click();
  await rename(page, 'Unsaved local edits');
  dialog = await library(page);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'revisions') {
        IDBObjectStore.prototype.put = original;
        throw new DOMException('Injected quota failure after snapshot write', 'QuotaExceededError');
      }
      return original.apply(this, args);
    };
  });
  await dialog.getByRole('button', { name: 'Save checkpoint', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Browser storage is full');
  expect(await storedIndex(page)).toEqual(before);
  await expect(page.locator('.project-name')).toHaveText('Unsaved local edits');
  await dialog.getByLabel('Checkpoint note').fill('Recovered save');
  await dialog.getByRole('button', { name: 'Save checkpoint', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Checkpoint saved');
  const recovered = await storedIndex(page);
  expect(recovered.revisions).toHaveLength(2);
  expect(recovered.snapshotCount).toBe(2);
  const latest = recovered.revisions.find(
    (revision) => revision.id === recovered.projects[0].headRevisionId,
  )!;
  await page.evaluate(
    async ({ name, hash }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('snapshots', 'readwrite');
          const store = tx.objectStore('snapshots');
          const read = store.get(hash);
          read.onsuccess = () =>
            store.put({ ...read.result, json: read.result.json.replace('Unsaved', 'Damaged') });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
    { name: databaseName, hash: latest.contentHash },
  );
  await dialog.getByRole('button', { name: 'Open selected revision', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('failed its integrity check');
  await expect(page.locator('.project-name')).toHaveText('Unsaved local edits');
  expect(await storedIndex(page)).toEqual(recovered);
  await dialog.getByRole('radio', { name: /Safe original/ }).check();
  await dialog.getByRole('button', { name: 'Open selected revision', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.project-name')).toHaveText('Library canyon');
});

test('two tabs cannot overwrite each other and a conflicted document can be saved as a new project', async ({
  page,
  context,
}) => {
  test.setTimeout(150_000);
  await openFastProject(page, 'Shared landscape');
  let first = await library(page);
  await first.getByRole('button', { name: 'Save checkpoint', exact: true }).click();
  await expect(first.getByRole('status')).toContainText('Checkpoint saved');
  await first.getByRole('button', { name: 'Close Projects & revisions' }).click();

  const other = await context.newPage();
  await openFastProject(other, 'Other working document');
  let second = await library(other);
  await second.getByRole('button', { name: 'Open selected revision', exact: true }).click();
  await expect(second).toHaveCount(0);
  await expect(other.locator('.project-name')).toHaveText('Shared landscape');

  await rename(page, 'First tab terrain');
  first = await library(page);
  await first.getByRole('button', { name: 'Save checkpoint', exact: true }).click();
  await expect(first.getByRole('status')).toContainText('Checkpoint saved');
  await rename(other, 'Second tab terrain');
  second = await library(other);
  await second.getByRole('button', { name: 'Save checkpoint', exact: true }).click();
  await expect(second.getByRole('alert')).toContainText('changed in another tab');
  await expect(other.locator('.project-name')).toHaveText('Second tab terrain');
  const conflicted = await storedIndex(page);
  expect(conflicted.projects.some((entry) => entry.name === 'First tab terrain')).toBe(true);
  expect(conflicted.projects.some((entry) => entry.name === 'Second tab terrain')).toBe(false);
  await second.getByRole('button', { name: 'Save as new project', exact: true }).click();
  await expect(second.getByRole('status')).toContainText('Checkpoint saved');
  const resolved = await storedIndex(page);
  expect(resolved.projects.some((entry) => entry.name === 'First tab terrain')).toBe(true);
  expect(resolved.projects.some((entry) => entry.name === 'Second tab terrain')).toBe(true);
  await other.close();
});
