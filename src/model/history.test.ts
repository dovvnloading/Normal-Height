import { expect, it } from 'vitest';
import { appendUndoSnapshot } from './history';
import { createProject } from './presets';
import { createNode } from './registry';
import type { HeightRaster } from './heightRaster';
import type { TerrainProject } from './types';

const template = createProject();
const source = createNode('heightImport');
// The undo budget inspects dimensions and identity. No sample allocation is needed here.
const fullRaster = (name: string): HeightRaster => ({
  name,
  width: 2048,
  height: 2048,
  format: 'f32le',
  data: '',
});
const snapshot = (name: string, raster?: HeightRaster): TerrainProject => ({
  ...template,
  name,
  graph: { nodes: [{ ...source, raster }], edges: [] },
});

it('keeps the latest 60 ordinary edits when snapshots share an imported source', () => {
  const raster = fullRaster('survey.r32');
  const edits = Array.from({ length: 63 }, (_, i) => snapshot(String(i), raster));
  let past: TerrainProject[] = [];
  for (let i = 1; i < edits.length; i++) past = appendUndoSnapshot(past, edits[i - 1], edits[i]);
  expect(past).toEqual(edits.slice(2, 62));
});

it('evicts only the oldest prefix once the current and undo sources exceed 64 MiB', () => {
  const rasters = Array.from('abcde', fullRaster);
  const edits = [rasters[0], rasters[1], rasters[1], rasters[2], rasters[3], rasters[4]].map(
    (raster, i) => snapshot(String(i), raster),
  );
  const past = appendUndoSnapshot(edits.slice(0, 4), edits[4], edits[5]);
  expect(past).toEqual(edits.slice(1, 5));
});
