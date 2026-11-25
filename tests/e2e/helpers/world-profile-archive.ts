import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateRawSync, inflateSync } from 'node:zlib';

// Deliberately independent of the production exporter and fflate: read the ZIP
// central directory, validate both container checksums, and undo PNG filters
// using Node's zlib decoder. Only one small tile is inflated at a time.
const CRC_NIBBLES = [
  0x00000000, 0x1db71064, 0x3b6e20c8, 0x26d930ac, 0x76dc4190, 0x6b6b51f4, 0x4db26158, 0x5005713c,
  0xedb88320, 0xf00f9344, 0xd6d6a3e8, 0xcb61b38c, 0x9b64c2b0, 0x86d3d2d4, 0xa00ae278, 0xbdbdf21c,
];

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    crc = (crc >>> 4) ^ CRC_NIBBLES[crc & 15];
    crc = (crc >>> 4) ^ CRC_NIBBLES[crc & 15];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipEntries(archive: Buffer) {
  let end = archive.length - 22;
  for (; end >= Math.max(0, archive.length - 65557); end--) {
    if (
      archive.readUInt32LE(end) === 0x06054b50 &&
      end + 22 + archive.readUInt16LE(end + 20) === archive.length
    )
      break;
  }
  assert(end >= Math.max(0, archive.length - 65557), 'ZIP end directory is missing');
  assert.equal(archive.readUInt16LE(end + 4), 0, 'ZIP disk number');
  assert.equal(archive.readUInt16LE(end + 6), 0, 'ZIP central directory disk');
  const count = archive.readUInt16LE(end + 10);
  assert.equal(archive.readUInt16LE(end + 8), count, 'ZIP split archive');
  assert(count > 0 && count < 65535, 'Expected an ordinary nonempty ZIP');
  const directory = archive.readUInt32LE(end + 16);
  assert.equal(directory + archive.readUInt32LE(end + 12), end, 'ZIP directory bounds');
  const entries = new Map<string, Buffer>();
  let offset = directory;
  for (let index = 0; index < count; index++) {
    assert(offset + 46 <= end, 'Truncated ZIP central entry');
    assert.equal(archive.readUInt32LE(offset), 0x02014b50, 'ZIP central entry signature');
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const rawSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const entryEnd =
      offset +
      46 +
      nameLength +
      archive.readUInt16LE(offset + 30) +
      archive.readUInt16LE(offset + 32);
    assert(entryEnd <= end, 'ZIP central entry exceeds directory');
    const name = archive.toString('utf8', offset + 46, offset + 46 + nameLength);
    assert(
      name.length > 0 &&
        !name.startsWith('/') &&
        !name.includes('\\') &&
        !name.split('/').includes('..'),
      'Unsafe ZIP path',
    );
    assert(!entries.has(name), `Duplicate ZIP path: ${name}`);
    assert.equal(flags & 1, 0, 'Encrypted ZIP entry');
    assert(method === 0 || method === 8, 'Unsupported ZIP compression');
    const local = archive.readUInt32LE(offset + 42);
    assert(local + 30 <= directory, 'ZIP local header bounds');
    assert.equal(archive.readUInt32LE(local), 0x04034b50, 'ZIP local header signature');
    assert.equal(archive.readUInt16LE(local + 6), flags, 'ZIP flag mismatch');
    assert.equal(archive.readUInt16LE(local + 8), method, 'ZIP compression mismatch');
    const localNameLength = archive.readUInt16LE(local + 26);
    assert.equal(
      archive.toString('utf8', local + 30, local + 30 + localNameLength),
      name,
      'ZIP filename mismatch',
    );
    const start = local + 30 + localNameLength + archive.readUInt16LE(local + 28);
    assert(start + compressedSize <= directory, 'ZIP entry exceeds payload');
    const compressed = archive.subarray(start, start + compressedSize);
    const data =
      method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: rawSize + 1 });
    assert.equal(data.length, rawSize, `ZIP uncompressed size: ${name}`);
    assert.equal(crc32(data), archive.readUInt32LE(offset + 16), `ZIP CRC32: ${name}`);
    entries.set(name, data);
    offset = entryEnd;
  }
  assert.equal(offset, end, 'ZIP directory length');
  return entries;
}

function paeth(left: number, above: number, upperLeft: number) {
  const p = left + above - upperLeft;
  const dl = Math.abs(p - left),
    da = Math.abs(p - above),
    du = Math.abs(p - upperLeft);
  return dl <= da && dl <= du ? left : da <= du ? above : upperLeft;
}

function png16(bytes: Buffer, expectedWidth: number, expectedHeight: number) {
  assert.deepEqual(
    bytes.subarray(0, 8),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    'PNG signature',
  );
  const parts: Buffer[] = [];
  let offset = 8,
    chunks = 0,
    ended = false;
  for (; offset < bytes.length;) {
    assert(offset + 12 <= bytes.length, 'Truncated PNG chunk');
    const length = bytes.readUInt32BE(offset);
    assert(offset + length + 12 <= bytes.length, 'PNG chunk bounds');
    const kind = bytes.toString('ascii', offset + 4, offset + 8);
    assert.equal(
      crc32(bytes.subarray(offset + 4, offset + 8 + length)),
      bytes.readUInt32BE(offset + 8 + length),
      `PNG ${kind} CRC32`,
    );
    if (chunks === 0) assert.equal(kind, 'IHDR', 'PNG first chunk');
    if (kind === 'IHDR') {
      assert.equal(chunks, 0, 'Repeated PNG header');
      assert.equal(length, 13, 'PNG header length');
      assert.equal(bytes.readUInt32BE(offset + 8), expectedWidth, 'PNG width');
      assert.equal(bytes.readUInt32BE(offset + 12), expectedHeight, 'PNG height');
      assert.deepEqual(
        Array.from(bytes.subarray(offset + 16, offset + 21)),
        [16, 0, 0, 0, 0],
        'Expected noninterlaced grayscale PNG16',
      );
    } else if (kind === 'IDAT') parts.push(bytes.subarray(offset + 8, offset + 8 + length));
    else if (kind === 'IEND') {
      assert.equal(length, 0, 'PNG end length');
      ended = true;
    }
    chunks++;
    offset += length + 12;
    if (ended) break;
  }
  assert(ended && parts.length > 0, 'Incomplete PNG');
  assert.equal(offset, bytes.length, 'Trailing PNG data');
  const stride = expectedWidth * 2;
  const expectedLength = expectedHeight * (stride + 1);
  const rows = inflateSync(Buffer.concat(parts), { maxOutputLength: expectedLength + 1 });
  assert.equal(rows.length, expectedLength, 'PNG decoded scanline length');
  const pixels = Buffer.allocUnsafe(expectedWidth * expectedHeight * 2);
  const filterCounts = [0, 0, 0, 0, 0];
  for (let y = 0; y < expectedHeight; y++) {
    const filter = rows[y * (stride + 1)];
    assert(filter <= 4, 'Unknown PNG row filter');
    filterCounts[filter]++;
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x;
      const left = x < 2 ? 0 : pixels[at - 2];
      const above = y === 0 ? 0 : pixels[at - stride];
      const upperLeft = y === 0 || x < 2 ? 0 : pixels[at - stride - 2];
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? above
              : filter === 3
                ? Math.floor((left + above) / 2)
                : paeth(left, above, upperLeft);
      pixels[at] = (rows[y * (stride + 1) + x + 1] + predictor) & 255;
    }
  }
  return { pixels, chunks, filterCounts };
}

interface Tile {
  x: number;
  z: number;
  sampleOffset: [number, number];
  samples: [number, number];
  originMeters: [number, number];
  files: { path: string; map: string; format: string; bytes: number; crc32: string }[];
}

interface Manifest {
  application: string;
  manifestVersion: number;
  build: Record<string, unknown>;
  projectSeed: number;
  profile: string;
  backend: string;
  dimensions: {
    samples: [number, number];
    intervals: [number, number];
    widthMeters: number;
    depthMeters: number;
    sampleSpacingMeters: [number, number];
    originMeters: [number, number];
  };
  encoding: {
    heightFormat: string;
    elevationMinMeters: number;
    elevationMaxMeters: number;
    quantizationStepMeters: number;
  };
  stages: { kind: string; mode: string; backend: string; samplesX: number; samplesZ: number }[];
  memory: { tileIntervals: number; tileCount: number; [key: string]: unknown };
  approximation: string;
  tiles: Tile[];
}

export function verifyWorldProfileArchive(
  input: Uint8Array,
  expected: { samples: number; seed: number; stageKinds: string[] },
) {
  const archive = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const entries = zipEntries(archive);
  const manifestFile = entries.get('manifest.json');
  assert(manifestFile, 'Missing world manifest');
  const manifest = JSON.parse(manifestFile.toString('utf8')) as Manifest;
  const n = expected.samples;
  assert.equal(manifest.application, 'Normal Height World Engine');
  assert.equal(manifest.manifestVersion, 1);
  assert.equal(manifest.projectSeed, expected.seed);
  assert.equal(manifest.backend, 'cpu-reference');
  assert.equal(manifest.profile, 'generic');
  assert.deepEqual(manifest.dimensions.samples, [n, n]);
  assert.deepEqual(manifest.dimensions.intervals, [n - 1, n - 1]);
  assert.equal(manifest.encoding.heightFormat, 'png16');
  assert(
    manifest.encoding.elevationMaxMeters > manifest.encoding.elevationMinMeters,
    'The fixture must have nonconstant terrain',
  );
  assert.equal(
    manifest.encoding.quantizationStepMeters,
    (manifest.encoding.elevationMaxMeters - manifest.encoding.elevationMinMeters) / 65535,
  );
  for (const kind of expected.stageKinds)
    assert(
      manifest.stages.some((stage) => stage.kind === kind),
      `Missing ${kind} stage`,
    );
  assert(
    manifest.stages.every(
      (stage) =>
        stage.mode === 'native' &&
        stage.backend === 'cpu-reference' &&
        stage.samplesX === n &&
        stage.samplesZ === n,
    ),
    'Expected genuinely native CPU sampling at the requested export grid',
  );
  const tileIntervals = manifest.memory.tileIntervals;
  assert(Number.isSafeInteger(tileIntervals) && tileIntervals >= 16 && tileIntervals <= 512);
  const across = Math.ceil((n - 1) / tileIntervals);
  assert.equal(manifest.tiles.length, across ** 2);
  assert.equal(manifest.memory.tileCount, across ** 2);
  const projectFile = entries.get('project.nhterrain.json');
  assert(projectFile && entries.has('README.txt'), 'Missing portable project or import notes');
  const portable = JSON.parse(projectFile.toString('utf8'));
  assert.equal(portable.version, 2);
  assert.equal(portable.seed, expected.seed);
  assert.equal(portable.world.backend, 'cpu-reference');
  assert.equal(
    portable.graph.nodes.find((node: { kind: string }) => node.kind === 'noise')?.params.noiseModel,
    'v3',
  );

  const borders = new Map<string, { east: Uint16Array; south: Uint16Array }>();
  const paths = new Set<string>();
  const codes = new Uint8Array(65536);
  const rawHash = createHash('sha256');
  const filterCounts = [0, 0, 0, 0, 0];
  let pngChunks = 0,
    decodedSamples = 0,
    coveredSamples = 0,
    sharedEdgeComparisons = 0,
    sharedEdges = 0,
    non8BitSamples = 0;
  for (const tile of [...manifest.tiles].sort((a, b) => a.z - b.z || a.x - b.x)) {
    assert(Number.isSafeInteger(tile.x) && tile.x >= 0 && tile.x < across);
    assert(Number.isSafeInteger(tile.z) && tile.z >= 0 && tile.z < across);
    const key = `${tile.x},${tile.z}`;
    assert(!borders.has(key), `Duplicate tile ${key}`);
    const [x0, z0] = [tile.x * tileIntervals, tile.z * tileIntervals];
    assert.deepEqual(tile.sampleOffset, [x0, z0], `Canonical tile offset ${key}`);
    const width = Math.min(tileIntervals, n - 1 - x0) + 1;
    const height = Math.min(tileIntervals, n - 1 - z0) + 1;
    assert.deepEqual(tile.samples, [width, height], `Partial edge tile dimensions ${key}`);
    for (const axis of [0, 1] as const) {
      const extent = axis === 0 ? manifest.dimensions.widthMeters : manifest.dimensions.depthMeters;
      const spacing = extent / (n - 1);
      assert(
        Number.isFinite(extent) &&
          extent > 0 &&
          Number.isFinite(manifest.dimensions.originMeters[axis]),
      );
      assert(
        Math.abs(manifest.dimensions.sampleSpacingMeters[axis] - spacing) <
          Math.max(1, Math.abs(spacing)) * 1e-12,
        'Physical grid spacing',
      );
      const origin = manifest.dimensions.originMeters[axis] + tile.sampleOffset[axis] * spacing;
      assert(
        Math.abs(tile.originMeters[axis] - origin) < Math.max(1, Math.abs(origin)) * 1e-12,
        'Physical tile origin',
      );
    }
    assert.equal(tile.files.length, 1, 'Only the requested height map should be present');
    const file = tile.files[0];
    assert.equal(file.map, 'height');
    assert.equal(file.format, 'png16');
    assert(!paths.has(file.path), 'Repeated tile filename');
    paths.add(file.path);
    const bytes = entries.get(file.path);
    assert(bytes, `Missing tile ${file.path}`);
    assert.equal(bytes.length, file.bytes, 'Manifest file size');
    assert.equal(crc32(bytes).toString(16).padStart(8, '0'), file.crc32, 'Manifest file CRC32');
    const decoded = png16(bytes, width, height);
    pngChunks += decoded.chunks;
    decoded.filterCounts.forEach((count, filter) => {
      filterCounts[filter] += count;
    });
    rawHash.update(decoded.pixels);
    const north = new Uint16Array(width),
      south = new Uint16Array(width);
    const west = new Uint16Array(height),
      east = new Uint16Array(height);
    for (let row = 0; row < height; row++) {
      for (let column = 0; column < width; column++) {
        const value = decoded.pixels.readUInt16BE((row * width + column) * 2);
        codes[value] = 1;
        if (value % 257 !== 0) non8BitSamples++;
        if (row === 0) north[column] = value;
        if (row === height - 1) south[column] = value;
        if (column === 0) west[row] = value;
        if (column === width - 1) east[row] = value;
      }
    }
    const match = (a: Uint16Array, b: Uint16Array, side: string) => {
      assert.equal(a.length, b.length, `Shared ${side} border length ${key}`);
      for (let i = 0; i < a.length; i++)
        assert.equal(a[i], b[i], `Shared ${side} border ${key} sample ${i}`);
      sharedEdgeComparisons += a.length;
      sharedEdges++;
    };
    if (tile.x > 0) match(borders.get(`${tile.x - 1},${tile.z}`)!.east, west, 'east/west');
    if (tile.z > 0) match(borders.get(`${tile.x},${tile.z - 1}`)!.south, north, 'north/south');
    borders.set(key, { east, south });
    decodedSamples += width * height;
    coveredSamples += (width - (tile.x > 0 ? 1 : 0)) * (height - (tile.z > 0 ? 1 : 0));
  }
  assert.equal(coveredSamples, n ** 2, 'Whole grid coverage without duplicate borders');
  assert.equal(decodedSamples, (n + across - 1) ** 2, 'Stored grid including shared endpoints');
  assert.equal(sharedEdges, 2 * across * (across - 1));
  assert.equal(sharedEdgeComparisons, 2 * (across - 1) * (n + across - 1));
  assert.equal(entries.size, paths.size + 3, 'Unexpected or unverified archive entries');
  const usedCodes = codes.reduce((sum, present) => sum + present, 0);
  assert(
    usedCodes > 256 && non8BitSamples > 0,
    '16-bit samples must carry more than 8-bit precision',
  );
  assert.equal(codes[0], 1, 'Common range minimum should be encoded exactly');
  assert.equal(codes[65535], 1, 'Common range maximum should be encoded exactly');
  return {
    archiveBytes: archive.length,
    archiveSha256: createHash('sha256').update(archive).digest('hex'),
    decodedPixelsSha256: rawHash.digest('hex'),
    decodedHashOrder:
      'Tile row-major; each tile row-major, big-endian grayscale16; shared samples included.',
    verifiedZipEntries: entries.size,
    verifiedPngFiles: paths.size,
    verifiedPngChunks: pngChunks,
    filterRowCounts: filterCounts,
    tileGrid: [across, across],
    tileIntervals,
    uniqueSamplesCovered: coveredSamples,
    decodedSamplesIncludingBorders: decodedSamples,
    exactSharedEdges: sharedEdges,
    exactSharedBorderSampleComparisons: sharedEdgeComparisons,
    distinct16BitValues: usedCodes,
    samplesNotRepresentableByReplicated8Bit: non8BitSamples,
    encodedRange: [0, 65535],
    manifest: {
      build: manifest.build,
      backend: manifest.backend,
      dimensions: manifest.dimensions,
      encoding: manifest.encoding,
      stages: manifest.stages,
      memoryEstimate: manifest.memory,
      approximation: manifest.approximation,
    },
  };
}
