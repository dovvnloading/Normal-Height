import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { createProject } from '../src/model/presets';
import { createNode } from '../src/model/registry';
import { STUDIO_DEFAULTS } from '../src/model/noiseStudio';
import { createWorldDefinition } from '../src/model/world';
import { DEFAULT_GENESIS, GENESIS_ALGORITHM_VERSION } from '../src/model/genesis';
import { parseProject } from '../src/model/project';
import { serializeProjectFile } from '../src/model/projectStorage';
import { prepareWorldEvaluation } from '../src/engine/world';
import { WORLD_GENESIS_MAPS, type WorldGenesisMap } from '../src/export/genesisExport';
import {
  estimateWorldExport,
  streamWorldExport,
  worldCRC32,
  type WorldExportOptions,
  type WorldExportManifest,
} from '../src/export/worldExport';
import { verifyWorldArchive } from '../src/cli/archive';
import { runCLI } from '../src/cli/main';

function fixture(): WorldExportOptions {
  const project = createProject('studio-ridges');
  project.name = 'Genesis delivery fixture';
  project.seed = 381;
  const source = createNode('noise', { x: 0, y: 0 }, 'source');
  source.params = {
    ...STUDIO_DEFAULTS,
    noiseModel: 'v3',
    kernel: 'perlin',
    fractal: 'fbm',
    octaves: 3,
    scale: 2.5,
    amplitude: 0.32,
    offset: 0.2,
    sampling: 'point',
  };
  const output = createNode('output', { x: 260, y: 0 }, 'output');
  project.graph = {
    nodes: [source, output],
    edges: [{ id: 'source-output', source: source.id, target: output.id }],
  };
  const world = createWorldDefinition(project);
  world.domain = {
    ...world.domain,
    originX: -1175,
    originZ: 325,
    width: 2400,
    depth: 1600,
    heightScale: 1000,
    cellsX: 96,
    cellsZ: 64,
    boundary: 'open',
  };
  world.globalResolution = 64;
  world.tileCells = 32;
  world.genesis = { ...DEFAULT_GENESIS, enabled: true };
  project.version = 2;
  project.world = world;
  return {
    project,
    world,
    samplesX: 33,
    samplesZ: 33,
    tileIntervals: 16,
    format: 'raw32',
    profile: 'generic',
    maps: [...WORLD_GENESIS_MAPS],
  };
}

async function collect(options: WorldExportOptions) {
  const chunks: Uint8Array[] = [];
  const manifest = await streamWorldExport(options, (chunk) => {
    chunks.push(chunk.slice());
  });
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { manifest, bytes, files: unzipSync(bytes) };
}
type Archive = Awaited<ReturnType<typeof collect>>;

/** Assemble raw bytes independently, asserting all duplicate borders/corners. */
function assemble(archive: Archive, map: WorldGenesisMap | 'height') {
  const [width, height] = archive.manifest.dimensions.samples;
  const bpp = map === 'lithology' ? 1 : 4;
  const values = new Uint8Array(width * height * bpp);
  const seen = new Uint8Array(width * height);
  let comparisons = 0;
  for (const tile of archive.manifest.tiles) {
    const record = tile.files.find((entry) => entry.map === map)!;
    const bytes = archive.files[record.path];
    expect(bytes.length).toBe(tile.samples[0] * tile.samples[1] * bpp);
    for (let z = 0; z < tile.samples[1]; z++)
      for (let x = 0; x < tile.samples[0]; x++) {
        const target = (tile.sampleOffset[1] + z) * width + tile.sampleOffset[0] + x;
        const source = (z * tile.samples[0] + x) * bpp;
        if (seen[target]) {
          comparisons++;
          for (let c = 0; c < bpp; c++) expect(bytes[source + c]).toBe(values[target * bpp + c]);
        } else values.set(bytes.subarray(source, source + bpp), target * bpp);
        seen[target] = 1;
      }
  }
  expect(seen.every((value) => value === 1)).toBe(true);
  if (archive.manifest.tiles.length > 1) expect(comparisons).toBeGreaterThan(0);
  return values;
}

let directory: string;
let baseline: Archive;
beforeAll(async () => {
  await mkdir(resolve('test-results'), { recursive: true });
  directory = await mkdtemp(resolve('test-results/genesis-export-'));
  baseline = await collect(fixture());
}, 30000);
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('World Genesis production delivery', () => {
  it('requires enabled Genesis before optional map allocation', () => {
    const options = fixture();
    options.world.genesis!.enabled = false;
    expect(() => estimateWorldExport(options)).toThrow(/Enable World Genesis/);
  });

  it('stores physical units, categorical IDs and reproducible provenance', async () => {
    const { manifest, files } = baseline;
    expect(manifest.genesis).toMatchObject({
      schemaVersion: 1,
      algorithm: GENESIS_ALGORITHM_VERSION,
      fieldStage: 'before-world-transport',
      report: { algorithmVersion: GENESIS_ALGORITHM_VERSION },
    });
    expect(manifest.genesis!.channels.uplift).toMatchObject({ units: 'meters', storage: 'raw32' });
    expect(manifest.genesis!.channels.drainageArea).toMatchObject({
      units: 'square-meters',
      storage: 'raw32',
      sampling: 'reference-bilinear',
    });
    expect(manifest.genesis!.channels.lithology).toMatchObject({
      units: 'category-id',
      storage: 'raw8',
      sampling: 'native-physical-geology',
    });
    const project = parseProject(JSON.parse(strFromU8(files['project.nhterrain.json'])));
    expect(project.world?.genesis).toEqual(manifest.genesis!.settings);
    expect(manifest.encoding.diagnosticRanges).not.toHaveProperty('incision');
    expect(assemble(baseline, 'lithology').every((id) => id >= 0 && id <= 3)).toBe(true);
    const area = assemble(baseline, 'drainageArea');
    const view = new DataView(area.buffer);
    let maxArea = 0;
    for (let offset = 0; offset < area.length; offset += 4) {
      const value = view.getFloat32(offset, true);
      expect(Number.isFinite(value) && value >= 0).toBe(true);
      maxArea = Math.max(maxArea, value);
    }
    expect(maxArea).toBeGreaterThan(1);
    const path = join(directory, 'verified.zip');
    await writeFile(path, baseline.bytes);
    const verified = await verifyWorldArchive(path);
    expect(verified.verifiedMapFiles).toBe(manifest.tiles.length * 7);
  });

  it('preserves exact diagnostic and height bytes across tile partitions and matching crops', async () => {
    const partitioned = await collect({ ...fixture(), tileIntervals: 32 });
    const crop = await collect({
      ...fixture(),
      samplesX: 17,
      samplesZ: 17,
      region: { startX: 24, startZ: 16, cellsX: 48, cellsZ: 32 },
    });
    for (const map of ['height', ...WORLD_GENESIS_MAPS] as const) {
      const full = assemble(baseline, map);
      expect(assemble(partitioned, map)).toEqual(full);
      const cropped = assemble(crop, map);
      const bpp = map === 'lithology' ? 1 : 4;
      for (let z = 0; z < 17; z++)
        expect(cropped.subarray(z * 17 * bpp, (z + 1) * 17 * bpp)).toEqual(
          full.subarray(((z + 8) * 33 + 8) * bpp, ((z + 8) * 33 + 25) * bpp),
        );
    }
  }, 30000);

  it('delivers Genesis fields with a material halo spanning multiple engine chunks', async () => {
    const options: WorldExportOptions = {
      ...fixture(),
      samplesX: 33,
      samplesZ: 17,
      region: { startX: 32, startZ: 24, cellsX: 8, cellsZ: 8 },
      maps: [...WORLD_GENESIS_MAPS, 'basecolor', 'materialNormalGL'],
    };
    const archive = await collect(options);
    const prepared = await prepareWorldEvaluation(options.project, options.world);
    try {
      const field = await prepared.sampleRegion({
        ...options.region!,
        samplesX: options.samplesX,
        samplesZ: options.samplesZ,
      });
      expect(archive.manifest.material?.algorithm).toBe('surface-fabric-4');
      for (const map of WORLD_GENESIS_MAPS) {
        const bytes = assemble(archive, map);
        if (map === 'lithology') expect(bytes).toEqual(field.genesis!.lithology);
        else {
          const data = new DataView(bytes.buffer);
          for (let i = 0; i < field.heights.length; i++)
            expect(data.getFloat32(i * 4, true)).toBe(field.genesis![map][i]);
        }
      }
    } finally {
      prepared.dispose();
    }
  }, 30000);

  it('keeps numerical provenance even in a height-only archive', async () => {
    const archive = await collect({ ...fixture(), maps: [], samplesX: 16, samplesZ: 16 });
    expect(archive.manifest.genesis?.channels).toEqual({});
    expect(archive.manifest.genesis?.settings).toEqual(fixture().world.genesis);
    expect(archive.manifest.genesis?.report.limitations.length).toBeGreaterThan(0);
  });

  it('rejects repacked invalid units and categorical payloads after CRC checks succeed', async () => {
    for (const invalid of [
      'units',
      'categorical',
      'nan',
      'missing-map',
      'report',
      'metric',
      'legend',
    ] as const) {
      const files = Object.fromEntries(
        Object.entries(baseline.files).map(([path, bytes]) => [path, bytes.slice()]),
      );
      const manifest: WorldExportManifest = JSON.parse(strFromU8(files['manifest.json']));
      if (invalid === 'units')
        (manifest.genesis!.channels.drainageArea!.units as string) = 'meters';
      else if (invalid === 'report') manifest.genesis!.report.levels = [];
      else if (invalid === 'metric') manifest.genesis!.report.incisedVolumeM3 = Number.NaN;
      else if (invalid === 'legend')
        (manifest.genesis!.lithologies[0].label as string) = 'Wrong geological identity';
      else {
        const map = invalid === 'nan' ? 'drainageArea' : 'lithology';
        const record = manifest.tiles[0].files.find((entry) => entry.map === map)!;
        if (invalid === 'missing-map') {
          manifest.tiles[0].files = manifest.tiles[0].files.filter((entry) => entry !== record);
          delete files[record.path];
        } else {
          if (invalid === 'nan')
            new DataView(files[record.path].buffer).setFloat32(0, Number.NaN, true);
          else files[record.path][0] = 255;
          record.crc32 = worldCRC32(files[record.path]);
        }
      }
      files['manifest.json'] = strToU8(JSON.stringify(manifest));
      const path = join(directory, `invalid-${invalid}.zip`);
      await writeFile(path, zipSync(files));
      await expect(verifyWorldArchive(path)).rejects.toThrow(/Genesis|lithology/);
    }
  });

  it('accepts the new maps through the production CLI and verifies atomic output', async () => {
    const options = fixture();
    const path = join(directory, 'genesis.nhterrain.json');
    const output = join(directory, 'cli.zip');
    await writeFile(path, serializeProjectFile(options.project));
    let stdout = '';
    const code = await runCLI(
      [
        'build',
        path,
        '--out',
        output,
        '--samples',
        '17x17',
        '--format',
        'raw32',
        '--maps',
        WORLD_GENESIS_MAPS.join(','),
        '--json',
      ],
      {
        stdout: (value) => {
          stdout += value;
        },
        stderr: () => {},
      },
    );
    expect(code, stdout).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.result.manifest.genesis.algorithm).toBe(GENESIS_ALGORITHM_VERSION);
    expect((await verifyWorldArchive(output)).verifiedMapFiles).toBe(7);
  }, 30000);
});
