import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { arch, cpus, platform, release } from 'node:os';
import { describe, expect, it } from 'vitest';
import { evaluateGraph } from '../src/engine';
import { GraphFieldCache } from '../src/engine/compute/cache';
import { createProject } from '../src/model/presets';
import type { EvaluationResult, TerrainProject } from '../src/model/types';

// Explicit profiling job; does not add large terrain evaluations to routine CI.
// WORLD_ENGINE_PROFILE=1 WORLD_ENGINE_PROFILE_FILE=docs/benchmarks/world-engine-cpu.json \
//   npx vitest run tests/compute-cache-profile.test.ts
describe.skipIf(process.env.WORLD_ENGINE_PROFILE !== '1')('persistent CPU cache profile', () => {
  it('records reproducible cold, unchanged and downstream-edit runs with exact field hashes', () => {
    const hash = (result: EvaluationResult) => createHash('sha256')
      .update(new Uint8Array(result.field.height.buffer)).digest('hex');
    const run = (project: TerrainProject, cache?: GraphFieldCache) => {
      const start = performance.now();
      const result = evaluateGraph(project, { resolution: project.resolution }, cache);
      return { elapsedMs: performance.now() - start, result };
    };
    const samples: Record<string, unknown>[] = [];
    // Separate a small JIT warmup from the measured 512² fixture.
    const warmup = createProject('alpine');
    warmup.resolution = 64;
    run(warmup);
    for (let repeat = 0; repeat < 3; repeat++) {
      const project = createProject('alpine');
      project.resolution = 512;
      // A downstream remap has a measurable effect; high talus thresholds in
      // the authored terrain can make small thermal-strength edits a no-op.
      project.graph.nodes.splice(project.graph.nodes.length - 1, 0, {
        id: 'profile-remap', kind: 'remap', label: 'Exposure', position: { x: 1000, y: 100 },
        params: { contrast: 1, gamma: 1, brightness: 0, clamp: false },
      });
      project.graph.edges.find((edge) => edge.target === 'output')!.target = 'profile-remap';
      project.graph.edges.push({ id: 'profile-to-output', source: 'profile-remap', target: 'output', targetHandle: 'in' });
      const cache = new GraphFieldCache();
      const uncached = run(project);
      const cold = run(project, cache);
      const warm = run(project, cache);
      const baselineHash = hash(uncached.result);
      expect(hash(cold.result)).toBe(baselineHash);
      expect(hash(warm.result)).toBe(baselineHash);
      project.graph.nodes.find((node) => node.id === 'profile-remap')!.params.brightness = 0.01 + repeat * 0.01;
      const edit = run(project, cache);
      const editedReference = run(project);
      expect(hash(edit.result)).toBe(hash(editedReference.result));
      expect(hash(edit.result)).not.toBe(baselineHash);
      samples.push({ repeat, uncachedMs: uncached.elapsedMs,
        coldCacheMs: cold.elapsedMs, unchangedMs: warm.elapsedMs,
        downstreamEditMs: edit.elapsedMs, uncachedDownstreamEditMs: editedReference.elapsedMs,
        unchangedHits: warm.result.diagnostics!.cacheHits,
        downstreamEditHits: edit.result.diagnostics!.cacheHits,
        downstreamEditMisses: edit.result.diagnostics!.cacheMisses,
        retainedCacheBytes: cache.bytes,
        estimatedWorkingBytes: edit.result.diagnostics!.estimatedWorkingBytes,
        baselineHeightSha256: baselineHash, editedHeightSha256: hash(edit.result) });
    }
    const median = (key: string) => samples.map((sample) => Number(sample[key])).sort((a, b) => a - b)[1];
    const report = {
      schema: 1, capturedAt: new Date().toISOString(),
      sourceBase: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      implementation: 'World Engine persistent CPU cache working tree',
      sourceHeadMode: 'uncommitted working tree based on sourceBase',
      implementationFileHashes: Object.fromEntries([
        'src/engine/index.ts', 'src/engine/plan/graph.ts', 'src/engine/compute/cache.ts',
        'src/engine/compute/client.ts', 'tests/compute-cache-profile.test.ts',
      ].map((file) => [file, createHash('sha256').update(readFileSync(file)).digest('hex')])),
      environment: { runtime: process.version, platform: platform(), release: release(), arch: arch(),
        cpu: cpus()[0]?.model, logicalCpus: cpus().length },
      fixture: { preset: 'alpine', seed: 48271, resolution: 512, repeats: 3,
        downstreamEdit: 'added downstream remap brightness 0 → 0.01/0.02/0.03', backend: 'cpu-reference' },
      measuredScope: 'evaluateGraph wall time including validation, thumbnails, snapshot copies, statistics and cache publication; excludes worker transfer, browser rendering and export encoding',
      memoryScope: 'retained unique field buffers and conservative working-memory preflight; not measured process peak memory',
      medians: { uncachedMs: median('uncachedMs'), coldCacheMs: median('coldCacheMs'),
        unchangedMs: median('unchangedMs'), downstreamEditMs: median('downstreamEditMs'),
        uncachedDownstreamEditMs: median('uncachedDownstreamEditMs'),
        downstreamEditImprovementPercent: 100 * (1 - median('downstreamEditMs') / median('uncachedDownstreamEditMs')) },
      samples,
    };
    const output = process.env.WORLD_ENGINE_PROFILE_FILE;
    if (output) { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); }
    console.log(JSON.stringify(report.medians));
  }, 180_000);
});
