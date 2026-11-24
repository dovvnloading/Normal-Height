import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluateGraph } from '../src/engine';
import { createProject } from '../src/model/presets';
import { parseProject } from '../src/model/project';
import { createNode } from '../src/model/registry';

const families = [
  'perlin', 'simplex', 'fbm', 'ridged', 'billow', 'turbulence', 'voronoi',
  'voronoi-edge', 'cellular', 'wave', 'warped', 'naki',
];
function projectFor(mode: string, seed: number) {
  const project = createProject();
  project.seed = seed;
  const source = createNode('noise', { x: 0, y: 0 }, 'source');
  const output = createNode('output', { x: 200, y: 0 }, 'out');
  Object.assign(source.params, {
    mode, scale: 12, rotation: 27, stretch: 1.4, warp: 0.6,
    octaves: 6, persistence: 0.65, lacunarity: 2.05, amplitude: 0.7,
    offset: 0.1, seed: 9,
  });
  delete source.params.noiseModel;
  project.graph = {
    nodes: [source, output],
    edges: [{ id: 'e', source: 'source', target: 'out', sourceHandle: 'height', targetHandle: 'in' }],
  };
  return parseProject(JSON.parse(JSON.stringify(project)));
}

describe('independent pre-versioning noise reference', () => {
  it.runIf(Boolean(process.env.NOISE_REFERENCE_FILE))(
    'matches the original engine byte-for-byte for saved noise-only graphs',
    () => {
      const actual: Record<string, string> = {};
      for (const mode of families) for (const seed of [42, 48271])
        for (const resolution of [65, 257]) {
          const { field } = evaluateGraph(projectFor(mode, seed), { resolution });
          const bytes = new Uint8Array(field.height.buffer, field.height.byteOffset, field.height.byteLength);
          actual[`${mode}:${seed}:${resolution}`] = createHash('sha256').update(bytes).digest('hex');
        }
      const path = process.env.NOISE_REFERENCE_FILE!;
      if (process.env.NOISE_REFERENCE_CAPTURE === '1') {
        writeFileSync(path, JSON.stringify(actual, null, 2) + '\n');
        console.log(`Captured ${Object.keys(actual).length} legacy field hashes from the pre-versioning checkout`);
      } else {
        const expected = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
        expect(Object.keys(actual)).toEqual(Object.keys(expected));
        for (const [key, hash] of Object.entries(actual))
          expect(hash, key).toBe(expected[key]);
        console.log(`Matched ${Object.keys(actual).length} independent legacy field hashes`);
      }
    }, 120_000,
  );

  it.runIf(process.env.NOISE_PROFILE === '1')(
    'records CPU graph generation timings for corrected and legacy sampling',
    () => {
      const samples: { family: string; model: string; resolution: number; medianMs: number; maxMs: number }[] = [];
      for (const family of ['warped', 'naki']) for (const model of ['legacy', 'v2']) {
        const project = projectFor(family, 42);
        project.graph.nodes[0].params.noiseModel = model;
        evaluateGraph(project, { resolution: 128 });
        for (const resolution of [512, 1024, 2048]) {
          const times = [];
          for (let repeat = 0; repeat < 3; repeat++) {
            const begin = performance.now();
            const { field } = evaluateGraph(project, { resolution });
            times.push(performance.now() - begin);
            expect(field.height.length).toBe(resolution * resolution);
            expect(field.height.every(Number.isFinite)).toBe(true);
          }
          times.sort((a, b) => a - b);
          samples.push({ family, model, resolution, medianMs: Math.round(times[1]), maxMs: Math.round(times[2]) });
        }
      }
      console.table(samples);
      if (process.env.NOISE_PROFILE_FILE)
        writeFileSync(process.env.NOISE_PROFILE_FILE, JSON.stringify(samples, null, 2) + '\n');
    }, 240_000,
  );
});
