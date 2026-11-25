import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { createNode } from '../../src/model/registry';
import { STUDIO_DEFAULTS } from '../../src/model/noiseStudio';
import { createWorldDefinition } from '../../src/model/world';
import type { TerrainProject } from '../../src/model/types';
import type { WorldExportManifest } from '../../src/export/worldExport';

// Only the picker/writable boundary is controlled. Terrain generation, ZIP
// encoding, production workers, chunk delivery and acknowledgments remain real.
// This is browser lifecycle coverage, not native OS picker qualification.
test.use({ video: 'off' });

interface FileSinkProbe {
  pickerCalls: number;
  openCalls: number;
  writeCalls: number;
  closeCalls: number;
  abortCalls: number;
  activeWrites: number;
  maxActiveWrites: number;
  acknowledgments: number;
  acknowledgmentsWhileWriting: number;
  holdOpen: boolean;
  holdFirstWrite: boolean;
  choose(): void;
  open(): void;
  releaseWrite(): void;
  rejectPicker(): void;
  archive(): Promise<string>;
}
type ProbeWindow = typeof window & { __worldFileSink: FileSinkProbe };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const parts: ArrayBuffer[] = [];
    let choose: (() => void) | undefined;
    let open: (() => void) | undefined;
    let releaseWrite: (() => void) | undefined;
    let rejectPicker: (() => void) | undefined;
    const probe: FileSinkProbe = {
      pickerCalls: 0,
      openCalls: 0,
      writeCalls: 0,
      closeCalls: 0,
      abortCalls: 0,
      activeWrites: 0,
      maxActiveWrites: 0,
      acknowledgments: 0,
      acknowledgmentsWhileWriting: 0,
      holdOpen: false,
      holdFirstWrite: false,
      choose: () => choose?.(),
      open: () => open?.(),
      releaseWrite: () => releaseWrite?.(),
      rejectPicker: () => rejectPicker?.(),
      archive: () =>
        new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(new Blob(parts, { type: 'application/zip' }));
        }),
    };
    (window as ProbeWindow).__worldFileSink = probe;
    const writer = {
      async write(bytes: ArrayBuffer) {
        probe.writeCalls++;
        probe.activeWrites++;
        probe.maxActiveWrites = Math.max(probe.maxActiveWrites, probe.activeWrites);
        parts.push(bytes.slice(0));
        if (probe.holdFirstWrite && probe.writeCalls === 1)
          await new Promise<void>((resolve) => {
            releaseWrite = resolve;
          });
        probe.activeWrites--;
      },
      async close() {
        probe.closeCalls++;
      },
      async abort() {
        probe.abortCalls++;
        releaseWrite?.();
      },
    };
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: () => {
        probe.pickerCalls++;
        return new Promise((resolve, reject) => {
          choose = () =>
            resolve({
              async createWritable() {
                probe.openCalls++;
                if (probe.holdOpen)
                  await new Promise<void>((ready) => {
                    open = ready;
                  });
                return writer;
              },
            });
          rejectPicker = () => reject(new DOMException('Picker cancelled', 'AbortError'));
        });
      },
    });
    const postMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (
      message: unknown,
      transfer?: Transferable[] | StructuredSerializeOptions,
    ) {
      if (message && typeof message === 'object' && 'type' in message && message.type === 'ack') {
        probe.acknowledgments++;
        if (probe.activeWrites) probe.acknowledgmentsWhileWriting++;
      }
      return Reflect.apply(
        postMessage,
        this,
        transfer === undefined ? [message] : [message, transfer],
      );
    };
  });
});

async function openExport(page: Page, duplicateMasks = false) {
  const source = createNode('noise', { x: 0, y: 0 }, 'file-source');
  source.params = {
    ...STUDIO_DEFAULTS,
    noiseModel: 'v3',
    kernel: 'perlin',
    fractal: 'none',
    warpType: 'none',
    sampling: 'point',
    scale: 5,
  };
  const output = createNode('output', { x: 260, y: 0 }, 'file-output');
  const project: TerrainProject = {
    version: 2,
    name: 'World file lifecycle',
    seed: 63,
    resolution: 64,
    worldSize: 2048,
    heightScale: 400,
    presetId: 'custom',
    graph: {
      nodes: [source, output],
      edges: [
        {
          id: 'height',
          source: source.id,
          target: output.id,
          sourceHandle: 'height',
          targetHandle: 'in',
        },
      ],
    },
  };
  if (duplicateMasks) {
    for (const id of ['mask-one', 'mask-two']) {
      const mask = createNode('mask', { x: 260, y: 200 }, id);
      mask.label = 'Coverage';
      project.graph.nodes.push(mask);
      project.graph.edges.push({
        id,
        source: source.id,
        target: id,
        sourceHandle: 'height',
        targetHandle: 'in',
      });
    }
  }
  project.world = createWorldDefinition(project);
  project.world.domain.cellsX = project.world.domain.cellsZ = 128;
  project.world.globalResolution = 64;
  await page.goto('/');
  await page.getByLabel('Import terrain project file').setInputFiles({
    name: 'world-file-lifecycle.nhterrain.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(page.getByRole('button', { name: project.name, exact: true })).toBeVisible();
  await expect(page.getByText('Terrain ready', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '2D map', exact: true }).click();
  await page.getByRole('button', { name: 'World Studio', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'World Studio', exact: true });
  await expect(dialog.getByText('World overview ready', { exact: true })).toBeVisible();
  await dialog.getByRole('tab', { name: 'Export', exact: true }).click();
  await dialog.getByLabel('World export samples').selectOption('512');
  await dialog.getByLabel('World height format').selectOption('raw32');
  await dialog.getByLabel('Flow, wear & deposition', { exact: true }).uncheck();
  await dialog.getByLabel('Terrain normal map', { exact: true }).uncheck();
  return dialog;
}

test('invalid file exports are rejected before the picker and a corrected request can start', async ({
  page,
}) => {
  const dialog = await openExport(page, true);
  const masks = dialog.getByLabel('Mask: Coverage', { exact: true });
  await masks.nth(0).check();
  await masks.nth(1).check();
  const save = dialog.getByRole('button', { name: 'Save directly to file', exact: true });
  await save.click();
  await expect(dialog.getByRole('status')).toContainText('Mask filenames must have unique');
  expect(
    await page.evaluate(() => {
      const p = (window as ProbeWindow).__worldFileSink;
      return [p.pickerCalls, p.openCalls, p.writeCalls];
    }),
  ).toEqual([0, 0, 0]);
  await masks.nth(1).uncheck();
  await save.click();
  await expect(dialog.getByRole('button', { name: 'Cancel export', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as ProbeWindow).__worldFileSink.pickerCalls)).toBe(1);
  await page.evaluate(() => (window as ProbeWindow).__worldFileSink.rejectPicker());
  await expect(dialog.getByRole('status')).toHaveText('Export cancelled');
  await expect(save).toBeEnabled();
});

test('file preparation is reserved once and cancellation aborts a late writable stream', async ({
  page,
}) => {
  const dialog = await openExport(page);
  await page.evaluate(() => {
    (window as ProbeWindow).__worldFileSink.holdOpen = true;
  });
  const save = dialog.getByRole('button', { name: 'Save directly to file', exact: true });
  // Same event-loop turn: exercise the synchronous request guard before React's
  // disabled state can be relied upon for a later click.
  await save.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect(save).toBeDisabled();
  expect(await page.evaluate(() => (window as ProbeWindow).__worldFileSink.pickerCalls)).toBe(1);
  await page.evaluate(() => (window as ProbeWindow).__worldFileSink.choose());
  await expect
    .poll(() => page.evaluate(() => (window as ProbeWindow).__worldFileSink.openCalls))
    .toBe(1);
  await expect(save).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel export', exact: true }).click();
  await page.evaluate(() => (window as ProbeWindow).__worldFileSink.open());
  await expect
    .poll(() => page.evaluate(() => (window as ProbeWindow).__worldFileSink.abortCalls))
    .toBe(1);
  expect(
    await page.evaluate(() => {
      const p = (window as ProbeWindow).__worldFileSink;
      return [p.pickerCalls, p.openCalls, p.writeCalls, p.closeCalls];
    }),
  ).toEqual([1, 1, 0, 0]);
  await expect(dialog.getByRole('status')).toHaveText('Export cancelled');
  await expect(save).toBeEnabled();
});

test('cancelling or closing before the picker resolves never opens a writable stream', async ({
  page,
}) => {
  const dialog = await openExport(page);
  const save = dialog.getByRole('button', { name: 'Save directly to file', exact: true });
  await save.click();
  await dialog.getByRole('button', { name: 'Cancel export', exact: true }).click();
  await page.evaluate(async () => {
    (window as ProbeWindow).__worldFileSink.choose();
    await Promise.resolve();
  });
  expect(await page.evaluate(() => (window as ProbeWindow).__worldFileSink.openCalls)).toBe(0);
  await expect(save).toBeEnabled();
  await save.click();
  await dialog.getByRole('button', { name: 'Close World Studio', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.evaluate(async () => {
    (window as ProbeWindow).__worldFileSink.choose();
    await Promise.resolve();
  });
  expect(
    await page.evaluate(() => {
      const p = (window as ProbeWindow).__worldFileSink;
      return [p.pickerCalls, p.openCalls, p.writeCalls, p.closeCalls];
    }),
  ).toEqual([2, 0, 0, 0]);
});

test('the production export worker waits for file writes and closes a valid RAW archive', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const dialog = await openExport(page);
  await page.evaluate(() => {
    (window as ProbeWindow).__worldFileSink.holdFirstWrite = true;
  });
  await dialog.getByRole('button', { name: 'Save directly to file', exact: true }).click();
  await page.evaluate(() => (window as ProbeWindow).__worldFileSink.choose());
  await expect
    .poll(() => page.evaluate(() => (window as ProbeWindow).__worldFileSink.writeCalls))
    .toBe(1);
  expect(
    await page.evaluate(() => {
      const p = (window as ProbeWindow).__worldFileSink;
      return [p.activeWrites, p.acknowledgments, p.closeCalls];
    }),
  ).toEqual([1, 0, 0]);
  await page.evaluate(() => (window as ProbeWindow).__worldFileSink.releaseWrite());
  await expect(dialog.getByRole('status')).toContainText(
    'world-file-lifecycle-world-512x512-generic.zip',
  );
  const observed = await page.evaluate(async () => {
    const p = (window as ProbeWindow).__worldFileSink;
    return {
      base64: await p.archive(),
      writeCalls: p.writeCalls,
      closeCalls: p.closeCalls,
      abortCalls: p.abortCalls,
      maxActiveWrites: p.maxActiveWrites,
      acknowledgments: p.acknowledgments,
      acknowledgmentsWhileWriting: p.acknowledgmentsWhileWriting,
    };
  });
  expect(observed.closeCalls).toBe(1);
  expect(observed.abortCalls).toBe(0);
  expect(observed.maxActiveWrites).toBe(1);
  expect(observed.acknowledgments).toBe(observed.writeCalls);
  expect(observed.acknowledgmentsWhileWriting).toBe(0);
  const files = unzipSync(Buffer.from(observed.base64, 'base64'));
  const manifest = JSON.parse(strFromU8(files['manifest.json'])) as WorldExportManifest;
  expect(manifest.dimensions.samples).toEqual([512, 512]);
  expect(manifest.encoding.heightFormat).toBe('raw32');
  expect(manifest.memory.retainedArchiveBytes).toBe(0);
  expect(manifest.tiles).toHaveLength(4);
  for (const tile of manifest.tiles) {
    expect(tile.files).toHaveLength(1);
    const entry = tile.files[0];
    const bytes = files[entry.path];
    expect(entry.map).toBe('height');
    expect(bytes.length).toBe(tile.samples[0] * tile.samples[1] * 4);
    expect(bytes.length).toBe(entry.bytes);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    expect(((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')).toBe(entry.crc32);
    const raw = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    for (let offset = 0; offset < bytes.length; offset += 4)
      if (!Number.isFinite(raw.getFloat32(offset, true))) throw new Error('Non-finite RAW sample');
  }
  expect(JSON.parse(strFromU8(files['project.nhterrain.json'])).seed).toBe(63);
  await expect(
    dialog.getByRole('button', { name: 'Save directly to file', exact: true }),
  ).toBeEnabled();
  expect(errors).toEqual([]);
});
