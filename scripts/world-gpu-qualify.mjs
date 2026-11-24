// Run against Vite dev: NH_WORLD_URL=http://127.0.0.1:5173 node scripts/world-gpu-qualify.mjs
// NH_GPU_SOFTWARE=1 opts into SwiftShader; its output is never a hardware benchmark.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const base = process.env.NH_WORLD_URL || 'http://127.0.0.1:5173';
const software = process.env.NH_GPU_SOFTWARE === '1';
const browser = await chromium.launch({
  executablePath: process.env.NH_CHROMIUM_PATH || undefined,
  headless: process.env.NH_GPU_HEADFUL !== '1',
  args: software
    ? [
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--enable-unsafe-webgpu',
        '--disable-dev-shm-usage',
      ]
    : [],
});
try {
  const page = await browser.newPage();
  await page.route('**/__world_gpu_probe__', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<title>World GPU qualification</title><p>Runtime numerical probe</p>',
    }),
  );
  await page.goto(`${base}/__world_gpu_probe__`);
  const report = await page.evaluate(async () => {
    const { createPointwiseBackend } = await import('/src/engine/gpu/pointwise.ts');
    const { generateWorldRegion } = await import('/src/engine/world/index.ts');
    const { createNode } = await import('/src/model/registry.ts');
    const { STUDIO_DEFAULTS } = await import('/src/model/noiseStudio.ts');
    const { createWorldDefinition } = await import('/src/model/world.ts');
    const probe = await createPointwiseBackend('webgpu');
    const capability = structuredClone(probe.capability);
    probe.dispose();
    const source = createNode('noise', { x: 0, y: 0 }, 'source');
    source.params = {
      ...STUDIO_DEFAULTS,
      noiseModel: 'v3',
      kernel: 'perlin',
      fractal: 'none',
      sampling: 'point',
    };
    const shape = createNode('remap', { x: 1, y: 0 }, 'shape');
    shape.params = { contrast: 1.1, brightness: 0.05, gamma: 1.2, clamp: false };
    const output = createNode('output', { x: 2, y: 0 }, 'output');
    const project = {
      version: 1,
      name: 'GPU qualification',
      seed: 42,
      resolution: 128,
      worldSize: 4000,
      heightScale: 1800,
      presetId: 'custom',
      graph: {
        nodes: [source, shape, output],
        edges: [
          {
            id: 'a',
            source: 'source',
            target: 'shape',
            sourceHandle: 'height',
            targetHandle: 'in',
          },
          {
            id: 'b',
            source: 'shape',
            target: 'output',
            sourceHandle: 'height',
            targetHandle: 'in',
          },
        ],
      },
    };
    const world = createWorldDefinition(project);
    world.globalResolution = 64;
    const grid = {
      startX: 0,
      startZ: 0,
      cellsX: world.domain.cellsX,
      cellsZ: world.domain.cellsZ,
      samplesX: 257,
      samplesZ: 257,
    };
    const cpu = await generateWorldRegion(project, { ...world, backend: 'cpu-reference' }, grid);
    const gpu = await generateWorldRegion(project, { ...world, backend: 'webgpu' }, grid);
    let maxAbsoluteError = 0,
      sum = 0;
    for (let i = 0; i < cpu.heights.length; i++) {
      const error = Math.abs(cpu.heights[i] - gpu.heights[i]);
      maxAbsoluteError = Math.max(maxAbsoluteError, error);
      sum += error * error;
    }
    const graph = {
      backend: gpu.backend,
      samples: cpu.heights.length,
      maxAbsoluteError,
      rmse: Math.sqrt(sum / cpu.heights.length),
      cpuDurationMs: cpu.duration,
      requestedGpuDurationMs: gpu.duration,
      stages: gpu.stages,
    };
    if (
      capability.backend === 'webgpu' &&
      (graph.backend !== 'webgpu' || graph.maxAbsoluteError > 1e-4 || graph.rmse > 1e-5)
    )
      throw new Error('End-to-end GPU graph failed the numerical contract.');
    return {
      createdAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      secureContext: isSecureContext,
      capability,
      graph,
    };
  });
  report.execution = software
    ? 'Explicit software adapter run. Numerical evidence only; not hardware acceleration or performance qualification.'
    : 'Default adapter run; inspect adapter identity before treating this as hardware evidence.';
  const out = resolve(process.argv[2] || '../world-gpu-qualification.json');
  mkdirSync(resolve(out, '..'), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (['compilation', 'execution', 'numerical'].includes(report.capability.failure))
    throw new Error(
      `WebGPU qualification failed at ${report.capability.failure}: ${report.capability.reason}`,
    );
} finally {
  await browser.close();
}
