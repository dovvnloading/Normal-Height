import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createProject } from '../../src/model/presets';
import { STUDIO_DEFAULTS } from '../../src/model/noiseStudio';
import type { WorldDefinition } from '../../src/model/world';
import type { WorldMassBudget, WorldStageReport } from '../../src/engine/world';

test.use({ video: 'off' });

interface TransportBuildReport {
  application: string;
  world: WorldDefinition;
  backend: string;
  stages: WorldStageReport[];
  transportBudget?: WorldMassBudget;
  warnings: string[];
}

// Runs the real production World worker and inspects its downloadable ledger.
// The small imported graph keeps this acceptance gate independent of preset
// erosion cost and the performance of a software-rendered Three.js viewport.
test('World transport is opt-in and reports a finite conservative 64² reference solve', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');

  const project = createProject('studio-dunes');
  project.name = 'World transport acceptance';
  project.resolution = 64;
  project.worldSize = 4000;
  project.heightScale = 1600;
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
        id: 'source-output',
        source: source.id,
        target: output.id,
        sourceHandle: 'height',
        targetHandle: 'in',
      },
    ],
  };
  await page.getByLabel('Import terrain project file').setInputFiles({
    name: 'world-transport.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(page.getByText(project.name, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Build terrain', exact: true }).click();
  await expect(page.getByText('Terrain ready', { exact: true })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'World Studio', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'World Studio', exact: true });
  await expect(dialog.getByText('World overview ready', { exact: true })).toBeVisible({
    timeout: 90_000,
  });

  await dialog.getByRole('tab', { name: 'Compute', exact: true }).click();
  const enabled = dialog.getByLabel('Enable conservative transport', { exact: true });
  await expect(enabled).not.toBeChecked();
  await expect(dialog.getByText('Water balance residual', { exact: true })).toHaveCount(0);
  await dialog.getByLabel('World compute backend').selectOption('cpu-reference');
  await dialog.getByLabel('Global reference resolution').selectOption('64');
  await enabled.check();
  await dialog.getByLabel('Transport iterations', { exact: true }).fill('8');
  await expect(
    dialog.getByText(
      /Experimental water, sediment and thermal transport over the complete reference grid/,
    ),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Build world', exact: true }).click();
  await expect(dialog.getByText('World overview ready', { exact: true })).toBeVisible({
    timeout: 90_000,
  });
  await expect(dialog.getByText('Water balance residual', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Solid balance residual', { exact: true })).toBeVisible();
  await expect(
    dialog.getByText(/Budgets measure the reference simulation before fine-grid reconstruction/),
  ).toBeVisible();

  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download build report', exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('world-build-report.json');
  const path = await download.path();
  expect(path).toBeTruthy();
  const raw = await readFile(path!, 'utf8');
  const report = JSON.parse(raw) as TransportBuildReport;
  await info.attach('world-transport-build-report', { body: raw, contentType: 'application/json' });

  expect(report.application).toBe('Normal Height World Engine');
  expect(report.backend).toBe('cpu-reference');
  expect(report.world.backend).toBe('cpu-reference');
  expect(report.world.globalResolution).toBe(64);
  expect(report.world.domain.boundary).toBe('closed');
  expect(report.world.transport).toMatchObject({ enabled: true, iterations: 8 });
  const budget = report.transportBudget;
  expect(budget).toBeDefined();
  if (!budget)
    throw new Error('The completed transport build did not export its conservation ledger.');
  for (const [name, value] of Object.entries(budget)) {
    expect(typeof value, `${name} must be a numeric measurement`).toBe('number');
    expect(Number.isFinite(value), `${name} must be finite`).toBe(true);
  }
  expect(budget.iterations).toBe(8);
  expect(budget.areaM2).toBe(4000 * 4000);
  expect(budget.rainfallVolumeM3).toBeGreaterThan(0);
  expect(budget.rainfallVolumeM3).toBeCloseTo(
    budget.areaM2 * report.world.transport!.rainfall * 8,
    4,
  );
  expect(budget.exportedWaterVolumeM3).toBe(0);
  expect(budget.exportedSedimentVolumeM3).toBe(0);
  expect(budget.finalWaterVolumeM3).toBeGreaterThan(0);
  expect(budget.erodedVolumeM3).toBeGreaterThan(0);
  expect(budget.suspendedSedimentVolumeM3).toBeGreaterThanOrEqual(0);
  expect(Math.abs(budget.waterResidualM3)).toBeLessThan(
    Math.max(1e-6, budget.rainfallVolumeM3 * 1e-9),
  );
  expect(Math.abs(budget.solidResidualM3)).toBeLessThan(
    Math.max(1e-4, budget.erodedVolumeM3 * 1e-9),
  );

  const transport = report.stages.find((stage) => stage.nodeId === 'world-transport');
  expect(transport).toMatchObject({
    kind: 'world-transport',
    scope: 'iterative',
    mode: 'reconstructed',
    backend: 'cpu-reference',
    samplesX: 64,
    samplesZ: 64,
    simulationResolution: 64,
  });
  expect(transport!.spacingX).toBeCloseTo(4000 / 63, 10);
  expect(transport!.spacingZ).toBeCloseTo(4000 / 63, 10);
  expect(transport!.reason).toMatch(/Experimental whole-domain finite-volume/);
  expect(report.warnings.join('\n')).toMatch(/not a calibrated geophysical simulation/);
  await dialog.getByLabel('World map channel').selectOption('flow');
  await page.screenshot({ path: info.outputPath('world-transport-64.png') });
  expect(errors).toEqual([]);
});
