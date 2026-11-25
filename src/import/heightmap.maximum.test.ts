import { expect, it } from 'vitest';
import { importHeightRaster } from './heightmap';
import { evaluateGraph } from '../engine';
import { createProject } from '../model/presets';
import { createNode } from '../model/registry';
import { parseProject } from '../model/project';
import { MAX_PROJECT_RASTER_BYTES, rasterBytes } from '../model/heightRaster';

it('imports and reopens a maximum-size Float32 elevation grid without losing meter values', async () => {
  const n = 2048;
  const bytes = new Uint8Array(n * n * 4);
  const samples = new DataView(bytes.buffer);
  const corners = [0, n - 1, n * (n - 1), n * n - 1];
  const meters = [-125, 50, 175, 250];
  corners.forEach((i, j) => samples.setFloat32(i * 4, meters[j], true));

  const source = createNode('heightImport');
  source.raster = await importHeightRaster(new File([bytes], 'maximum.r32'));
  expect(rasterBytes(source.raster)).toBe(MAX_PROJECT_RASTER_BYTES);
  expect([source.raster.width, source.raster.height, source.raster.format]).toEqual([n, n, 'f32le']);

  const project = createProject();
  project.heightScale = 1000;
  const output = createNode('output');
  project.graph = {
    nodes: [source, output],
    edges: [{ id: 'maximum-out', source: source.id, target: output.id, sourceHandle: 'height', targetHandle: 'in' }],
  };
  const restored = parseProject(JSON.parse(JSON.stringify(project)));
  expect(restored.graph.nodes[0].raster?.data === source.raster.data).toBe(true);
  const resolution = 128;
  const { field } = evaluateGraph(restored, { resolution });
  [0, resolution - 1, resolution * (resolution - 1), resolution ** 2 - 1].forEach((i, j) => {
    expect(field.height[i] * restored.heightScale).toBeCloseTo(meters[j], 4);
  });
}, 60_000);
