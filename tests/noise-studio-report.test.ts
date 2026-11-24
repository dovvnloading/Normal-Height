import { cpus } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { generateStudioNoise } from '../src/engine/noiseStudio';
import { noiseExportFilename, streamNoiseExport } from '../src/export/noiseExport';
import { NOISE_PRESETS, STUDIO_DEFAULTS, STUDIO_KERNELS } from '../src/model/noiseStudio';

/** Opt-in measurements, never part of the routine unit-test time budget. */
describe.skipIf(process.env.NOISE_STUDIO_REPORT !== '1')('Noise Studio reproducible report', () => {
  it('records real sampler timings, distributions, and a constant-memory 8K export', () => {
    const directory = process.env.NOISE_STUDIO_REPORT_DIR;
    if (!directory) throw new Error('Set NOISE_STUDIO_REPORT_DIR to a report directory.');
    mkdirSync(directory, { recursive: true });
    const seed = 48271,
      worldSize = 8000;
    const timings: Record<string, unknown>[] = [];
    for (const id of ['alpine-ridges', 'weathered-rock', 'fractured-plates', 'gabor-ripples']) {
      const preset = NOISE_PRESETS.find((p) => p.id === id)!;
      const params = { ...STUDIO_DEFAULTS, ...preset.params };
      generateStudioNoise(params, seed, 64, worldSize);
      for (const n of [128, 512, 1024]) {
        const times: number[] = [];
        let minimum = Infinity,
          maximum = -Infinity;
        for (let repeat = 0; repeat < 3; repeat++) {
          const start = performance.now();
          const data = generateStudioNoise(params, seed, n, worldSize);
          times.push(performance.now() - start);
          for (const value of data) {
            if (!Number.isFinite(value)) throw new Error(`${id} produced a non-finite sample.`);
            minimum = Math.min(minimum, value);
            maximum = Math.max(maximum, value);
          }
        }
        times.sort((a, b) => a - b);
        timings.push({
          preset: id,
          resolution: n,
          medianMs: Math.round(times[1]),
          maxMs: Math.round(times[2]),
          minimum,
          maximum,
        });
      }
    }
    const gallery: Record<string, unknown>[] = [];
    for (const [kernel, label] of STUDIO_KERNELS) {
      const params = { ...STUDIO_DEFAULTS, kernel, fractal: 'none' as const, scale: 8 };
      const n = 256,
        data = generateStudioNoise(params, seed, n, worldSize);
      writeFileSync(join(directory, `${kernel}.f32`), Buffer.from(data.buffer));
      gallery.push({ id: kernel, label, resolution: n, params });
    }
    for (const p of NOISE_PRESETS) {
      const params = { ...STUDIO_DEFAULTS, ...p.params };
      const n = 256,
        data = generateStudioNoise(params, seed, n, worldSize);
      writeFileSync(join(directory, `preset-${p.id}.f32`), Buffer.from(data.buffer));
      gallery.push({ id: `preset-${p.id}`, label: p.name, resolution: n, params });
    }
    const options = {
      params: {
        ...STUDIO_DEFAULTS,
        kernel: 'perlin' as const,
        fractal: 'none' as const,
        scale: 12,
      },
      resolution: 8192,
      format: 'png16' as const,
      projectSeed: seed,
      worldSize,
      heightScale: 2400,
    };
    let bytes = 0,
      maxChunkBytes = 0;
    const start = performance.now();
    const metadata = streamNoiseExport(options, (chunk) => {
      bytes += chunk.byteLength;
      maxChunkBytes = Math.max(maxChunkBytes, chunk.byteLength);
    });
    const export8k = {
      filename: noiseExportFilename(options),
      durationMs: Math.round(performance.now() - start),
      bytes,
      maxChunkBytes,
      rowsPerChunk: 16,
      metadata,
    };
    const report = {
      date: new Date().toISOString(),
      cpu: cpus()[0]?.model,
      runtime: process.version,
      threads: 1,
      repeats: 3,
      settings: 'Filtered sampling, no supersampling; authored preset controls.',
      seed,
      worldSize,
      timings,
      export8k,
      gallery,
    };
    writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.table(timings);
    console.log(JSON.stringify({ cpu: report.cpu, runtime: report.runtime, export8k }, null, 2));
  }, 300_000);
});
