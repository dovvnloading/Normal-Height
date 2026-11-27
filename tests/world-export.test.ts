import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { inflateSync } from 'node:zlib';
import { createNode } from '../src/model/registry';
import { createWorldDefinition, DEFAULT_WORLD_TRANSPORT } from '../src/model/world';
import { STUDIO_DEFAULTS } from '../src/model/noiseStudio';
import type { TerrainProject } from '../src/model/types';
import { generateWorldRegion } from '../src/engine/world';
import { WORLD_MATERIAL_MAPS } from '../src/materials/worldMaterial';
import { encodeSamples, MAX_PROJECT_FILE_BYTES } from '../src/model/heightRaster';
import { parseProject } from '../src/model/project';
import {
  checkWorldExportBudget,
  estimateWorldExport,
  streamWorldExport,
  worldCRC32,
} from '../src/export/worldExport';
import type { WorldExportOptions, WorldExportProgress } from '../src/export/worldExport';

function options(): WorldExportOptions {
  const noise = createNode('noise', { x: 0, y: 0 }, 'source');
  noise.params = {
    ...STUDIO_DEFAULTS,
    noiseModel: 'v3',
    kernel: 'perlin',
    fractal: 'fbm',
    octaves: 2,
    scale: 2.3,
    rotation: 13,
    seed: 14,
    sampling: 'point',
    amplitude: 1.2,
    offset: -0.2,
  };
  const remap = createNode('remap', { x: 1, y: 0 }, 'remap');
  remap.params = { contrast: 1.2, brightness: 0.1, gamma: 1.2, clamp: false };
  const terrace = createNode('terrace', { x: 2, y: 0 }, 'terrace');
  terrace.params = { steps: 7, softness: 0.6 };
  const output = createNode('output', { x: 3, y: 0 }, 'out');
  const project: TerrainProject = {
    version: 1,
    name: 'Export fixture',
    seed: 42,
    resolution: 64,
    worldSize: 1300,
    heightScale: 400,
    presetId: 'custom',
    graph: {
      nodes: [noise, remap, terrace, output],
      edges: [noise, remap, terrace].map((node, i) => ({
        id: `edge-${i}`,
        source: node.id,
        target: [remap, terrace, output][i].id,
        sourceHandle: 'height',
        targetHandle: 'in',
      })),
    },
  };
  const world = createWorldDefinition(project);
  world.tileCells = 32;
  world.globalResolution = 64;
  world.domain = {
    ...world.domain,
    width: 1300,
    depth: 750,
    originX: -1250.5,
    originZ: 142.25,
    cellsX: 64,
    cellsZ: 48,
    datum: -70,
  };
  return {
    project,
    world,
    samplesX: 35,
    samplesZ: 29,
    tileIntervals: 16,
    format: 'raw32',
    profile: 'generic',
  };
}
async function collect(value: WorldExportOptions) {
  const parts: Uint8Array[] = [],
    progress: number[] = [];
  let completed = 0;
  const manifest = await streamWorldExport(
    value,
    async (bytes, final) => {
      parts.push(bytes.slice());
      if (final) completed++;
      await Promise.resolve();
    },
    (n) => progress.push(n),
  );
  expect(completed).toBe(1);
  expect(progress.at(-1)).toBe(1);
  expect(progress.every((n, i) => n >= 0 && n <= 1 && (i === 0 || n >= progress[i - 1]))).toBe(
    true,
  );
  const total = new Uint8Array(parts.reduce((sum, bytes) => sum + bytes.length, 0));
  let offset = 0;
  for (const bytes of parts) {
    total.set(bytes, offset);
    offset += bytes.length;
  }
  return { files: unzipSync(total), manifest };
}
/** Independent PNG decoder verifies CRC and reconstructs PNG Sub filters. */
function png(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length),
    chunks: Uint8Array[] = [];
  let width = 0,
    height = 0,
    bytesPerPixel = 0;
  for (let offset = 8; offset < bytes.length;) {
    const length = view.getUint32(offset),
      kind = strFromU8(bytes.subarray(offset + 4, offset + 8));
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(offset + 4, offset + 8 + length)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    expect((crc ^ 0xffffffff) >>> 0).toBe(view.getUint32(offset + 8 + length));
    if (kind === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      bytesPerPixel = bytes[offset + 16] === 16 ? 2 : 4;
    }
    if (kind === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const compressed = new Uint8Array(chunks.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of chunks) {
    compressed.set(part, offset);
    offset += part.length;
  }
  const rows = inflateSync(compressed),
    pixels = new Uint8Array(width * height * bytesPerPixel),
    stride = width * bytesPerPixel;
  expect(rows.length).toBe(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    expect(rows[y * (stride + 1)]).toBe(1);
    for (let x = 0; x < stride; x++)
      pixels[y * stride + x] =
        (rows[y * (stride + 1) + 1 + x] +
          (x < bytesPerPixel ? 0 : pixels[y * stride + x - bytesPerPixel])) &
        255;
  }
  return { width, height, bytesPerPixel, pixels };
}

describe('World export contracts', () => {
  it('reports Float32 elevation precision independently of the uint16 range', async () => {
    const value = options();
    value.world.domain.datum = 2 ** 20;
    value.world.domain.heightScale = 1;
    const { manifest } = await collect(value);
    expect(manifest.encoding.quantizationStepMeters).toBe(0.125);
    expect(manifest.encoding.quantization).toContain('Variable IEEE 754 Float32');
    const integer = await collect({ ...value, format: 'raw16' });
    expect(integer.manifest.encoding.quantizationStepMeters).toBe(
      (integer.manifest.encoding.elevationMaxMeters -
        integer.manifest.encoding.elevationMinMeters) /
        65535,
    );
    expect(integer.manifest.encoding.quantization).toContain('Uniform uint16');
  });
  it('rejects ZIP32 file count overflow during preflight', () => {
    const value = options();
    value.samplesX = value.samplesZ = 4096;
    value.tileIntervals = 16;
    value.format = 'png16';
    expect(() => estimateWorldExport(value)).toThrow('ZIP32 file count');
  });
  it('retains final output samples when lattice extent division rounds down', async () => {
    const value = options();
    value.world.domain.cellsX = 9;
    value.world.domain.cellsZ = 11;
    value.samplesX = 29;
    value.samplesZ = 31;
    value.maps = ['normalGL', 'basecolor', 'materialNormalGL'];
    const { files, manifest } = await collect(value);
    for (const tile of manifest.tiles) {
      const height = files[tile.files.find((file) => file.map === 'height')!.path];
      expect(height.length).toBe(tile.samples[0] * tile.samples[1] * 4);
      const values = new Float32Array(height.buffer, height.byteOffset, height.length / 4);
      expect(values.every(Number.isFinite)).toBe(true);
      for (const file of tile.files.filter((file) => file.path.endsWith('.png'))) {
        const decoded = png(files[file.path]);
        expect([decoded.width, decoded.height]).toEqual(tile.samples);
      }
    }
  });
  it('streams compact multi-megabyte projects within the actual archive estimate and reloads them', async () => {
    const value = options();
    value.samplesX = value.samplesZ = 16;
    const source = createNode('heightImport', { x: 0, y: 50 }, 'embedded-source');
    source.raster = {
      name: 'Embedded heightmap',
      width: 1536,
      height: 1024,
      format: 'u16le',
      data: encodeSamples(new Uint8Array(1536 * 1024 * 2)),
    };
    value.project.graph.nodes.push(source);
    const { files, manifest } = await collect(value);
    const encoded = files['project.nhterrain.json'];
    expect(encoded.length).toBeGreaterThan(4 * 1048576);
    const text = strFromU8(encoded);
    expect(text).toBe(JSON.stringify(JSON.parse(text)));
    expect(
      parseProject(JSON.parse(text)).graph.nodes.find((node) => node.id === source.id)?.raster,
    ).toEqual(source.raster);
    expect(manifest.memory.archiveBytes).toBeGreaterThan(
      Object.values(files).reduce((sum, bytes) => sum + bytes.length, 0),
    );
  });
  it('rejects an oversized embedded project before evaluating or emitting an archive', async () => {
    const value = options();
    value.project.name = 'x'.repeat(MAX_PROJECT_FILE_BYTES);
    let emitted = 0;
    await expect(
      streamWorldExport(value, () => {
        emitted++;
      }),
    ).rejects.toThrow('32 MiB');
    expect(emitted).toBe(0);
  });
  it('encodes all PBR channels with identical decoded pixels across tile sizes and a data alpha channel', async () => {
    const value = options();
    value.maps = [...WORLD_MATERIAL_MAPS];
    value.project.materialPaint = [
      {
        layer: 'soil',
        radius: 0.2,
        hardness: 0.7,
        strength: 0.8,
        texture: 'grain',
        points: [
          { u: 0.3, v: 0.4 },
          { u: 0.7, v: 0.6 },
        ],
      },
    ];
    const a = await collect(value),
      b = await collect({ ...value, tileIntervals: 32 });
    expect(a.manifest.material?.algorithm).toBe('surface-fabric-4');
    expect(a.manifest.material?.ranges).toEqual(b.manifest.material?.ranges);
    const assemble = (archive: typeof a, map: string) => {
      const output = new Uint8Array(value.samplesX * value.samplesZ * 4);
      for (const tile of archive.manifest.tiles) {
        const file = tile.files.find((file) => file.map === map)!;
        const bytes = archive.files[file.path];
        expect(worldCRC32(bytes)).toBe(file.crc32);
        const pixels = map === 'relief' ? bytes : png(bytes).pixels;
        for (let z = 0; z < tile.samples[1]; z++) {
          const at = ((tile.sampleOffset[1] + z) * value.samplesX + tile.sampleOffset[0]) * 4;
          const row = pixels.subarray(z * tile.samples[0] * 4, (z + 1) * tile.samples[0] * 4);
          output.set(row, at);
        }
      }
      return output;
    };
    for (const map of WORLD_MATERIAL_MAPS) expect(assemble(a, map), map).toEqual(assemble(b, map));
    const splat = assemble(a, 'splat'),
      gl = assemble(a, 'materialNormalGL'),
      dx = assemble(a, 'materialNormalDX');
    for (let i = 0; i < splat.length; i += 4) {
      expect(splat[i] + splat[i + 1] + splat[i + 2] + splat[i + 3]).toBe(255);
      expect(gl[i + 1] + dx[i + 1]).toBe(255);
      expect(gl[i]).toBe(dx[i]);
      expect(gl[i + 2]).toBe(dx[i + 2]);
      expect(gl[i + 3]).toBe(255);
    }
    expect(splat.some((v, i) => i % 4 === 3 && v < 255)).toBe(true);
  });

  it('reports actual tile completions separately for range, encoding and authored masks', async () => {
    const value = options();
    const mask = createNode('mask', { x: 200, y: 200 }, 'progress-mask');
    value.project.graph.nodes.push(mask);
    value.project.graph.edges.push({
      id: 'mask-edge',
      source: value.project.graph.nodes[0].id,
      target: mask.id,
      sourceHandle: 'height',
      targetHandle: 'in',
    });
    value.masks = [{ nodeId: mask.id, name: 'Coverage' }];
    const reports: WorldExportProgress[] = [];
    const manifest = await streamWorldExport(
      value,
      () => {},
      (_progress, _stage, detail) => {
        if (detail) reports.push(detail);
      },
    );
    const count = manifest.tiles.length;
    for (const phase of ['range', 'encode', 'masks'] as const) {
      const completed = reports.filter((report) => report.phase === phase);
      expect(completed.map((report) => report.completed)).toEqual(
        Array.from({ length: count + 1 }, (_, i) => i),
      );
      expect(completed.every((report) => report.total === count && report.unit === 'tiles')).toBe(
        true,
      );
    }
    expect(
      reports
        .filter((report) => report.phase === 'prepare')
        .every((report) => report.total === undefined),
    ).toBe(true);
    expect(reports.at(-1)).toEqual({ phase: 'archive', completed: 1, total: 1 });
  });
  it('reassembles partial rectangular RAW tiles exactly with common canonical samples and checksums', async () => {
    const value = options(),
      { files, manifest } = await collect(value);
    const oracle = await generateWorldRegion(value.project, value.world, {
      startX: 0,
      startZ: 0,
      cellsX: 64,
      cellsZ: 48,
      samplesX: value.samplesX,
      samplesZ: value.samplesZ,
      outputCellsX: value.samplesX - 1,
      outputCellsZ: value.samplesZ - 1,
    });
    const stitched = new Float32Array(value.samplesX * value.samplesZ),
      writes = new Uint8Array(stitched.length);
    for (const tile of manifest.tiles) {
      const entry = tile.files.find((file) => file.map === 'height')!,
        bytes = files[entry.path],
        raw = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
      expect(worldCRC32(bytes)).toBe(entry.crc32);
      expect(bytes.length).toBe(tile.samples[0] * tile.samples[1] * 4);
      for (let z = 0; z < tile.samples[1]; z++)
        for (let x = 0; x < tile.samples[0]; x++) {
          const global = (tile.sampleOffset[1] + z) * value.samplesX + tile.sampleOffset[0] + x;
          const sample = raw.getFloat32((z * tile.samples[0] + x) * 4, true);
          if (writes[global]) expect(sample, 'duplicate border bytes').toBe(stitched[global]);
          expect(sample).toBe(
            Math.fround(
              value.world.domain.datum + oracle.heights[global] * value.world.domain.heightScale,
            ),
          );
          stitched[global] = sample;
          writes[global]++;
        }
    }
    expect(writes.every((n) => n > 0)).toBe(true);
    expect(manifest.build).toMatchObject({ revision: 'unknown', dirty: null, source: 'unknown' });
    expect(manifest.dimensions.samples).toEqual([35, 29]);
    expect(manifest.dimensions.sampleSpacingMeters).toEqual([1300 / 34, 750 / 28]);
    expect(manifest.stages.every((stage) => stage.mode === 'native')).toBe(true);
    expect(manifest.stages.find((stage) => stage.kind === 'terrace')?.samplesX).toBe(35);
    expect(JSON.parse(strFromU8(files['project.nhterrain.json'])).world).toEqual(value.world);
    expect(JSON.parse(strFromU8(files['manifest.json']))).toEqual(manifest);
  });
  it('shares one PNG16 range and identical physical normals across all internal tile edges', async () => {
    const value = {
      ...options(),
      format: 'png16' as const,
      samplesX: 33,
      samplesZ: 33,
      normals: true,
      diagnostics: true,
    };
    const { files, manifest } = await collect(value);
    const range = manifest.encoding.elevationMaxMeters - manifest.encoding.elevationMinMeters;
    const normalTiles = new Map<string, ReturnType<typeof png>>();
    for (const tile of manifest.tiles) {
      const height = png(files[tile.files.find((file) => file.map === 'height')!.path]);
      const oracle = await generateWorldRegion(value.project, value.world, {
        startX: (tile.sampleOffset[0] / 32) * 64,
        startZ: (tile.sampleOffset[1] / 32) * 48,
        cellsX: ((tile.samples[0] - 1) / 32) * 64,
        cellsZ: ((tile.samples[1] - 1) / 32) * 48,
        samplesX: tile.samples[0],
        samplesZ: tile.samples[1],
        outputCellsX: 32,
        outputCellsZ: 32,
        outputSampleOffsetX: tile.sampleOffset[0],
        outputSampleOffsetZ: tile.sampleOffset[1],
      });
      const decoded = new DataView(height.pixels.buffer);
      for (let i = 0; i < oracle.heights.length; i++) {
        const restored =
          manifest.encoding.elevationMinMeters + (decoded.getUint16(i * 2) / 65535) * range;
        expect(
          Math.abs(
            restored -
              (value.world.domain.datum + oracle.heights[i] * value.world.domain.heightScale),
          ),
        ).toBeLessThanOrEqual(range / 65535 / 2 + 1e-9);
      }
      normalTiles.set(
        `${tile.x},${tile.z}`,
        png(files[tile.files.find((file) => file.map === 'normalGL')!.path]),
      );
      expect(tile.files.find((file) => file.map === 'slope')).toBeDefined();
    }
    for (const tile of manifest.tiles) {
      const current = normalTiles.get(`${tile.x},${tile.z}`)!,
        east = normalTiles.get(`${tile.x + 1},${tile.z}`),
        south = normalTiles.get(`${tile.x},${tile.z + 1}`);
      if (east)
        for (let y = 0; y < current.height; y++)
          expect(
            current.pixels.slice(
              (y * current.width + current.width - 1) * 4,
              (y * current.width + current.width) * 4,
            ),
          ).toEqual(east.pixels.slice(y * east.width * 4, y * east.width * 4 + 4));
      if (south)
        expect(current.pixels.slice((current.height - 1) * current.width * 4)).toEqual(
          south.pixels.slice(0, south.width * 4),
        );
    }
  });
  it('wraps periodic outer normals and slope with identical opposite-border bytes', async () => {
    const value = { ...options(), normals: true, diagnostics: true, format: 'png16' as const };
    value.world = { ...value.world, domain: { ...value.world.domain, boundary: 'periodic' } };
    const { manifest, files } = await collect(value);
    for (const map of ['height', 'normalGL', 'slope']) {
      const bytesPerPixel = map === 'normalGL' ? 4 : 2;
      const joined = new Uint8Array(value.samplesX * value.samplesZ * bytesPerPixel);
      for (const tile of manifest.tiles) {
        const data = png(files[tile.files.find((file) => file.map === map)!.path]);
        for (let z = 0; z < data.height; z++)
          joined.set(
            data.pixels.subarray(
              z * data.width * bytesPerPixel,
              (z + 1) * data.width * bytesPerPixel,
            ),
            ((tile.sampleOffset[1] + z) * value.samplesX + tile.sampleOffset[0]) * bytesPerPixel,
          );
      }
      expect(joined.slice(0, value.samplesX * bytesPerPixel)).toEqual(
        joined.slice((value.samplesZ - 1) * value.samplesX * bytesPerPixel),
      );
      for (let z = 0; z < value.samplesZ; z++)
        expect(
          joined.slice(
            z * value.samplesX * bytesPerPixel,
            z * value.samplesX * bytesPerPixel + bytesPerPixel,
          ),
        ).toEqual(
          joined.slice(
            (z * value.samplesX + value.samplesX - 1) * bytesPerPixel,
            (z + 1) * value.samplesX * bytesPerPixel,
          ),
        );
    }
    // A regional lattice need not divide the full-world period. Its wrapped
    // one-column halo still preserves the requested derivative footprint.
    await collect({
      ...value,
      samplesX: 17,
      samplesZ: 17,
      region: { startX: 0, startZ: 10, cellsX: 40, cellsZ: 20 },
    });
  });
  it('keeps the final partial-tile normals and slopes seamless on a nonbinary export grid', async () => {
    const value = {
      ...options(),
      samplesX: 98,
      samplesZ: 17,
      tileIntervals: 32,
      normals: true,
      diagnostics: true,
    };
    value.world.domain.cellsX = 101;
    value.project.graph.nodes[0].params.scale = 18;
    const { files, manifest } = await collect(value);
    const before = manifest.tiles.find((tile) => tile.x === 2 && tile.z === 0)!;
    const edge = manifest.tiles.find((tile) => tile.x === 3 && tile.z === 0)!;
    expect(edge.samples[0]).toBe(2);
    for (const map of ['normalGL', 'slope']) {
      const west = png(files[before.files.find((file) => file.map === map)!.path]);
      const east = png(files[edge.files.find((file) => file.map === map)!.path]);
      const bpp = west.bytesPerPixel;
      for (let row = 0; row < west.height; row++)
        expect(
          west.pixels.slice(
            (row * west.width + west.width - 1) * bpp,
            (row + 1) * west.width * bpp,
          ),
        ).toEqual(east.pixels.slice(row * east.width * bpp, (row * east.width + 1) * bpp));
    }
  });
  it('exports selected graph masks with fixed weights and explicit provenance', async () => {
    const value = options(),
      mask = createNode('mask', { x: 4, y: 0 }, 'selection');
    mask.label = 'High slopes';
    mask.params = { mode: 'height', low: 0.2, high: 0.7, softness: 0.1, invert: false };
    value.project.graph.nodes.push(mask);
    value.project.graph.edges.push({
      id: 'mask-input',
      source: 'remap',
      target: mask.id,
      sourceHandle: 'height',
      targetHandle: 'in',
    });
    value.masks = [{ nodeId: mask.id, name: mask.label }];
    const { files, manifest } = await collect(value);
    expect(manifest.maskStages['high-slopes'].at(-1)?.nodeId).toBe('selection');
    for (const stage of manifest.maskStages['high-slopes']) {
      if (stage.mode === 'native') {
        expect(stage.samplesX).toBe(value.samplesX);
        expect(stage.samplesZ).toBe(value.samplesZ);
      }
    }
    for (const tile of manifest.tiles) {
      const entry = tile.files.find((file) => file.map === 'mask:high-slopes')!;
      expect(entry).toBeDefined();
      try {
        expect(png(files[entry.path]).bytesPerPixel).toBe(2);
      } catch (error) {
        throw new Error(entry.path + ': ' + String(error));
      }
    }
  });
  it('keeps region exports in the same world frame and gathers normal context outside the ROI', async () => {
    const value = {
      ...options(),
      samplesX: 17,
      samplesZ: 17,
      normals: true,
      region: { startX: 16, startZ: 12, cellsX: 32, cellsZ: 24 },
    };
    const region = await collect(value);
    const whole = await collect({ ...value, samplesX: 33, samplesZ: 33, region: undefined });
    const tile = region.manifest.tiles[0],
      regionNormal = png(region.files[tile.files.find((file) => file.map === 'normalGL')!.path]);
    const composite = new Uint8Array(33 * 33 * 4);
    for (const t of whole.manifest.tiles) {
      const n = png(whole.files[t.files.find((file) => file.map === 'normalGL')!.path]);
      for (let y = 0; y < t.samples[1]; y++)
        composite.set(
          n.pixels.subarray(y * n.width * 4, (y + 1) * n.width * 4),
          ((t.sampleOffset[1] + y) * 33 + t.sampleOffset[0]) * 4,
        );
    }
    for (let y = 0; y < 17; y++)
      expect(regionNormal.pixels.slice(y * 17 * 4, (y + 1) * 17 * 4)).toEqual(
        composite.slice(((y + 8) * 33 + 8) * 4, ((y + 8) * 33 + 25) * 4),
      );
  });
  it('validates engine grids and reserves archive retention before producing bytes', async () => {
    const value = options();
    expect(() => estimateWorldExport({ ...value, profile: 'unity' })).toThrow('power-of-two');
    expect(() =>
      estimateWorldExport({ ...value, profile: 'unity', samplesX: 1025, samplesZ: 1025 }),
    ).toThrow('16-bit');
    expect(() =>
      estimateWorldExport({ ...value, profile: 'unreal', samplesX: 4096, samplesZ: 4096 }),
    ).toThrow('Unreal');
    const large = {
      ...value,
      samplesX: 8192,
      samplesZ: 8192,
      tileIntervals: 256,
      format: 'raw32' as const,
    };
    expect(() => checkWorldExportBudget(large)).toThrow('streaming file save');
    const file = checkWorldExportBudget({ ...large, sink: 'file' });
    expect(file.retainedArchiveBytes).toBe(0);
    expect(file.peakBytes).toBeLessThan(file.budgetBytes);
    let produced = false;
    await expect(
      streamWorldExport({ ...large, memoryBudgetBytes: 64 * 1048576 }, () => {
        produced = true;
      }),
    ).rejects.toThrow('budget');
    expect(produced).toBe(false);
  });
  it('records actual coarse transport and leaves authored mask weights unaffected', async () => {
    const value = options(),
      mask = createNode('mask', { x: 4, y: 0 }, 'mask');
    value.project.graph.nodes.push(mask);
    value.project.graph.edges.push({
      id: 'mask-source',
      source: 'remap',
      target: 'mask',
      sourceHandle: 'height',
      targetHandle: 'in',
    });
    value.masks = [{ nodeId: 'mask', name: 'Coverage' }];
    const before = await collect(value);
    value.world = {
      ...value.world,
      transport: { ...DEFAULT_WORLD_TRANSPORT, enabled: true, iterations: 2 },
    };
    const after = await collect(value);
    expect(after.manifest.transportBudget?.iterations).toBe(2);
    expect(after.manifest.stages.at(-1)).toMatchObject({
      nodeId: 'world-transport',
      mode: 'reconstructed',
      simulationResolution: 64,
    });
    expect(
      after.manifest.maskStages.coverage.some((stage) => stage.nodeId === 'world-transport'),
    ).toBe(false);
    for (const tile of after.manifest.tiles) {
      const path = tile.files.find((file) => file.map === 'mask:coverage')!.path;
      expect(after.files[path]).toEqual(before.files[path]);
    }
  });
  it('encodes engine profiles with one vertical transform, including a constant terrain', async () => {
    const base = options();
    base.project.graph.nodes[0].params = {
      ...STUDIO_DEFAULTS,
      noiseModel: 'v3',
      amplitude: 0,
      offset: -0.25,
    };
    const unreal = await collect({
      ...base,
      profile: 'unreal',
      format: 'raw16',
      samplesX: 127,
      samplesZ: 127,
    });
    const settings = unreal.manifest.profileSettings;
    const entry = unreal.manifest.tiles[0].files[0];
    expect(entry.path.endsWith('.r16')).toBe(true);
    expect(unreal.files[entry.path].every((byte) => byte === 0)).toBe(true);
    const elevation =
      Number(settings.actorZCentimeters) / 100 -
      (32768 * Number(settings.zScaleCentimeters)) / 12800;
    expect(elevation).toBeCloseTo(unreal.manifest.encoding.elevationMinMeters, 10);
    const unity = await collect({
      ...base,
      profile: 'unity',
      format: 'raw16',
      samplesX: 33,
      samplesZ: 33,
      tileIntervals: 32,
    });
    expect(unity.manifest.tiles[0].files[0].path.endsWith('.raw')).toBe(true);
    expect(unity.manifest.profileSettings.terrainPositionY).toBe(
      unity.manifest.encoding.elevationMinMeters,
    );
    expect(unity.manifest.profileSettings.terrainSizeY).toBe(1);
    expect(unity.manifest.importQualification).toContain('not yet verified');
  });
  it('stops an awaited sink without publishing a complete archive when cancelled', async () => {
    const controller = new AbortController();
    let completed = false;
    await expect(
      streamWorldExport(
        options(),
        (_bytes, final) => {
          completed ||= final;
          controller.abort();
        },
        () => {},
        controller.signal,
      ),
    ).rejects.toThrow('cancelled');
    expect(completed).toBe(false);
  });
});
