import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluateGraph } from '../src/engine';
import { createProject } from '../src/model/presets';
import { parseProject } from '../src/model/project';
import { createNode } from '../src/model/registry';

// Captured before Studio integration at fefaf0da394a674f3ad0de58e33d705fbdc6c3b4.
// These are independent output references, not expectations derived from v3.
const families = [
  'perlin',
  'simplex',
  'fbm',
  'ridged',
  'billow',
  'turbulence',
  'voronoi',
  'voronoi-edge',
  'cellular',
  'wave',
  'warped',
  'naki',
];
const fixture = new URL('./fixtures/noise-compatibility.json', import.meta.url);

describe('saved noise compatibility', () => {
  it('preserves every legacy and v2 family byte-for-byte', () => {
    const actual: Record<string, string> = {};
    for (const model of ['legacy', 'v2'])
      for (const mode of families)
        for (const seed of [42, 48271])
          for (const resolution of [65, 257]) {
            const project = createProject();
            project.seed = seed;
            const source = createNode('noise', { x: 0, y: 0 }, 'source');
            const output = createNode('output', { x: 200, y: 0 }, 'out');
            Object.assign(source.params, {
              mode,
              noiseModel: model,
              scale: 12,
              rotation: 27,
              stretch: 1.4,
              warp: 0.6,
              octaves: 6,
              persistence: 0.65,
              lacunarity: 2.05,
              amplitude: 0.7,
              offset: 0.1,
              seed: 9,
            });
            // Original projects had no algorithm marker at all.
            if (model === 'legacy') delete source.params.noiseModel;
            project.graph = {
              nodes: [source, output],
              edges: [
                {
                  id: 'e',
                  source: 'source',
                  target: 'out',
                  sourceHandle: 'height',
                  targetHandle: 'in',
                },
              ],
            };
            const saved = parseProject(JSON.parse(JSON.stringify(project)));
            const { field } = evaluateGraph(saved, { resolution });
            const bytes = new Uint8Array(
              field.height.buffer,
              field.height.byteOffset,
              field.height.byteLength,
            );
            actual[`${model}:${mode}:${seed}:${resolution}`] = createHash('sha256')
              .update(bytes)
              .digest('hex');
          }
    if (process.env.CAPTURE_NOISE_COMPATIBILITY === '1') {
      mkdirSync(new URL('./fixtures/', import.meta.url), { recursive: true });
      writeFileSync(fixture, JSON.stringify(actual, null, 2) + '\n');
    } else {
      const expected = JSON.parse(readFileSync(fixture, 'utf8')) as Record<string, string>;
      expect(Object.keys(actual)).toEqual(Object.keys(expected));
      for (const [key, hash] of Object.entries(actual)) expect(hash, key).toBe(expected[key]);
    }
  }, 30_000);
});
