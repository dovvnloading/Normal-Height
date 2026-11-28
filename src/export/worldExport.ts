import { strToU8, Zip, ZipPassThrough, zlibSync } from 'fflate';
import { prepareWorldEvaluation } from '../engine/world';
import type { WorldRegionResult, WorldSampleGrid, WorldStageReport } from '../engine/world/types';
import { slug } from '../model/project';
import {
  projectFileBytes,
  serializeProjectFile,
  PROJECT_STORAGE_ERROR,
} from '../model/projectStorage';
import { MAX_PROJECT_FILE_BYTES } from '../model/heightRaster';
import { resolveSurface } from '../materials/pbr';
import { createDiagnosticAccumulator } from '../materials/terrainAnalysis';
import {
  bakeWorldMaterial,
  isWorldMaterialMap,
  worldMaterialHalo,
  worldMaterialValues,
  WORLD_MATERIAL_MAPS,
  type WorldMaterialMap,
} from '../materials/worldMaterial';
import type { FieldSampling, FieldDescriptor } from '../engine/fields';
import { BUILD_INFO } from '../model/buildInfo';
import type { BuildInfo } from '../model/buildInfo';
import type { TerrainProject } from '../model/types';
import { validateWorldDefinition } from '../model/world';
import type { WorldDefinition } from '../model/world';

export type WorldExportFormat = 'png16' | 'raw16' | 'raw32';
export type WorldExportProfile = 'generic' | 'unreal' | 'unity';
export type WorldExportMap =
  'height' | 'flow' | 'wear' | 'deposition' | 'normalGL' | 'slope' | WorldMaterialMap;
export interface WorldExportOptions {
  project: TerrainProject;
  world: WorldDefinition;
  samplesX: number;
  samplesZ: number;
  format: WorldExportFormat;
  profile: WorldExportProfile;
  maps?: WorldExportMap[];
  diagnostics?: boolean;
  normals?: boolean;
  /** Existing scalar graph nodes; node labels supply names without a second mask schema. */
  masks?: { nodeId: string; name: string }[];
  tileIntervals?: number;
  region?: { startX: number; startZ: number; cellsX: number; cellsZ: number };
  sink?: 'memory' | 'file';
  memoryBudgetBytes?: number;
}
export interface WorldExportEstimate {
  archiveBytes: number;
  /** Estimated live buffers and archive retention, not total JS/process/GPU memory. */
  peakBytes: number;
  retainedArchiveBytes: number;
  tileCount: number;
  tileIntervals: number;
  sampleCountIncludingBorders: number;
  budgetBytes: number;
}
export interface WorldExportTile {
  x: number;
  z: number;
  sampleOffset: [number, number];
  samples: [number, number];
  originMeters: [number, number];
  files: Array<{ path: string; map: string; format: string; bytes: number; crc32: string }>;
}
export interface WorldExportManifest {
  application: 'Normal Height World Engine';
  manifestVersion: 1;
  build: BuildInfo;
  worldSchemaVersion: 1;
  projectSchemaVersion: 2;
  projectSeed: number;
  profile: WorldExportProfile;
  importQualification: string;
  dimensions: {
    samples: [number, number];
    intervals: [number, number];
    widthMeters: number;
    depthMeters: number;
    sampleSpacingMeters: [number, number];
    originMeters: [number, number];
  };
  axes: { x: string; z: string; rowOrder: string; elevation: string };
  encoding: {
    heightFormat: WorldExportFormat;
    heightUnits: string;
    elevationMinMeters: number;
    elevationMaxMeters: number;
    /** Uniform uint16 step, or the largest Float32 ULP over the encoded range. */
    quantizationStepMeters: number;
    quantization: string;
    decode: string;
    rawByteOrder: string;
    diagnosticUnits: Record<string, string>;
    diagnosticRanges: Record<string, [number, number]>;
  };
  profileSettings: Record<string, unknown>;
  world: WorldDefinition;
  region: { startX: number; startZ: number; cellsX: number; cellsZ: number };
  backend: string;
  transportBudget?: WorldRegionResult['transportBudget'];
  stages: WorldStageReport[];
  maskStages: Record<string, WorldStageReport[]>;
  approximation: string;
  borders: string;
  normalConvention: string;
  memory: WorldExportEstimate;
  tiles: WorldExportTile[];
  material?: {
    algorithm: 'surface-fabric-4';
    parameters: ReturnType<typeof resolveSurface>;
    ranges: { min: number; span: number; wearReference: number; depositionReference: number };
    rangeScope: string;
    analysisRadiiMeters: number[];
    coordinates: string;
    channels: Partial<Record<WorldMaterialMap, FieldDescriptor>>;
    paint: string;
  };
  warnings: string[];
  checksum: string;
}
export type WorldExportRequest =
  | { type: 'export'; id: number; options: WorldExportOptions }
  | { type: 'ack'; id: number; sequence: number };
/** Counted work within the current phase, rather than an estimated time remaining. */
export interface WorldExportProgress {
  phase: 'prepare' | 'range' | 'encode' | 'masks' | 'archive';
  completed?: number;
  total?: number;
  unit?: 'tiles';
}
export type WorldExportResponse =
  | {
      type: 'progress';
      id: number;
      progress: number;
      stage: string;
      detail?: WorldExportProgress;
    }
  | { type: 'chunk'; id: number; sequence: number; bytes: ArrayBuffer }
  | { type: 'complete'; id: number; filename: string; manifest: WorldExportManifest }
  | { type: 'error'; id: number; message: string };

const MiB = 1048576;
const UNREAL_SIZES = [127, 253, 505, 1009, 2017, 4033, 8129];
const MAPS: WorldExportMap[] = [
  'height',
  'flow',
  'wear',
  'deposition',
  'normalGL',
  'slope',
  ...WORLD_MATERIAL_MAPS,
];
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  return c >>> 0;
});
function crcUpdate(crc: number, bytes: Uint8Array) {
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}
export function worldCRC32(bytes: Uint8Array): string {
  return ((crcUpdate(0xffffffff, bytes) ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}
function chunk(kind: string, data: Uint8Array) {
  const result = new Uint8Array(data.length + 12),
    view = new DataView(result.buffer);
  view.setUint32(0, data.length);
  result.set(strToU8(kind), 4);
  result.set(data, 8);
  view.setUint32(
    data.length + 8,
    (crcUpdate(0xffffffff, result.subarray(4, data.length + 8)) ^ 0xffffffff) >>> 0,
  );
  return result;
}
function regions(options: WorldExportOptions) {
  return (
    options.region || {
      startX: 0,
      startZ: 0,
      cellsX: options.world.domain.cellsX,
      cellsZ: options.world.domain.cellsZ,
    }
  );
}
function mapsFor(options: WorldExportOptions) {
  return [
    ...new Set<WorldExportMap>([
      'height',
      ...(options.maps || []),
      ...(options.diagnostics ? (['flow', 'wear', 'deposition', 'slope'] as const) : []),
      ...(options.normals ? (['normalGL'] as const) : []),
    ]),
  ];
}
function intervalsFor(options: WorldExportOptions) {
  if (options.profile === 'unreal') return options.samplesX > 4033 ? 254 : 126;
  return options.tileIntervals ?? options.world.tileCells;
}
/** Refuses invalid profiles before opening a sink or evaluating a single node. */
function validateOptions(options: WorldExportOptions) {
  const invalid = validateWorldDefinition(options.world);
  if (invalid) throw new Error(invalid);
  for (const n of [options.samplesX, options.samplesZ])
    if (!Number.isSafeInteger(n) || n < 16 || n > 8193)
      throw new Error('World export dimensions must be integers from 16 to 8193 samples.');
  if (!['png16', 'raw16', 'raw32'].includes(options.format))
    throw new Error('Unknown world height format.');
  if (!['generic', 'unreal', 'unity'].includes(options.profile))
    throw new Error('Unknown world export profile.');
  if (options.profile === 'generic' && (options.samplesX > 8192 || options.samplesZ > 8192))
    throw new Error('Generic export supports up to 8192 exact samples per axis.');
  if (
    options.profile === 'unreal' &&
    (options.samplesX !== options.samplesZ || !UNREAL_SIZES.includes(options.samplesX))
  )
    throw new Error(
      'Unreal profiles require a square grid of 127, 253, 505, 1009, 2017, 4033, or 8129 samples.',
    );
  if (options.profile === 'unity') {
    const cells = options.samplesX - 1;
    if (options.samplesX !== options.samplesZ || cells < 32 || (cells & (cells - 1)) !== 0)
      throw new Error(
        'Unity profiles require square power-of-two intervals plus one sample (for example 1025 or 4097).',
      );
    if (options.format !== 'raw16')
      throw new Error('The Unity profile uses unsigned 16-bit little-endian RAW.');
  }
  if (options.profile === 'unreal' && options.format !== 'png16' && options.format !== 'raw16')
    throw new Error('The Unreal profile uses 16-bit PNG or unsigned 16-bit RAW.');
  if ((options.maps || []).some((map) => !MAPS.includes(map)))
    throw new Error('Unknown world export map.');
  const tile = intervalsFor(options);
  if (!Number.isSafeInteger(tile) || tile < 16 || tile > 512)
    throw new Error('Export tiles must have between 16 and 512 intervals.');
  if (options.profile === 'unity' && (tile < 32 || (tile & (tile - 1)) !== 0))
    throw new Error('Unity tiles require at least 32 power-of-two intervals (33 samples).');
  const r = regions(options),
    d = options.world.domain;
  if (
    ![r.startX, r.startZ, r.cellsX, r.cellsZ].every(Number.isFinite) ||
    r.startX < 0 ||
    r.startZ < 0 ||
    r.cellsX <= 0 ||
    r.cellsZ <= 0 ||
    r.startX + r.cellsX > d.cellsX ||
    r.startZ + r.cellsZ > d.cellsZ
  )
    throw new Error('The export region must lie inside the world domain.');
  const names = new Set<string>();
  if ((options.masks?.length || 0) > 16)
    throw new Error('Select at most 16 mask outputs for one export.');
  for (const mask of options.masks || []) {
    const node = options.project.graph.nodes.find((n) => n.id === mask.nodeId);
    if (!node || (node.kind !== 'mask' && node.kind !== 'maskOutput'))
      throw new Error('Mask export requires an existing mask or named mask output node.');
    const name = slug(mask.name);
    if (!name || names.has(name))
      throw new Error('Mask filenames must have unique nonempty names.');
    names.add(name);
  }
}
function exportProject(options: WorldExportOptions): TerrainProject {
  return {
    ...options.project,
    version: 2,
    world: options.world,
    surface: resolveSurface(options.project.surface),
  };
}
function materialFootprint(options: WorldExportOptions) {
  const d = options.world.domain,
    r = regions(options);
  const dx = (d.width * r.cellsX) / d.cellsX / (options.samplesX - 1);
  const dz = (d.depth * r.cellsZ) / d.cellsZ / (options.samplesZ - 1);
  return { dx, dz, halo: worldMaterialHalo(options.project, options.world, dx, dz) };
}
export function estimateWorldExport(options: WorldExportOptions): WorldExportEstimate {
  validateOptions(options);
  const tileIntervals = intervalsFor(options),
    tilesX = Math.ceil((options.samplesX - 1) / tileIntervals),
    tilesZ = Math.ceil((options.samplesZ - 1) / tileIntervals);
  const sampleCountIncludingBorders =
    (options.samplesX + tilesX - 1) * (options.samplesZ + tilesZ - 1);
  const maps = mapsFor(options);
  const materials = maps.some(isWorldMaterialMap);
  if (materials && options.world.domain.boundary === 'periodic')
    throw new Error(
      'World materials require open or closed boundaries. Periodic material synthesis is not yet qualified.',
    );
  const projectBytes = projectFileBytes(exportProject(options));
  if (projectBytes > MAX_PROJECT_FILE_BYTES) throw new Error(PROJECT_STORAGE_ERROR);
  const bpp =
    (options.format === 'raw32' ? 4 : 2) +
    maps
      .filter((map) => map !== 'height')
      .reduce((sum, map) => sum + (map === 'normalGL' || isWorldMaterialMap(map) ? 4 : 2), 0) +
    (options.masks?.length || 0) * 2;
  const fileCount = tilesX * tilesZ * (maps.length + (options.masks?.length || 0));
  if (fileCount + 3 > 65534)
    throw new Error(
      'This package exceeds the supported ZIP32 file count. Increase the tile size, choose fewer maps, or export a smaller region.',
    );
  // Deflate can expand incompressible input. Include row filters, PNG/ZIP entry
  // headers, checksums, the reproducible project and runtime bookkeeping.
  const archiveBytes = Math.ceil(
    sampleCountIncludingBorders * bpp * 1.015 + fileCount * 4096 + projectBytes + 2 * MiB,
  );
  const retainedArchiveBytes = options.sink === 'file' ? 0 : archiveBytes * 2;
  const graphNodes = options.project.graph.nodes.filter(
    (n) => n.kind !== 'group' && n.kind !== 'note',
  ).length;
  // Material halos are sampled in up to 128² graph chunks even when the
  // encoded tiles are smaller. Budget the executed region, not the PNG size.
  const graphRegionSide = materials ? Math.max(tileIntervals + 3, 128) : tileIntervals + 3;
  const tileBytes = graphRegionSide ** 2 * (32 + Math.min(graphNodes, 256) * 16);
  const globalBytes =
    options.world.globalResolution ** 2 *
    (128 + Math.min(graphNodes, 256) * 16 + (options.world.transport?.enabled ? 224 : 0));
  let materialBytes = 0;
  if (materials) {
    const { dx, dz, halo } = materialFootprint(options);
    const width = Math.min(
      Math.ceil(options.world.domain.width / dx) + 1,
      tileIntervals + 1 + 2 * halo.x,
    );
    const height = Math.min(
      Math.ceil(options.world.domain.depth / dz) + 1,
      tileIntervals + 1 + 2 * halo.z,
    );
    // Full physical analysis halo, compact material/normal buffers, and caches.
    materialBytes = width * height * 16 + (tileIntervals + 3) ** 2 * 32 + 24 * MiB;
    if (width > 32769 || height > 32769 || width * height > 8 * 1024 * 1024)
      throw new Error(
        'The physical material analysis halo exceeds the bounded region budget. Use fewer samples, a larger physical region, or fewer overlapping Blend strokes.',
      );
  }
  const rasterSizes = options.project.graph.nodes.map((node) =>
    node.raster ? node.raster.width * node.raster.height * 4 : 0,
  );
  const importBytes =
    rasterSizes.reduce((sum, bytes) => sum + bytes, 0) + Math.max(0, ...rasterSizes) * 3;
  const peakBytes = Math.ceil(
    64 * MiB +
      globalBytes +
      tileBytes +
      materialBytes +
      importBytes +
      projectBytes * 4 +
      retainedArchiveBytes,
  );
  const budgetBytes = options.memoryBudgetBytes ?? 512 * MiB;
  if (!Number.isFinite(budgetBytes) || budgetBytes < 64 * MiB || budgetBytes > 2048 * MiB)
    throw new Error('World export memory budget must be between 64 and 2048 MiB.');
  return {
    archiveBytes,
    peakBytes,
    retainedArchiveBytes,
    tileCount: tilesX * tilesZ,
    tileIntervals,
    sampleCountIncludingBorders,
    budgetBytes,
  };
}
export function checkWorldExportBudget(options: WorldExportOptions): WorldExportEstimate {
  const estimate = estimateWorldExport(options);
  if (estimate.archiveBytes > 2 ** 31 - 1)
    throw new Error(
      'This archive would exceed the supported 2 GiB ZIP profile. Export a smaller region or fewer maps.',
    );
  if (estimate.peakBytes > estimate.budgetBytes)
    throw new Error(
      `World export is estimated to need ${Math.ceil(estimate.peakBytes / MiB)} MiB, above the ${Math.floor(estimate.budgetBytes / MiB)} MiB budget. ` +
        (options.sink !== 'file'
          ? 'Use a streaming file save, fewer maps, or smaller dimensions.'
          : 'Reduce the global reference resolution, tile size, or graph complexity.'),
    );
  return estimate;
}
export function worldExportFilename(
  options: Pick<WorldExportOptions, 'project' | 'samplesX' | 'samplesZ' | 'profile'>,
) {
  return `${slug(options.project.name)}-world-${options.samplesX}x${options.samplesZ}-${options.profile}.zip`;
}
function profileSettings(
  options: WorldExportOptions,
  min: number,
  max: number,
  dx: number,
  dz: number,
) {
  const step = (max - min) / 65535;
  if (options.profile === 'unreal')
    return {
      status:
        'Experimental: data and grid contracts are tested; an Unreal Editor import has not been performed.',
      documentation:
        'https://dev.epicgames.com/documentation/unreal-engine/landscape-technical-guide-in-unreal-engine',
      xyScaleCentimeters: [dx * 100, dz * 100],
      zScaleCentimeters: step * 128 * 100 || 1,
      actorZCentimeters: (min + step * 32768) * 100 + (step === 0 ? 256 : 0),
      heightEquation: 'elevation_m = actorZ_cm/100 + (uint16 - 32768) * ZScale_cm/12800',
      sectionsPerComponent: [2, 2],
      sectionQuads: options.samplesX > 4033 ? 127 : 63,
      tileFilenameConvention: 'height_x{column}_y{row}; north-to-south increasing row',
      note: 'Use the recorded exact scales and origins. Import tiles with shared edges; do not normalize each tile independently. A constant field uses the recorded minimum elevation and zero encoded samples.',
    };
  if (options.profile === 'unity')
    return {
      status:
        'Experimental: RAW bytes and grid contracts are tested; a Unity Editor import has not been performed.',
      documentation: 'https://docs.unity3d.com/Manual/terrain-Heightmaps.html',
      gridDocumentation:
        'https://docs.unity3d.com/6000.0/Documentation/ScriptReference/TerrainData-heightmapResolution.html',
      depth: 16,
      byteOrder: 'Windows (little endian)',
      flipVertically: false,
      terrainSizeY: max - min || 1,
      terrainPositionY: min,
      note: 'Set each TerrainData size X/Z from its interval count times sample spacing, with the same Y size/position for every tile. Row zero is north; verify application axis placement on import.',
    };
  return {
    status: 'Generic local Cartesian heightfield; no external engine import certification.',
    note: 'Float32 RAW is physical elevation in metres. PNG/RAW16 share one output-region range.',
  };
}
function tileList(options: WorldExportOptions, intervals: number): WorldExportTile[] {
  const out: WorldExportTile[] = [],
    d = options.world.domain,
    r = regions(options);
  for (let z0 = 0, z = 0; z0 < options.samplesZ - 1; z0 += intervals, z++)
    for (let x0 = 0, x = 0; x0 < options.samplesX - 1; x0 += intervals, x++) {
      out.push({
        x,
        z,
        sampleOffset: [x0, z0],
        samples: [
          Math.min(intervals + 1, options.samplesX - x0),
          Math.min(intervals + 1, options.samplesZ - z0),
        ],
        originMeters: [
          d.originX + ((r.startX + (x0 / (options.samplesX - 1)) * r.cellsX) / d.cellsX) * d.width,
          d.originZ + ((r.startZ + (z0 / (options.samplesZ - 1)) * r.cellsZ) / d.cellsZ) * d.depth,
        ],
        files: [],
      });
    }
  return out;
}
/** Use the same integer numerator as world sampling, including for halo bounds. */
function exportGridIndex(options: WorldExportOptions, axis: 'X' | 'Z', sample: number): number {
  const r = regions(options);
  return r[`start${axis}`] + (sample / (options[`samples${axis}`] - 1)) * r[`cells${axis}`];
}
function gridFor(
  options: WorldExportOptions,
  x: number,
  z: number,
  width: number,
  height: number,
): WorldSampleGrid {
  const r = regions(options),
    stepX = r.cellsX / (options.samplesX - 1),
    stepZ = r.cellsZ / (options.samplesZ - 1);
  return {
    startX: exportGridIndex(options, 'X', x),
    startZ: exportGridIndex(options, 'Z', z),
    cellsX: (width - 1) * stepX,
    cellsZ: (height - 1) * stepZ,
    samplesX: width,
    samplesZ: height,
    outputCellsX: options.samplesX - 1,
    outputCellsZ: options.samplesZ - 1,
    outputSampleOffsetX: x,
    outputSampleOffsetZ: z,
    outputOriginX: r.startX,
    outputOriginZ: r.startZ,
    outputExtentX: r.cellsX,
    outputExtentZ: r.cellsZ,
  };
}
function scalar(result: WorldRegionResult, map: WorldExportMap, i: number, world: WorldDefinition) {
  if (map === 'height') return world.domain.datum + result.heights[i] * world.domain.heightScale;
  if (map === 'flow') return result.flow[i];
  if (map === 'wear') return result.wear[i];
  if (map === 'deposition') return result.deposition[i];
  throw new Error('A derived map needs its sampling halo.');
}
function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('World export cancelled.', 'AbortError');
}

/**
 * Evaluates bounded rectangles, performs ONE common range pass, then encodes
 * one tile at a time with awaited sink backpressure. No full output-grid array
 * or retained ZIP lives in this function. GPU failure aborts the package; a
 * caller can retry the entire request on CPU without mixing shared edges.
 */
export async function streamWorldExport(
  options: WorldExportOptions,
  onChunk: (bytes: Uint8Array, final: boolean) => void | Promise<void>,
  onProgress: (progress: number, stage: string, detail?: WorldExportProgress) => void = () => {},
  signal?: AbortSignal,
): Promise<WorldExportManifest> {
  let reportedProgress = 0;
  const report = (fraction: number, stage: string, detail?: WorldExportProgress) => {
    reportedProgress = Math.max(reportedProgress, Math.min(1, Math.max(0, fraction)));
    onProgress(reportedProgress, stage, detail);
  };
  // Capture a stable project before the first asynchronous evaluation. Callers
  // cannot change the authored graph halfway through a multi-tile package.
  options = structuredClone(options);
  const memory = checkWorldExportBudget(options),
    tiles = tileList(options, memory.tileIntervals),
    maps = mapsFor(options);
  const materials = maps.filter(isWorldMaterialMap);
  const projectJSON = serializeProjectFile(exportProject(options));
  const wearAccumulator = createDiagnosticAccumulator(),
    depositionAccumulator = createDiagnosticAccumulator();
  const exportStages = (stages: WorldStageReport[]) =>
    stages.map((stage) =>
      stage.mode === 'native'
        ? { ...stage, samplesX: options.samplesX, samplesZ: options.samplesZ }
        : { ...stage },
    );
  assertNotAborted(signal);
  report(0, 'Compiling world graph', { phase: 'prepare' });
  const prepared = await prepareWorldEvaluation(options.project, options.world, {
    signal,
    onProgress: (p, stage) => report(p * 0.08, stage, { phase: 'prepare' }),
  });
  const ranges: Record<string, [number, number]> = {
    height: [Infinity, -Infinity],
    flow: [0, 1],
    wear: [Infinity, -Infinity],
    deposition: [Infinity, -Infinity],
    slope: [0, 90],
  };
  let lastStages: WorldStageReport[] = [],
    backend = 'cpu-reference';
  const pending: Array<{ bytes: Uint8Array; final: boolean }> = [];
  let archiveBytes = 0;
  const flush = async () => {
    for (const part of pending) {
      assertNotAborted(signal);
      await onChunk(part.bytes, part.final);
    }
    pending.length = 0;
  };
  const zip = new Zip((error, bytes, final) => {
    if (error) throw error;
    archiveBytes += bytes.length;
    if (archiveBytes > memory.archiveBytes)
      throw new Error(
        'The export exceeded its archive allocation estimate; choose a smaller region.',
      );
    pending.push({ bytes: bytes.slice(), final });
  });
  const add = (path: string) => {
    const file = new ZipPassThrough(path);
    file.mtime = new Date(2000, 0, 1);
    zip.add(file);
    let crc = 0xffffffff,
      bytes = 0;
    return {
      push(data: Uint8Array, final = false) {
        crc = crcUpdate(crc, data);
        bytes += data.length;
        file.push(data, final);
      },
      record(map: string, format: string) {
        return {
          path,
          map,
          format,
          bytes,
          crc32: ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0'),
        };
      },
    };
  };
  type OutputFile = ReturnType<typeof add>;
  const encode = async (
    file: OutputFile,
    width: number,
    height: number,
    format: WorldExportFormat | 'rgba8',
    values: (x: number, y: number, component?: number) => number,
    range: [number, number],
  ) => {
    const rgba = format === 'rgba8',
      png = format === 'png16' || rgba,
      bytesPerSample = format === 'raw32' || rgba ? 4 : 2;
    // A tile is bounded to at most 513² samples. Compress its complete
    // scanlines together: this also avoids tiny final deflate-block failures
    // observed with streaming repetitive mask rows. The world remains streamed.
    const pngRows = png ? new Uint8Array(height * (width * bytesPerSample + 1)) : undefined;
    if (png) {
      file.push(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
      const header = new Uint8Array(13),
        view = new DataView(header.buffer);
      view.setUint32(0, width);
      view.setUint32(4, height);
      header[8] = rgba ? 8 : 16;
      header[9] = rgba ? 6 : 0;
      file.push(chunk('IHDR', header));
    }
    for (let y0 = 0; y0 < height; y0 += 16) {
      assertNotAborted(signal);
      const rows = Math.min(16, height - y0),
        stride = width * bytesPerSample + +png,
        bytes = new Uint8Array(rows * stride),
        view = new DataView(bytes.buffer);
      for (let row = 0; row < rows; row++) {
        let offset = row * stride;
        if (png) bytes[offset++] = 1; // Sub filter. Each tile row has its own left boundary.
        const previous = new Uint8Array(bytesPerSample);
        for (let x = 0; x < width; x++) {
          const value = values(x, y0 + row);
          if (!Number.isFinite(value)) throw new Error('Export encountered a non-finite sample.');
          if (format === 'raw32') {
            if (!Number.isFinite(Math.fround(value)))
              throw new Error('Export sample exceeds the finite Float32 elevation range.');
            view.setFloat32(offset, value, true);
            offset += 4;
          } else if (rgba) {
            for (let component = 0; component < 4; component++) {
              const channel = values(x, y0 + row, component);
              if (!Number.isFinite(channel))
                throw new Error('Export encountered a non-finite channel.');
              const v = Math.round(Math.max(0, Math.min(1, channel)) * 255);
              bytes[offset++] = (v - previous[component]) & 255;
              previous[component] = v;
            }
          } else {
            const encoded = Math.round(
              Math.max(0, Math.min(1, (value - range[0]) / (range[1] - range[0] || 1))) * 65535,
            );
            if (png) {
              const high = encoded >>> 8,
                low = encoded & 255;
              bytes[offset++] = (high - previous[0]) & 255;
              bytes[offset++] = (low - previous[1]) & 255;
              previous[0] = high;
              previous[1] = low;
            } else {
              view.setUint16(offset, encoded, true);
              offset += 2;
            }
          }
        }
      }
      if (pngRows) pngRows.set(bytes, y0 * stride);
      else {
        file.push(bytes, y0 + rows === height);
        await flush();
      }
    }
    if (pngRows) {
      file.push(chunk('IDAT', zlibSync(pngRows, { level: 6 })));
      file.push(chunk('IEND', new Uint8Array()), true);
      await flush();
    }
  };
  try {
    // Each tile includes shared samples. Repeated observations cannot change
    // min/max, and encoding never selects a separate range for a tile.
    report(0.08, 'Measuring common elevation range', {
      phase: 'range',
      completed: 0,
      total: tiles.length,
      unit: 'tiles',
    });
    for (let index = 0; index < tiles.length; index++) {
      assertNotAborted(signal);
      const tile = tiles[index],
        result = await prepared.sampleRegion(
          gridFor(options, ...tile.sampleOffset, ...tile.samples),
          { signal },
        );
      lastStages = exportStages(result.stages);
      backend = result.backend;
      for (const map of maps) {
        if (isWorldMaterialMap(map) || map === 'normalGL' || map === 'slope' || map === 'flow')
          continue;
        for (let i = 0; i < result.heights.length; i++) {
          const value = scalar(result, map, i, options.world);
          if (!Number.isFinite(value)) throw new Error('The world contains non-finite map values.');
          ranges[map][0] = Math.min(ranges[map][0], value);
          ranges[map][1] = Math.max(ranges[map][1], value);
        }
      }
      if (materials.length) {
        // Shared borders are counted once, so histogram references cannot
        // change when the user chooses a different export tile size.
        for (let z = tile.z ? 1 : 0; z < result.height; z++)
          for (let x = tile.x ? 1 : 0; x < result.width; x++) {
            const i = z * result.width + x;
            wearAccumulator.add(result.wear[i]);
            depositionAccumulator.add(result.deposition[i]);
          }
      }
      report(
        0.08 + (0.35 * (index + 1)) / tiles.length,
        `Measuring common elevation range · tile ${index + 1}/${tiles.length}`,
        { phase: 'range', completed: index + 1, total: tiles.length, unit: 'tiles' },
      );
    }
    const d = options.world.domain,
      r = regions(options),
      dx = (d.width * r.cellsX) / d.cellsX / (options.samplesX - 1),
      dz = (d.depth * r.cellsZ) / d.cellsZ / (options.samplesZ - 1);
    const range = ranges.height;
    const manifest: WorldExportManifest = {
      application: 'Normal Height World Engine',
      manifestVersion: 1,
      build: { ...BUILD_INFO },
      worldSchemaVersion: 1,
      projectSchemaVersion: 2,
      projectSeed: options.project.seed,
      profile: options.profile,
      importQualification:
        options.profile === 'generic'
          ? 'Generic data contract validated. Blender bridge qualification is recorded separately in docs/BLENDER.md; other external application imports remain unverified.'
          : 'Experimental profile. Byte encoding and dimensions validated; real engine import not yet verified.',
      dimensions: {
        samples: [options.samplesX, options.samplesZ],
        intervals: [options.samplesX - 1, options.samplesZ - 1],
        widthMeters: dx * (options.samplesX - 1),
        depthMeters: dz * (options.samplesZ - 1),
        sampleSpacingMeters: [dx, dz],
        originMeters: [
          d.originX + (r.startX / d.cellsX) * d.width,
          d.originZ + (r.startZ / d.cellsZ) * d.depth,
        ],
      },
      axes: {
        x: 'East/right',
        z: 'South/down',
        rowOrder: 'North first; row-major; both interval endpoints included.',
        elevation: 'Metres above the authored local datum; this is not a georeferenced CRS.',
      },
      encoding: {
        heightFormat: options.format,
        heightUnits: 'Metres',
        elevationMinMeters: range[0],
        elevationMaxMeters: range[1],
        quantizationStepMeters:
          options.format === 'raw32'
            ? Math.max(
                2 ** -149,
                2 **
                  (Math.floor(
                    Math.log2(Math.fround(Math.max(Math.abs(range[0]), Math.abs(range[1])))),
                  ) -
                    23),
              )
            : (range[1] - range[0]) / 65535,
        quantization:
          options.format === 'raw32'
            ? 'Variable IEEE 754 Float32 spacing. quantizationStepMeters is the largest ULP over the encoded range, not a uniform 16-bit step; rounding error is at most half that spacing.'
            : 'Uniform uint16 spacing over the common elevation range; rounding error is at most half quantizationStepMeters. Constant maps decode exactly to the common minimum.',
        decode:
          options.format === 'raw32'
            ? 'Little-endian IEEE 754 Float32 elevation in metres, no header.'
            : 'elevation_m = elevationMinMeters + uint16/65535 * (elevationMaxMeters-elevationMinMeters). Constant maps decode to the minimum.',
        rawByteOrder: 'Little endian',
        diagnosticUnits: {
          flow: 'Global normalized diagnostic weight, 0–1; not discharge in physical units.',
          wear: 'Legacy erosion diagnostic scalar, not measured metres of erosion.',
          deposition: 'Legacy deposition diagnostic scalar, not measured metres of deposition.',
          slope: 'Degrees from the physical height gradient; 0–90.',
          masks: 'Fixed 0–1 scalar weights from authored mask nodes.',
        },
        diagnosticRanges: {},
      },
      profileSettings: profileSettings(options, ...range, dx, dz),
      world: structuredClone(options.world),
      region: r,
      backend,
      stages: lastStages,
      maskStages: {},
      ...(prepared.transportBudget ? { transportBudget: { ...prepared.transportBudget } } : {}),
      approximation: prepared.capability.native
        ? 'Reachable graph sampled at the requested coordinates and footprint; no preview upscaling.'
        : 'This graph contains globally evaluated reference stages. See each stage for native sampling, reconstruction and actual simulation spacing. Output resolution is not simulation resolution.',
      borders:
        'Adjacent tiles duplicate the same canonical border/corner samples. Reassemble by omitting the first column/row of every tile except the first. Do not count duplicate borders in volume sums.',
      normalConvention:
        'OpenGL tangent-space +Y. R=east slope normal, G=north slope normal, B=up; unit length before 8-bit encoding. One-sample world halo across internal tile boundaries; outer derivatives wrap for periodic worlds and use one-sided differences otherwise.',
      memory,
      tiles,
      warnings: [
        ...prepared.capability.warnings,
        'Preflight counts live data buffers and archive retention. JavaScript runtime, garbage collection, renderer and GPU memory are additional; the budget is not a process memory cap.',
      ],
      checksum:
        'CRC32 per encoded file, lowercase hexadecimal; integrity check, not cryptographic authentication.',
    };
    const materialRanges = {
      min: (range[0] - d.datum) / d.heightScale,
      span: Math.max(1e-8, (range[1] - range[0]) / d.heightScale),
      wearReference: wearAccumulator.reference(),
      depositionReference: depositionAccumulator.reference(),
    };
    if (materials.length) {
      manifest.material = {
        algorithm: 'surface-fabric-4',
        parameters: resolveSurface(options.project.surface),
        ranges: materialRanges,
        rangeScope:
          'One measured range and unique-sample diagnostic histogram for the complete selected export region; never normalized per tile.',
        analysisRadiiMeters: [50, 150, 425],
        coordinates:
          'Physical east/south metres on the canonical output lattice, including the authored world origin and elevation datum. Full physical analysis halos cross internal tile boundaries.',
        channels: Object.fromEntries(
          materials.map((map) => [
            map,
            {
              semantic:
                map === 'basecolor'
                  ? 'color'
                  : map.includes('Normal')
                    ? 'normal'
                    : map === 'relief'
                      ? 'elevation'
                      : 'coverage',
              units: map === 'basecolor' ? 'srgb' : map === 'relief' ? 'meters' : 'unitless',
              components: map === 'relief' ? 1 : 4,
              algorithm: 'surface-fabric-4',
            } satisfies FieldDescriptor,
          ]),
        ),
        paint:
          'Saved paint uses normalized whole-world coordinates. Splat RGBA is rock/soil/vegetation/snow coverage and sums to 255; alpha is data. ORM is linear AO/roughness/zero metallic/opaque alpha. Relief is signed Float32 metres; geometry-normal and material-normal maps are distinct.',
      };
      manifest.warnings.push(
        'Material elevation distribution and diagnostic normalization use the selected export region. A different crop can change climate-dependent coverage. The material appearance is model 4; shader-only close detail is not baked into these terrain maps.',
      );
    }
    for (const map of maps)
      if (!isWorldMaterialMap(map) && map !== 'height' && map !== 'normalGL')
        manifest.encoding.diagnosticRanges[map] = ranges[map];
    report(0.43, 'Encoding world maps', {
      phase: 'encode',
      completed: 0,
      total: tiles.length,
      unit: 'tiles',
    });
    for (let index = 0; index < tiles.length; index++) {
      assertNotAborted(signal);
      const tile = tiles[index],
        [x0, z0] = tile.sampleOffset,
        [width, height] = tile.samples;
      const needHalo = maps.includes('normalGL') || maps.includes('slope');
      const halo = materials.length
        ? materialFootprint(options).halo
        : { x: +needHalo, z: +needHalo };
      const stepX = r.cellsX / (options.samplesX - 1),
        stepZ = r.cellsZ / (options.samplesZ - 1);
      // The requested lattice endpoints are always legal. Division by a
      // non-binary sample step may round 28 to 27.999999999999996; never
      // trim an actual output sample while discovering optional outside halo.
      let minimumX = Math.min(0, Math.ceil(-r.startX / stepX - 1e-9));
      let minimumZ = Math.min(0, Math.ceil(-r.startZ / stepZ - 1e-9));
      let maximumX = Math.max(
        options.samplesX - 1,
        Math.floor((d.cellsX - r.startX) / stepX + 1e-9),
      );
      let maximumZ = Math.max(
        options.samplesZ - 1,
        Math.floor((d.cellsZ - r.startZ) / stepZ + 1e-9),
      );
      while (minimumX < 0 && exportGridIndex(options, 'X', minimumX) < 0) minimumX++;
      while (minimumZ < 0 && exportGridIndex(options, 'Z', minimumZ) < 0) minimumZ++;
      while (maximumX > options.samplesX - 1 && exportGridIndex(options, 'X', maximumX) > d.cellsX)
        maximumX--;
      while (maximumZ > options.samplesZ - 1 && exportGridIndex(options, 'Z', maximumZ) > d.cellsZ)
        maximumZ--;
      const left = Math.min(halo.x, x0 - minimumX),
        north = Math.min(halo.z, z0 - minimumZ);
      const right = Math.min(halo.x, maximumX - (x0 + width - 1));
      const south = Math.min(halo.z, maximumZ - (z0 + height - 1));
      const samplingGrid = gridFor(
        options,
        x0 - left,
        z0 - north,
        width + left + right,
        height + north + south,
      );
      let result: WorldRegionResult;
      if (!materials.length) result = await prepared.sampleRegion(samplingGrid, { signal });
      else {
        const fullWidth = samplingGrid.samplesX,
          fullHeight = samplingGrid.samplesZ;
        const count = fullWidth * fullHeight;
        const channels = {
          heights: new Float32Array(count),
          flow: new Float32Array(count),
          wear: new Float32Array(count),
          deposition: new Float32Array(count),
        };
        let last: WorldRegionResult | undefined;
        // Avoid multiplying the complete material halo by every graph stage's
        // temporary arrays. The engine sees only bounded 128² rectangles.
        for (let z = 0; z < fullHeight; z += 128)
          for (let x = 0; x < fullWidth; x += 128) {
            assertNotAborted(signal);
            const w = Math.min(128, fullWidth - x),
              h = Math.min(128, fullHeight - z);
            last = await prepared.sampleRegion(
              gridFor(options, x0 - left + x, z0 - north + z, w, h),
              { signal },
            );
            for (const key of ['heights', 'flow', 'wear', 'deposition'] as const)
              for (let row = 0; row < h; row++)
                channels[key].set(
                  last[key].subarray(row * w, (row + 1) * w),
                  (z + row) * fullWidth + x,
                );
          }
        result = {
          ...last!,
          ...channels,
          width: fullWidth,
          height: fullHeight,
          spacingX: dx,
          spacingZ: dz,
        };
      }
      // At the true outer boundary, periodic derivatives need the neighboring
      // sample from the opposite side. Fetch only the missing row/column, not a
      // full-world buffer; keep the same sample footprint on both sides.
      const wrapHalo = async (axis: 'X' | 'Z', outsideOffset: number) => {
        const total = d[`cells${axis}`],
          origin = r[`start${axis}`],
          extent = r[`cells${axis}`];
        const outputCells = (axis === 'X' ? options.samplesX : options.samplesZ) - 1;
        const step = extent / outputCells,
          period = total / step;
        const unwrapped = origin + (outsideOffset / outputCells) * extent;
        const turns = Math.floor(unwrapped / total);
        const wrappedOffset = outsideOffset - turns * Math.round(period);
        const halo = { ...samplingGrid, [`samples${axis}`]: 1, [`cells${axis}`]: 0 };
        if (Math.abs(period - Math.round(period)) < 1e-8 && Math.abs(wrappedOffset) <= 32768) {
          // Preserve canonical integer numerators when the world period aligns
          // with the requested output lattice (including every full-world export).
          halo[`outputSampleOffset${axis}`] = wrappedOffset;
          halo[`start${axis}`] = origin + (wrappedOffset / outputCells) * extent;
        } else {
          // An ROI lattice may not divide the world period. Rebase its wrapped
          // single sample while explicitly retaining the original footprint.
          const wrapped = ((unwrapped % total) + total) % total;
          const anchor = wrapped >= step ? wrapped - step : wrapped;
          const offset = wrapped >= step ? 1 : 0;
          halo[`outputCells${axis}`] = 1;
          halo[`outputSampleOffset${axis}`] = offset;
          halo[`outputOrigin${axis}`] = anchor;
          halo[`outputExtent${axis}`] = step;
          halo[`start${axis}`] = anchor + offset * step;
        }
        return (await prepared.sampleRegion(halo, { signal })).heights;
      };
      const periodic = needHalo && d.boundary === 'periodic';
      const wrappedWest = periodic && !left ? await wrapHalo('X', x0 - 1) : undefined;
      const wrappedEast = periodic && !right ? await wrapHalo('X', x0 + width) : undefined;
      const wrappedNorth = periodic && !north ? await wrapHalo('Z', z0 - 1) : undefined;
      const wrappedSouth = periodic && !south ? await wrapHalo('Z', z0 + height) : undefined;
      const sampleIndex = (x: number, z: number) => (z + north) * result.width + x + left;
      const gradient = (x: number, z: number) => {
        const column = x + left,
          row = z + north;
        const west = Math.max(0, column - 1),
          east = Math.min(result.width - 1, column + 1),
          n = Math.max(0, row - 1),
          s = Math.min(result.height - 1, row + 1);
        const leftWrapped = column === 0 && wrappedWest !== undefined,
          rightWrapped = column === result.width - 1 && wrappedEast !== undefined;
        const northWrapped = row === 0 && wrappedNorth !== undefined,
          southWrapped = row === result.height - 1 && wrappedSouth !== undefined;
        const westHeight = leftWrapped
          ? wrappedWest[row]
          : result.heights[row * result.width + west];
        const eastHeight = rightWrapped
          ? wrappedEast[row]
          : result.heights[row * result.width + east];
        const northHeight = northWrapped
          ? wrappedNorth[column]
          : result.heights[n * result.width + column];
        const southHeight = southWrapped
          ? wrappedSouth[column]
          : result.heights[s * result.width + column];
        return [
          ((eastHeight - westHeight) * d.heightScale) /
            ((east - west + +leftWrapped + +rightWrapped) * dx),
          ((southHeight - northHeight) * d.heightScale) /
            ((s - n + +northWrapped + +southWrapped) * dz),
        ];
      };
      const sampling: FieldSampling = {
        grid: {
          width: result.width,
          height: result.height,
          originX: d.originX + (exportGridIndex(options, 'X', x0 - left) / d.cellsX) * d.width,
          originZ: d.originZ + (exportGridIndex(options, 'Z', z0 - north) / d.cellsZ) * d.depth,
          spacingX: dx,
          spacingZ: dz,
          heightScale: d.heightScale,
          datum: d.datum,
          lattice: {
            originX: d.originX + (r.startX / d.cellsX) * d.width,
            originZ: d.originZ + (r.startZ / d.cellsZ) * d.depth,
            extentX: (d.width * r.cellsX) / d.cellsX,
            extentZ: (d.depth * r.cellsZ) / d.cellsZ,
            cellsX: options.samplesX - 1,
            cellsZ: options.samplesZ - 1,
            offsetX: x0 - left,
            offsetZ: z0 - north,
          },
        },
        paint: { originX: d.originX, originZ: d.originZ, width: d.width, depth: d.depth },
      };
      const material = materials.length
        ? bakeWorldMaterial(
            {
              resolution: result.width,
              height: result.heights,
              flow: result.flow,
              wear: result.wear,
              deposition: result.deposition,
            },
            options.project,
            materialRanges,
            sampling,
            { left, top: north, right: left + width, bottom: north + height },
          )
        : null;
      for (const map of maps) {
        const format =
          map === 'height'
            ? options.format
            : map === 'relief'
              ? 'raw32'
              : map === 'normalGL' || isWorldMaterialMap(map)
                ? 'rgba8'
                : 'png16';
        const extension =
          format === 'png16' || format === 'rgba8'
            ? 'png'
            : format === 'raw32'
              ? 'f32.raw'
              : options.profile === 'unity'
                ? 'raw'
                : 'r16';
        const path = `tiles/${map}_x${tile.x}_y${tile.z}.${extension}`,
          file = add(path);
        await encode(
          file,
          width,
          height,
          format,
          material && isWorldMaterialMap(map)
            ? worldMaterialValues(material, options.project, map)
            : (x, z, component = 0) => {
                if (map === 'normalGL' || map === 'slope') {
                  const [gx, gz] = gradient(x, z);
                  if (map === 'slope') return (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
                  if (component === 3) return 1;
                  const length = Math.hypot(gx, gz, 1);
                  return ((component === 0 ? -gx : component === 1 ? gz : 1) / length) * 0.5 + 0.5;
                }
                return scalar(result, map, sampleIndex(x, z), options.world);
              },
          ranges[map] || [0, 1],
        );
        tile.files.push(
          file.record(
            map,
            format === 'rgba8'
              ? map === 'basecolor'
                ? 'RGBA8 PNG (sRGB)'
                : 'RGBA8 PNG (linear/non-color)'
              : format,
          ),
        );
      }
      report(
        0.43 + (0.48 * (index + 1)) / tiles.length,
        `Encoding world maps · tile ${index + 1}/${tiles.length}`,
        { phase: 'encode', completed: index + 1, total: tiles.length, unit: 'tiles' },
      );
    }
    prepared.dispose();
    // Masks use the same spatial/export contracts and fixed weight encoding.
    // Separate prepared evaluations keep each mask's global dependencies honest.
    const maskTileCount = (options.masks?.length || 0) * tiles.length;
    let maskTilesComplete = 0;
    for (let maskIndex = 0; maskIndex < (options.masks?.length || 0); maskIndex++) {
      const mask = options.masks![maskIndex],
        name = slug(mask.name);
      report(0.91 + (0.06 * maskTilesComplete) / maskTileCount, `Preparing mask ${mask.name}`, {
        phase: 'masks',
        completed: maskTilesComplete,
        total: maskTileCount,
        unit: 'tiles',
      });
      const maskWorld = options.world.transport?.enabled
        ? { ...options.world, transport: { ...options.world.transport, enabled: false } }
        : options.world;
      const maskEngine = await prepareWorldEvaluation(options.project, maskWorld, {
        signal,
        previewNodeId: mask.nodeId,
      });
      try {
        for (const tile of tiles) {
          const result = await maskEngine.sampleRegion(
            gridFor(options, ...tile.sampleOffset, ...tile.samples),
            { signal },
          );
          const path = `masks/${name}_x${tile.x}_y${tile.z}.png`,
            file = add(path);
          await encode(
            file,
            tile.samples[0],
            tile.samples[1],
            'png16',
            (x, z) => result.heights[z * result.width + x],
            [0, 1],
          );
          tile.files.push(file.record(`mask:${name}`, 'png16'));
          manifest.maskStages[name] = exportStages(result.stages);
          maskTilesComplete++;
          report(
            0.91 + (0.06 * maskTilesComplete) / maskTileCount,
            `Encoding mask ${mask.name} · tile ${maskTilesComplete}/${maskTileCount}`,
            { phase: 'masks', completed: maskTilesComplete, total: maskTileCount, unit: 'tiles' },
          );
        }
      } finally {
        maskEngine.dispose();
      }
    }
    if (options.world.transport?.enabled && options.masks?.length)
      manifest.warnings.push(
        'Authored mask branches are evaluated before optional post-graph World transport. Scalar weights are not treated as elevations or eroded.',
      );
    prepared.dispose();
    report(0.97, 'Packing manifest, import notes and project', { phase: 'archive' });
    const notes = `NORMAL HEIGHT WORLD EXPORT\n\n${manifest.approximation}\n\n${manifest.borders}\n\n${manifest.importQualification}\n\nRead manifest.json for common height encoding, physical origin, stage spacing, byte order and per-file checksums.\n\nThe project file retains the authored graph and world. Neither a high output size nor a GPU pointwise pass means every simulation ran at that resolution or on the GPU.\n\n${JSON.stringify(manifest.profileSettings, null, 2)}\n`;
    add('README.txt').push(strToU8(notes), true);
    add('project.nhterrain.json').push(strToU8(projectJSON), true);
    add('manifest.json').push(strToU8(JSON.stringify(manifest, null, 2)), true);
    zip.end();
    await flush();
    report(1, 'World export ready', { phase: 'archive', completed: 1, total: 1 });
    return manifest;
  } finally {
    prepared.dispose();
    zip.terminate();
  }
}
