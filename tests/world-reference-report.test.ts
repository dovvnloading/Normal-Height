import { cpus } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD_TRANSPORT } from '../src/model/world';
import { simulateWorldTransport } from '../src/engine/world/hydrology';

/** Opt-in reproducible numerical/performance evidence, not a routine CI benchmark. */
describe.skipIf(process.env.WORLD_REFERENCE_REPORT !== '1')(
  'World transport reference report',
  () => {
    it('records real rectangular whole-domain solves and conservation residuals', async () => {
      const directory = process.env.WORLD_REFERENCE_REPORT_DIR;
      if (!directory) throw new Error('Set WORLD_REFERENCE_REPORT_DIR to the report directory.');
      mkdirSync(directory, { recursive: true });
      const settings = { ...DEFAULT_WORLD_TRANSPORT, enabled: true };
      const timings: Record<string, unknown>[] = [];
      for (const n of [64, 128, 256])
        for (const boundary of ['open', 'closed'] as const) {
          const input = Float64Array.from({ length: n * n }, (_, i) => {
            const x = (i % n) / (n - 1),
              z = Math.floor(i / n) / (n - 1);
            return 240 + 900 * (1 - z) + 130 * Math.abs(x - 0.5) + 30 * Math.sin(x * 7 + z * 5);
          });
          const grid = { width: n, height: n, widthMeters: 4000, depthMeters: 2500, boundary };
          const milliseconds: number[] = [],
            hashes: string[] = [];
          let budget: Awaited<ReturnType<typeof simulateWorldTransport>>['budget'] | undefined;
          for (let repeat = 0; repeat < 3; repeat++) {
            const start = performance.now();
            const result = await simulateWorldTransport(input, grid, settings, {
              tileCells: 32,
              tileOrder: repeat % 2 ? 'reverse' : 'forward',
            });
            milliseconds.push(performance.now() - start);
            hashes.push(
              createHash('sha256').update(Buffer.from(result.height.buffer)).digest('hex'),
            );
            budget = result.budget;
            expect(Math.abs(budget.waterResidualM3)).toBeLessThan(budget.rainfallVolumeM3 * 1e-9);
            expect(Math.abs(budget.solidResidualM3)).toBeLessThan(
              Math.max(1e-4, budget.erodedVolumeM3 * 1e-9),
            );
          }
          expect(new Set(hashes).size).toBe(1);
          const sorted = [...milliseconds].sort((a, b) => a - b);
          timings.push({
            samplesX: n,
            samplesZ: n,
            boundary,
            spacingX: grid.widthMeters / (n - 1),
            spacingZ: grid.depthMeters / (n - 1),
            milliseconds,
            medianMs: sorted[1],
            maximumMs: sorted[2],
            sha256Float64Height: hashes[0],
            budget,
          });
        }
      const sourceHashes = Object.fromEntries(
        [
          'src/engine/world/hydrology.ts',
          'src/model/world.ts',
          'tests/world-reference-report.test.ts',
        ].map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]),
      );
      writeFileSync(
        join(directory, 'world-transport-cpu-reference.json'),
        JSON.stringify(
          {
            date: new Date().toISOString(),
            runtime: process.version,
            cpu: cpus()[0]?.model,
            threads: 1,
            repeats: 3,
            description:
              'Actual CPU finite-volume reference measurements in Node; no browser, GPU or geophysical-validation claims.',
            fixture:
              '240 + 900*(1-z) + 130*abs(x-.5) + 30*sin(7*x+5*z), x/z normalized over 4000×2500 metres.',
            settings,
            sourceHashes,
            timings,
          },
          null,
          2,
        ) + '\n',
      );
    }, 180000);
  },
);
