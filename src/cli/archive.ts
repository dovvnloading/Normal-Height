import { constants, createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createInflateRaw } from 'node:zlib';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MAX_PROJECT_FILE_BYTES } from '../model/heightRaster';
import { parseProject } from '../model/project';
import { canonical } from '../engine/plan/graph';
import type { WorldExportManifest } from '../export/worldExport';
import { GENESIS_ALGORITHM_VERSION, GENESIS_LITHOLOGIES } from '../model/genesis';
import { genesisGridSize } from '../engine/genesis';
import { isGenesisReport } from '../engine/genesis/report';
import {
  genesisMapDescriptor,
  isWorldGenesisMap,
  type WorldGenesisMap,
} from '../export/genesisExport';

const MiB = 1024 * 1024;
const ARCHIVE_LIMIT = 2 ** 31 - 1;
const ENTRY_LIMIT = 64 * MiB;
const MANIFEST_LIMIT = 16 * MiB;
const MAX_ENTRIES = 65534;
const decoder = new TextDecoder('utf-8', { fatal: true });
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

interface Entry {
  path: string;
  size: number;
  compressed: number;
  method: number;
  flags: number;
  crc: number;
  offset: number;
  dataStart: number;
  recordEnd: number;
}
export interface ArchiveVerification {
  archiveBytes: number;
  expandedBytes: number;
  files: number;
  tiles: number;
  verifiedMapFiles: number;
  dimensions: [number, number];
  profile: string;
  build: WorldExportManifest['build'];
  importQualification: string;
  warnings: string[];
}
export interface VerifyOptions {
  maxExpandedBytes?: number;
  signal?: AbortSignal;
}

function check(signal?: AbortSignal) {
  signal?.throwIfAborted();
}
function fail(message: string): never {
  throw new Error(`Archive verification failed: ${message}`);
}
async function readAt(file: FileHandle, length: number, position: number) {
  const data = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await file.read(data, offset, length - offset, position + offset);
    if (!bytesRead) fail('truncated ZIP record.');
    offset += bytesRead;
  }
  return data;
}
function validPath(value: string) {
  return /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}
function json(bytes: Buffer, name: string): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return fail(`${name} is not valid UTF-8 JSON.`);
  }
}
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${name} must be an object.`);
  return value as Record<string, unknown>;
}
function positivePair(value: unknown, name: string): [number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((n) => Number.isSafeInteger(n) && n >= 2 && n <= 8193)
  )
    fail(`invalid ${name}.`);
  return value as [number, number];
}

/** Read the bounded central directory before any decompression. Never extract
 * paths to disk, trust local data-descriptor sizes, or allocate the whole ZIP. */
async function directory(
  file: FileHandle,
  bytes: number,
  maxExpanded: number,
  signal?: AbortSignal,
) {
  if (bytes < 22 || bytes > ARCHIVE_LIMIT)
    fail('expected a ZIP archive below the 2 GiB profile limit.');
  const tailLength = Math.min(bytes, 22 + 65535);
  const tail = await readAt(file, tailLength, bytes - tailLength);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
      end = i;
      break;
    }
  }
  if (end < 0) fail('missing ZIP end-of-directory record.');
  const count = tail.readUInt16LE(end + 10);
  const centralSize = tail.readUInt32LE(end + 12);
  const centralOffset = tail.readUInt32LE(end + 16);
  if (
    tail.readUInt16LE(end + 4) ||
    tail.readUInt16LE(end + 6) ||
    tail.readUInt16LE(end + 8) !== count
  )
    fail('split archives are unsupported.');
  if (!count || count > MAX_ENTRIES || centralSize === 0xffffffff || centralOffset === 0xffffffff)
    fail('empty archives and ZIP64 are outside the supported profile.');
  if (centralOffset + centralSize !== bytes - tailLength + end)
    fail('central-directory bounds do not match the archive.');
  const entries: Entry[] = [];
  const names = new Set<string>();
  let offset = centralOffset;
  let expanded = 0;
  for (let index = 0; index < count; index++) {
    check(signal);
    if (offset + 46 > centralOffset + centralSize) fail('truncated central directory.');
    const header = await readAt(file, 46, offset);
    if (header.readUInt32LE(0) !== 0x02014b50) fail('invalid central-directory signature.');
    const flags = header.readUInt16LE(8);
    const method = header.readUInt16LE(10);
    const compressed = header.readUInt32LE(20);
    const size = header.readUInt32LE(24);
    const nameLength = header.readUInt16LE(28);
    const extraLength = header.readUInt16LE(30);
    const commentLength = header.readUInt16LE(32);
    const localOffset = header.readUInt32LE(42);
    if (flags & 1 || ![0, 8].includes(method)) fail('encrypted or unsupported compression method.');
    if (
      header.readUInt16LE(34) ||
      size === 0xffffffff ||
      compressed === 0xffffffff ||
      localOffset === 0xffffffff
    )
      fail('split and ZIP64 entries are unsupported.');
    if (size > ENTRY_LIMIT || (expanded += size) > maxExpanded)
      fail('expanded data exceeds the configured verification budget.');
    if (method === 0 && size !== compressed) fail('stored-entry sizes disagree.');
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (!nameLength || next > centralOffset + centralSize) fail('invalid entry-name bounds.');
    let path: string;
    try {
      path = decoder.decode(await readAt(file, nameLength, offset + 46));
    } catch {
      fail('entry path is not valid UTF-8.');
    }
    if (!validPath(path) || names.has(path)) fail('unsafe or duplicate entry path.');
    names.add(path);
    if (localOffset + 30 > centralOffset) fail('local header overlaps the central directory.');
    const local = await readAt(file, 30, localOffset);
    if (
      local.readUInt32LE(0) !== 0x04034b50 ||
      local.readUInt16LE(6) !== flags ||
      local.readUInt16LE(8) !== method
    )
      fail(`local header disagrees for ${path}.`);
    const localNameLength = local.readUInt16LE(26);
    const localExtraLength = local.readUInt16LE(28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressed > centralOffset) fail(`entry exceeds its data bounds: ${path}.`);
    const localName = await readAt(file, localNameLength, localOffset + 30);
    if (localNameLength !== nameLength || decoder.decode(localName) !== path)
      fail(`local path disagrees for ${path}.`);
    const crc = header.readUInt32LE(16);
    let recordEnd = dataStart + compressed;
    if (flags & 8) {
      if (recordEnd + 12 > centralOffset) fail(`missing data descriptor: ${path}.`);
      const descriptorHead = await readAt(file, 4, recordEnd);
      const signed = descriptorHead.readUInt32LE(0) === 0x08074b50;
      const descriptorBytes = signed ? 16 : 12;
      if (recordEnd + descriptorBytes > centralOffset) fail(`truncated data descriptor: ${path}.`);
      const descriptor = await readAt(file, descriptorBytes, recordEnd);
      const base = signed ? 4 : 0;
      if (
        descriptor.readUInt32LE(base) !== crc ||
        descriptor.readUInt32LE(base + 4) !== compressed ||
        descriptor.readUInt32LE(base + 8) !== size
      )
        fail(`data descriptor disagrees for ${path}.`);
      recordEnd += descriptorBytes;
    } else if (
      local.readUInt32LE(14) !== crc ||
      local.readUInt32LE(18) !== compressed ||
      local.readUInt32LE(22) !== size
    ) {
      fail(`local checksum or size disagrees for ${path}.`);
    }
    entries.push({
      path,
      size,
      compressed,
      method,
      flags,
      crc,
      offset: localOffset,
      dataStart,
      recordEnd,
    });
    offset = next;
  }
  if (offset !== centralOffset + centralSize) fail('unexpected records in central directory.');
  const physical = [...entries].sort((a, b) => a.offset - b.offset);
  let previousEnd = 0;
  for (const entry of physical) {
    if (entry.offset !== previousEnd) fail('overlapping entries or unreferenced archive data.');
    previousEnd = entry.recordEnd;
  }
  if (previousEnd !== centralOffset) fail('unreferenced data before central directory.');
  return { entries, expanded };
}

async function verifyEntry(file: FileHandle, entry: Entry, retain: boolean, signal?: AbortSignal) {
  const limit =
    entry.path === 'manifest.json'
      ? MANIFEST_LIMIT
      : entry.path === 'project.nhterrain.json'
        ? MAX_PROJECT_FILE_BYTES
        : ENTRY_LIMIT;
  if (entry.size > limit) fail(`${entry.path} exceeds its file-size limit.`);
  let crc = 0xffffffff;
  let size = 0;
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        check(signal);
        size += chunk.length;
        if (size > entry.size || size > limit)
          fail(`decompressed size exceeds the declaration: ${entry.path}.`);
        for (const value of chunk) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8);
        if (retain) chunks.push(Buffer.from(chunk));
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
  if (entry.compressed > 0) {
    const source = createReadStream('', {
      fd: file.fd,
      autoClose: false,
      start: entry.dataStart,
      end: entry.dataStart + entry.compressed - 1,
      highWaterMark: 64 * 1024,
    });
    if (entry.method === 8) await pipeline(source, createInflateRaw(), sink, { signal });
    else await pipeline(source, sink, { signal });
  }
  if (size !== entry.size || (crc ^ 0xffffffff) >>> 0 !== entry.crc)
    fail(`size or CRC32 mismatch: ${entry.path}.`);
  return retain ? Buffer.concat(chunks, size) : undefined;
}

/** Integrity verification, not proof of artist quality or successful engine import. */
export async function verifyWorldArchive(
  path: string,
  options: VerifyOptions = {},
): Promise<ArchiveVerification> {
  const maxExpanded = options.maxExpandedBytes ?? ARCHIVE_LIMIT;
  if (!Number.isSafeInteger(maxExpanded) || maxExpanded < MiB || maxExpanded > ARCHIVE_LIMIT)
    throw new Error('Verification budget must be from 1 MiB to less than 2 GiB.');
  // Reject special files through the opened descriptor without blocking on
  // a POSIX FIFO. Regular-file behavior is unchanged on every platform.
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile()) fail('input is not a regular file.');
    const { entries, expanded } = await directory(file, stat.size, maxExpanded, options.signal);
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    const manifestEntry = byPath.get('manifest.json');
    const projectEntry = byPath.get('project.nhterrain.json');
    if (!manifestEntry || !projectEntry || !byPath.has('README.txt'))
      fail('required project, manifest or README is missing.');
    const rawManifest = object(
      json((await verifyEntry(file, manifestEntry, true, options.signal))!, 'manifest.json'),
      'manifest',
    );
    if (
      rawManifest.application !== 'Normal Height World Engine' ||
      rawManifest.manifestVersion !== 1 ||
      rawManifest.projectSchemaVersion !== 2 ||
      rawManifest.worldSchemaVersion !== 1
    )
      fail('unsupported manifest or project schema.');
    const project = parseProject(
      json(
        (await verifyEntry(file, projectEntry, true, options.signal))!,
        'project.nhterrain.json',
      ),
    );
    if (
      project.version !== 2 ||
      canonical(project.world) !== canonical(rawManifest.world) ||
      project.seed !== rawManifest.projectSeed
    )
      fail('embedded project does not match the manifest world or seed.');
    const genesisChannels = new Map<WorldGenesisMap, Record<string, unknown>>();
    if (rawManifest.genesis !== undefined) {
      const genesis = object(rawManifest.genesis, 'Genesis provenance');
      if (
        genesis.schemaVersion !== 1 ||
        genesis.algorithm !== GENESIS_ALGORITHM_VERSION ||
        genesis.fieldStage !== 'before-world-transport' ||
        !project.world?.genesis?.enabled ||
        canonical(genesis.settings) !== canonical(project.world.genesis)
      )
        fail('Genesis provenance does not match the authored project.');
      const report = genesis.report;
      if (!isGenesisReport(report)) fail('invalid Genesis numerical report.');
      const expectedGrid = genesisGridSize(project.world!.domain, project.world!.globalResolution);
      if (
        report.width !== expectedGrid.width ||
        report.height !== expectedGrid.height ||
        report.durationYears !== project.world!.genesis!.durationYears ||
        report.spacingX !== project.world!.domain.width / (report.width - 1) ||
        report.spacingZ !== project.world!.domain.depth / (report.height - 1) ||
        canonical(genesis.lithologies) !== canonical(GENESIS_LITHOLOGIES)
      )
        fail('Genesis report or lithology legend disagrees with its provenance.');
      const channels = object(genesis.channels, 'Genesis channels');
      for (const [map, rawChannel] of Object.entries(channels)) {
        if (!isWorldGenesisMap(map)) fail(`unknown Genesis map descriptor: ${map}.`);
        const channel = object(rawChannel, `Genesis ${map} descriptor`);
        const range = channel.range;
        if (
          !Array.isArray(range) ||
          range.length !== 2 ||
          !range.every(Number.isFinite) ||
          range[0] > range[1]
        )
          fail(`invalid Genesis ${map} range.`);
        const expected = genesisMapDescriptor(
          map,
          GENESIS_ALGORITHM_VERSION,
          range as [number, number],
        );
        for (const key of [
          'semantic',
          'units',
          'components',
          'algorithm',
          'storage',
          'byteOrder',
          'sampling',
        ] as const)
          if (channel[key] !== expected[key]) fail(`invalid Genesis ${map} ${key}.`);
        genesisChannels.set(map, channel);
      }
    } else if (project.world?.genesis?.enabled) {
      fail('an enabled Genesis project requires its generation provenance.');
    }
    const genesisEntries = new Map<string, WorldGenesisMap>();
    const dimensions = object(rawManifest.dimensions, 'manifest dimensions');
    const samples = positivePair(dimensions.samples, 'manifest sample dimensions');
    const tiles = rawManifest.tiles;
    if (!Array.isArray(tiles) || !tiles.length || tiles.length > MAX_ENTRIES)
      fail('manifest tiles are invalid.');
    const expected = new Set(['manifest.json', 'project.nhterrain.json', 'README.txt']);
    const tileAddresses = new Set<string>();
    const columns = new Map<number, [number, number]>();
    const rows = new Map<number, [number, number]>();
    let verifiedMapFiles = 0;
    for (const rawTile of tiles) {
      const tile = object(rawTile, 'tile');
      if (
        !Number.isSafeInteger(tile.x) ||
        (tile.x as number) < 0 ||
        !Number.isSafeInteger(tile.z) ||
        (tile.z as number) < 0
      )
        fail('invalid tile address.');
      const address = `${tile.x},${tile.z}`;
      if (tileAddresses.has(address)) fail('duplicate tile address.');
      tileAddresses.add(address);
      const tileSamples = positivePair(tile.samples, 'tile samples');
      const sampleOffset = tile.sampleOffset;
      if (
        !Array.isArray(sampleOffset) ||
        sampleOffset.length !== 2 ||
        !sampleOffset.every((n) => Number.isSafeInteger(n) && n >= 0) ||
        sampleOffset.some((n, axis) => n + tileSamples[axis] > samples[axis])
      )
        fail('tile bounds exceed the sample grid.');
      for (const [axis, bands, address] of [
        [0, columns, tile.x],
        [1, rows, tile.z],
      ] as const) {
        const pair: [number, number] = [sampleOffset[axis], tileSamples[axis]];
        const previous = bands.get(address as number);
        if (previous && (previous[0] !== pair[0] || previous[1] !== pair[1]))
          fail('tile rows or columns disagree about their sample bounds.');
        bands.set(address as number, pair);
      }
      if (!Array.isArray(tile.files) || !tile.files.length) fail('a tile has no files.');
      const maps = new Set<string>();
      for (const rawRecord of tile.files) {
        const record = object(rawRecord, 'tile file');
        if (typeof record.path !== 'string' || !validPath(record.path) || expected.has(record.path))
          fail('duplicate or unsafe manifest file path.');
        if (typeof record.map !== 'string' || !record.map || maps.has(record.map))
          fail('duplicate or invalid tile map.');
        maps.add(record.map);
        const entry = byPath.get(record.path);
        if (
          !entry ||
          record.bytes !== entry.size ||
          typeof record.crc32 !== 'string' ||
          !/^[0-9a-f]{8}$/.test(record.crc32) ||
          parseInt(record.crc32, 16) !== entry.crc
        )
          fail(`manifest file size or CRC32 disagrees: ${record.path}.`);
        if (isWorldGenesisMap(record.map)) {
          const descriptor = genesisChannels.get(record.map);
          const bpp = record.map === 'lithology' ? 1 : 4;
          if (
            !descriptor ||
            record.format !== descriptor.storage ||
            entry.size !== tileSamples[0] * tileSamples[1] * bpp ||
            tileSamples.some((count) => count > 513)
          )
            fail(`Genesis file encoding or dimensions disagree: ${record.path}.`);
          genesisEntries.set(record.path, record.map);
        }
        expected.add(record.path);
        verifiedMapFiles++;
      }
      if (!maps.has('height')) fail('a tile is missing its height map.');
      for (const map of genesisChannels.keys())
        if (!maps.has(map)) fail(`a tile is missing its Genesis ${map} map.`);
    }
    if (tiles.length !== columns.size * rows.size) fail('tile coverage contains holes.');
    for (const [axis, bands] of [
      [0, columns],
      [1, rows],
    ] as const) {
      let offset = 0;
      for (let address = 0; address < bands.size; address++) {
        const band = bands.get(address);
        if (!band || band[0] !== offset) fail('tile coverage is not contiguous.');
        offset += band[1] - 1;
      }
      if (offset + 1 !== samples[axis])
        fail('tile coverage does not span the complete export grid.');
    }
    if (expected.size !== entries.length || entries.some((entry) => !expected.has(entry.path)))
      fail('archive files do not exactly match the manifest.');
    for (const entry of entries) {
      check(options.signal);
      if (entry !== manifestEntry && entry !== projectEntry) {
        const genesisMap = genesisEntries.get(entry.path);
        const data = await verifyEntry(file, entry, !!genesisMap, options.signal);
        if (genesisMap && data) {
          if (genesisMap === 'lithology') {
            for (const id of data) if (id > 3) fail(`unknown lithology ID in ${entry.path}.`);
          } else {
            for (let offset = 0; offset < data.length; offset += 4) {
              const value = data.readFloatLE(offset);
              if (
                !Number.isFinite(value) ||
                ((genesisMap === 'hardness' || genesisMap === 'channel') &&
                  (value < 0 || value > 1)) ||
                ((genesisMap === 'incision' || genesisMap === 'drainageArea') && value < 0)
              )
                fail(`invalid physical Genesis value in ${entry.path}.`);
            }
          }
        }
      }
    }
    const build = object(rawManifest.build, 'build provenance');
    if (
      typeof build.revision !== 'string' ||
      !['git', 'unknown'].includes(String(build.source)) ||
      (build.dirty !== true && build.dirty !== false && build.dirty !== null)
    )
      fail('invalid build provenance.');
    if (
      !['generic', 'unreal', 'unity'].includes(String(rawManifest.profile)) ||
      typeof rawManifest.importQualification !== 'string'
    )
      fail('invalid export profile.');
    if (
      !Array.isArray(rawManifest.warnings) ||
      !rawManifest.warnings.every((warning) => typeof warning === 'string')
    )
      fail('invalid manifest warnings.');
    return {
      archiveBytes: stat.size,
      expandedBytes: expanded,
      files: entries.length,
      tiles: tiles.length,
      verifiedMapFiles,
      dimensions: samples,
      profile: rawManifest.profile as string,
      build: build as unknown as WorldExportManifest['build'],
      importQualification: rawManifest.importQualification,
      warnings: rawManifest.warnings,
    };
  } finally {
    await file.close();
  }
}
