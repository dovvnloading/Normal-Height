// Real CPU World export and independent PNG/ZIP verification.
// npm ci; node scripts/world-export-profile.mjs 4096,8192 /absolute/output-directory
// Archives are written outside git by default; the JSON report is reproducible.
import { createServer } from 'vite';
import { createReadStream, createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cpus, platform, release } from 'node:os';
import { inflateSync } from 'node:zlib';
import { Unzip, UnzipInflate, strFromU8 } from 'fflate';

const resolutions = (process.argv[2] || '1024').split(',').map(Number);
if (resolutions.some((n) => !Number.isInteger(n) || n < 16 || n > 8192))
  throw new Error('Use comma-separated dimensions from 16 through 8192.');
const output = resolve(process.argv[3] || '../world-engine-exports');
mkdirSync(output, { recursive: true });
const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});
const { streamWorldExport, worldCRC32 } = await server.ssrLoadModule('/src/export/worldExport.ts');
const { createNode } = await server.ssrLoadModule('/src/model/registry.ts');
const { STUDIO_DEFAULTS } = await server.ssrLoadModule('/src/model/noiseStudio.ts');
const { createWorldDefinition } = await server.ssrLoadModule('/src/model/world.ts');
const { BUILD_INFO } = await server.ssrLoadModule('/src/model/buildInfo.ts');
const source = createNode('noise', { x: 0, y: 0 }, 'source');
source.params = {
  ...STUDIO_DEFAULTS,
  noiseModel: 'v3',
  kernel: 'perlin',
  fractal: 'none',
  scale: 8.4,
  seed: 713,
  sampling: 'point',
  rotation: 17,
  amplitude: 1,
  offset: 0,
};
const remap = createNode('remap', { x: 200, y: 0 }, 'remap');
remap.params = { contrast: 1.2, brightness: -0.05, gamma: 1.15, clamp: false };
const terrace = createNode('terrace', { x: 400, y: 0 }, 'terrace');
terrace.params = { steps: 19, softness: 0.75 };
const final = createNode('output', { x: 600, y: 0 }, 'output');
const nodes = [source, remap, terrace, final];
const project = {
  version: 1,
  name: 'World native graph benchmark',
  seed: 24062,
  resolution: 256,
  worldSize: 12000,
  heightScale: 1800,
  presetId: 'custom',
  graph: {
    nodes,
    edges: nodes
      .slice(1)
      .map((node, i) => ({
        id: `edge-${i}`,
        source: nodes[i].id,
        target: node.id,
        sourceHandle: 'height',
        targetHandle: 'in',
      })),
  },
};
const world = createWorldDefinition(project);
world.domain.cellsX = world.domain.cellsZ = 8192;
world.tileCells = 256;
world.globalResolution = 64;

async function entries(path, callback) {
  let failure;
  const unzip = new Unzip((file) => {
    const parts = [];
    let length = 0;
    file.ondata = (error, data, last) => {
      if (error) {
        failure = error;
        return;
      }
      parts.push(data);
      length += data.length;
      if (last) {
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const part of parts) {
          bytes.set(part, offset);
          offset += part.length;
        }
        try {
          callback(file.name, bytes);
        } catch (error) {
          failure = error;
        }
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for await (const part of createReadStream(path)) {
    unzip.push(new Uint8Array(part));
    if (failure) throw failure;
  }
  unzip.push(new Uint8Array(), true);
  if (failure) throw failure;
}
function png16(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    parts = [];
  let width = 0,
    height = 0,
    length = 0;
  for (let offset = 8; offset < bytes.length;) {
    const n = view.getUint32(offset),
      kind = strFromU8(bytes.subarray(offset + 4, offset + 8));
    if (kind === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      if (bytes[offset + 16] !== 16 || bytes[offset + 17] !== 0)
        throw new Error('Expected grayscale PNG16.');
    } else if (kind === 'IDAT') {
      const part = bytes.subarray(offset + 8, offset + 8 + n);
      parts.push(part);
      length += n;
    }
    offset += n + 12;
  }
  const compressed = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    compressed.set(part, offset);
    offset += part.length;
  }
  const rows = inflateSync(compressed),
    values = new Uint16Array(width * height);
  if (rows.length !== height * (width * 2 + 1)) throw new Error('Invalid decoded PNG dimensions.');
  for (let z = 0; z < height; z++) {
    const row = rows.subarray(z * (width * 2 + 1), (z + 1) * (width * 2 + 1));
    if (row[0] !== 1) throw new Error('Unexpected PNG filter.');
    let hi = 0,
      lo = 0;
    for (let x = 0; x < width; x++) {
      hi = (hi + row[1 + x * 2]) & 255;
      lo = (lo + row[2 + x * 2]) & 255;
      values[z * width + x] = hi * 256 + lo;
    }
  }
  return { width, height, values };
}
const report = {
  createdAt: new Date().toISOString(),
  build: BUILD_INFO,
  runtime: process.version,
  system: `${platform()} ${release()}`,
  cpu: cpus()[0]?.model,
  backend: 'cpu-reference',
  measurement:
    'Node/Vite SSR execution. Process RSS includes the runtime, compiler and fixture verification; not browser heap or GPU memory.',
  fixture: { project, world },
  results: [],
};
try {
  for (const n of resolutions) {
    const path = join(output, `native-full-graph-${n}.zip`),
      sink = createWriteStream(path);
    let byteCount = 0,
      peakRSS = process.memoryUsage().rss,
      peakHeap = process.memoryUsage().heapUsed,
      previousPercent = -1;
    const begin = performance.now();
    const manifest = await streamWorldExport(
      {
        project,
        world,
        samplesX: n,
        samplesZ: n,
        format: 'png16',
        profile: 'generic',
        sink: 'file',
      },
      async (bytes) => {
        byteCount += bytes.length;
        await new Promise((resolve, reject) =>
          sink.write(bytes, (error) => (error ? reject(error) : resolve())),
        );
      },
      (progress, stage) => {
        const mem = process.memoryUsage();
        peakRSS = Math.max(peakRSS, mem.rss);
        peakHeap = Math.max(peakHeap, mem.heapUsed);
        const percent = Math.floor(progress * 10) * 10;
        if (percent !== previousPercent) {
          previousPercent = percent;
          process.stdout.write(`${n}: ${percent}% ${stage}\n`);
        }
      },
    );
    await new Promise((resolve, reject) =>
      sink.end((error) => (error ? reject(error) : resolve())),
    );
    const elapsedMs = performance.now() - begin;
    const files = new Map(
      manifest.tiles.flatMap((tile) => tile.files.map((file) => [file.path, { tile, file }])),
    );
    const borders = new Map();
    let decodedSamples = 0,
      verifiedFiles = 0,
      sharedEdgeComparisons = 0;
    const verifyBegin = performance.now();
    await entries(path, (name, bytes) => {
      const expected = files.get(name);
      if (!expected) return;
      if (bytes.length !== expected.file.bytes || worldCRC32(bytes) !== expected.file.crc32)
        throw new Error(`Checksum mismatch: ${name}`);
      const decoded = png16(bytes),
        { tile } = expected;
      if (decoded.width !== tile.samples[0] || decoded.height !== tile.samples[1])
        throw new Error(`Tile dimension mismatch: ${name}`);
      const north = decoded.values.slice(0, decoded.width),
        south = decoded.values.slice((decoded.height - 1) * decoded.width);
      const west = Uint16Array.from(
        { length: decoded.height },
        (_, i) => decoded.values[i * decoded.width],
      );
      const east = Uint16Array.from(
        { length: decoded.height },
        (_, i) => decoded.values[i * decoded.width + decoded.width - 1],
      );
      const match = (a, b) => {
        if (a.length !== b.length || a.some((value, i) => value !== b[i]))
          throw new Error(`Shared border mismatch: ${name}`);
        sharedEdgeComparisons += a.length;
      };
      const left = borders.get(`${tile.x - 1},${tile.z}`),
        above = borders.get(`${tile.x},${tile.z - 1}`);
      if (left) match(left.east, west);
      if (above) match(above.south, north);
      borders.set(`${tile.x},${tile.z}`, { east, south });
      decodedSamples += decoded.values.length;
      verifiedFiles++;
    });
    const result = {
      samples: [n, n],
      elapsedMs,
      archiveBytes: byteCount,
      peakProcessRSSBytes: peakRSS,
      peakHeapBytes: peakHeap,
      estimate: manifest.memory,
      verificationMs: performance.now() - verifyBegin,
      verifiedFiles,
      decodedSamples,
      sharedEdgeComparisons,
      exactGridReassembled: verifiedFiles === manifest.tiles.length,
      allStageModes: [...new Set(manifest.stages.map((stage) => stage.mode))],
      stages: manifest.stages,
      elevationMinMeters: manifest.encoding.elevationMinMeters,
      elevationMaxMeters: manifest.encoding.elevationMaxMeters,
      quantizationStepMeters: manifest.encoding.quantizationStepMeters,
    };
    report.results.push(result);
    writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
    process.stdout.write(
      `${n}: complete in ${(elapsedMs / 1000).toFixed(2)} s; ${verifiedFiles} PNG tiles independently decoded; ${sharedEdgeComparisons} exact border comparisons.\n`,
    );
  }
} finally {
  await server.close();
}
