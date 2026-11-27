#!/usr/bin/env node
/** Generate an asymmetric, rectangular, partial-edge four-tile fixture with
 * the actual project parser, source node, production CLI and ZIP verifier. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(process.argv[2] ?? resolve(root, 'test-results/blender-qualification'));
await mkdir(output, { recursive: true });
const server = await createServer({
  root,
  configFile: false,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true, hmr: false, watch: null },
});
try {
  const { createNode } = await server.ssrLoadModule('/src/model/registry.ts');
  const { createWorldDefinition } = await server.ssrLoadModule('/src/model/world.ts');
  const { encodeSamples } = await server.ssrLoadModule('/src/model/heightRaster.ts');
  const { serializeProjectFile } = await server.ssrLoadModule('/src/model/projectStorage.ts');
  const { parseProject } = await server.ssrLoadModule('/src/model/project.ts');
  const source = createNode('heightImport', { x: 0, y: 0 }, 'blender-height');
  const target = createNode('output', { x: 250, y: 0 }, 'blender-output');
  const width = 33,
    height = 25;
  const bytes = new Uint8Array(width * height * 4);
  const data = new DataView(bytes.buffer);
  for (let z = 0; z < height; z++)
    for (let x = 0; x < width; x++) {
      const east = (x / (width - 1)) * 960,
        south = (z / (height - 1)) * 640;
      const elevation =
        120 + 0.18 * east + 0.07 * south + 18 * Math.sin(east / 220) * Math.cos(south / 180);
      data.setFloat32((z * width + x) * 4, elevation, true);
    }
  source.raster = {
    name: 'Asymmetric measured QA source',
    width,
    height,
    format: 'f32le',
    data: encodeSamples(bytes),
  };
  let project = {
    version: 1,
    name: 'Blender bridge qualification',
    seed: 1729,
    resolution: 128,
    worldSize: 960,
    heightScale: 1000,
    presetId: 'custom',
    graph: {
      nodes: [source, target],
      edges: [
        {
          id: 'blender-source-output',
          source: source.id,
          target: target.id,
          sourceHandle: 'height',
          targetHandle: 'in',
        },
      ],
    },
  };
  const world = createWorldDefinition(project);
  world.domain = {
    ...world.domain,
    width: 960,
    depth: 640,
    cellsX: 32,
    cellsZ: 24,
    originX: 120,
    originZ: -350,
    datum: -17.5,
  };
  world.globalResolution = 64;
  project = parseProject({ ...project, version: 2, world });
  const input = resolve(output, 'asymmetric-world.nhterrain.json');
  await writeFile(input, serializeProjectFile(project));
  for (const format of ['raw32', 'raw16', 'png16']) {
    const destination = resolve(output, `world-${format}.zip`);
    const result = spawnSync(
      process.execPath,
      [
        resolve(root, 'scripts/nh.mjs'),
        'build',
        input,
        '--out',
        destination,
        '--samples',
        '33x25',
        '--format',
        format,
        '--maps',
        'basecolor,orm,detailNormalGL',
        '--tile-intervals',
        '16',
        '--force',
        '--json',
      ],
      { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );
    if (result.status !== 0)
      throw new Error(result.stderr || result.stdout || `CLI build failed: ${format}`);
    const report = JSON.parse(result.stdout.trim());
    if (!report.ok) throw new Error(`CLI rejected ${format}: ${result.stdout}`);
    await writeFile(
      resolve(output, `build-${format}.json`),
      JSON.stringify(report, null, 2) + '\n',
    );
    process.stdout.write(`Verified ${destination}\n`);
  }
} finally {
  await server.close();
}
