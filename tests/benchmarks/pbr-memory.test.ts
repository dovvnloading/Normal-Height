import { expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { makeExport } from '../../src/export/heightmap';
import { createProject } from '../../src/model/presets';
import { estimatePBRPeakMiB } from '../../src/export/budget';
import type { HeightField } from '../../src/model/types';

const toMiB = (bytes: number) => Math.round(bytes / 1048576 * 10) / 10;

function seededFixture(n: number): HeightField {
  const count = n * n;
  const height = new Float32Array(count);
  const flow = new Float32Array(count);
  const wear = new Float32Array(count);
  const deposition = new Float32Array(count);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = x / (n - 1), v = y / (n - 1);
    const i = y * n + x;
    height[i] = 0.5 + 0.2 * Math.sin(6 * u + 2 * v) +
      0.13 * Math.cos(9 * v - 3 * u) + 0.035 * Math.sin(47 * (u + v));
    flow[i] = Math.max(0, Math.sin(8 * u + v)) * 0.18;
    wear[i] = Math.max(0, Math.cos(11 * v - 4 * u)) * 0.017;
    deposition[i] = Math.max(0, Math.sin(9 * u - 6 * v)) * 0.014;
  }
  return { resolution: n, height, flow, wear, deposition };
}

/**
 * A separate Node thread samples *process-wide* RSS while the test thread is
 * blocked by synchronous PNG synthesis/ZIP packing. This is a 25 ms sampled
 * high-water mark, not an allocator trace or an in-browser memory guarantee.
 */
async function peakSampler() {
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    let peak = process.memoryUsage().rss;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 25);
    parentPort.on('message', () => {
      clearInterval(timer);
      peak = Math.max(peak, process.memoryUsage().rss);
      parentPort.postMessage(peak);
    });
  `, { eval: true });
  return async () => {
    const measured = new Promise<number>((resolve, reject) => {
      worker.once('message', (bytes: number) => resolve(bytes));
      worker.once('error', reject);
    });
    worker.postMessage('stop');
    const peak = await measured;
    await worker.terminate();
    return peak;
  };
}

it('records isolated full-bundle PBR allocation, completion and compressed bytes', async () => {
  const n = Number(process.env.PBR_BENCH_SIZE ?? 512);
  if (![512, 1024, 2048].includes(n)) throw new Error('Select 512, 1024 or 2048.');
  const before = process.memoryUsage().rss;
  const started = performance.now();
  const stop = await peakSampler();
  const field = seededFixture(n);
  const project = createProject('alpine');
  project.name = 'Synthetic PBR memory profile';
  project.resolution = n;
  const prepared = performance.now();
  const exported = makeExport(field, project, 'pbr', false);
  const done = performance.now();
  const peak = await stop();
  expect(exported.mime).toBe('application/zip');
  expect(exported.bytes.length).toBeGreaterThan(10000);
  const report = {
    schemaVersion: 1,
    platform: process.platform,
    node: process.version,
    resolution: n,
    mapCount: 12,
    source: 'seeded, fully procedural synthetic terrain and diagnostics',
    preflightEstimateMiB: estimatePBRPeakMiB(n),
    initialProcessRssMiB: toMiB(before),
    sampledPeakProcessRssMiB: toMiB(peak),
    sampledIncrementalRssMiB: toMiB(Math.max(0, peak - before)),
    finalProcessRssMiB: toMiB(process.memoryUsage().rss),
    packedZipMiB: toMiB(exported.bytes.byteLength),
    fieldPreparationMs: Math.round(prepared - started),
    materialAndEncodingMs: Math.round(done - prepared),
    totalMs: Math.round(done - started),
    caveats: '25ms process-RSS sampling on Node/Linux; not transferable to browser or GPU memory, and no cancellation timing measured',
  };
  const output = process.env.RUNNER_TEMP ?? 'test-results';
  await mkdir(output, { recursive: true });
  await writeFile(join(output, `pbr-memory-${n}.json`), JSON.stringify(report, null, 2));
  console.info('PBR_MEMORY_PROFILE ' + JSON.stringify(report));
});
