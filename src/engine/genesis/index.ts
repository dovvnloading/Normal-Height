import {
  GENESIS_ALGORITHM_VERSION,
  normalizeGenesisSettings,
  type GenesisSettings,
} from '../../model/genesis';
import type { WorldDomain } from '../../model/world';
import type { TransportGrid } from '../world/hydrology';
import {
  genesisCellAreas,
  routeGenesisDrainage,
  createGenesisDrainageWorkspace,
  type GenesisDrainageWorkspace,
} from './drainage';
import { createGeologySampler } from './geology';
import { inciseStreamPower, relaxGenesisHillslopes } from './solver';
import type { GenesisOptions, GenesisReport, GenesisResult, GenesisSource } from './types';

export { createGeologySampler } from './geology';
export type { GenesisReport, GenesisResult, GenesisOptions, GenesisSource } from './types';

/** Resolution is the sample count along the longest physical axis. */
export function genesisGridSize(domain: Pick<WorldDomain, 'width' | 'depth'>, resolution: number) {
  if (!Number.isSafeInteger(resolution) || resolution < 2 || resolution > 1024)
    throw new Error('Genesis needs 2–1024 samples on its longest reference axis.');
  if (![domain.width, domain.depth].every((v) => Number.isFinite(v) && v > 0))
    throw new Error('Genesis requires positive finite physical dimensions.');
  const longest = Math.max(domain.width, domain.depth);
  return {
    width: Math.max(2, Math.round(((resolution - 1) * domain.width) / longest) + 1),
    height: Math.max(2, Math.round(((resolution - 1) * domain.depth) / longest) + 1),
  };
}

/** Conservative simultaneous-live allocation estimate, not an OS RSS cap. */
export function estimateGenesisPeakBytes(
  domain: Pick<WorldDomain, 'width' | 'depth'>,
  resolution: number,
) {
  const { width, height } = genesisGridSize(domain, resolution);
  // Current level: 45 B/sample (five F64 fields plus hardness/category).
  // Routing peak: 45 B/sample (F64 spill/area/volumes; I32 receiver, basin,
  // rank, order and heap; U8 visited). Previous grid can approach the final
  // size when resolution lies just above 65/129, so reserve its full 40 B.
  // Final F32 delivery conversion and allocation headroom take this to 160 B.
  // A fixed 6 MiB reserve covers scalar objects and runtime overhead; this is
  // still a live-data estimate, not process RSS or a GC timing guarantee.
  return width * height * 160 + 6 * 1024 * 1024;
}

function checkCancelled(options: GenesisOptions) {
  if (options.signal?.aborted) throw new DOMException('Genesis cancelled.', 'AbortError');
}

async function barrier(options: GenesisOptions) {
  checkCancelled(options);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  checkCancelled(options);
}

function sample(values: Float64Array, width: number, rows: number, x: number, z: number): number {
  const xx = Math.min(width - 1, Math.max(0, x));
  const zz = Math.min(rows - 1, Math.max(0, z));
  const ix = Math.min(width - 2, Math.floor(xx)),
    iz = Math.min(rows - 2, Math.floor(zz));
  const fx = xx - ix,
    fz = zz - iz,
    i = iz * width + ix;
  return (
    (values[i] * (1 - fx) + values[i + 1] * fx) * (1 - fz) +
    (values[i + width] * (1 - fx) + values[i + width + 1] * fx) * fz
  );
}

function integratedDifference(a: Float64Array, b: Float64Array, areas: Float64Array): number {
  let volume = 0;
  for (let i = 0; i < a.length; i++) volume += (a[i] - b[i]) * areas[i];
  return volume;
}

interface LevelState {
  width: number;
  rows: number;
  height: Float64Array;
  source: Float64Array;
  uplift: Float64Array;
  incision: Float64Array;
  areas: Float64Array;
}

/**
 * Whole-domain coarse-to-fine geological evolution. Refinement carries the
 * preceding displacement and cumulative diagnostics onto a fresh source
 * sample, preserving authored detail rather than blurring the source. Model
 * time is divided across levels, never multiplied by the number of levels.
 *
 * This is an explicit artistic amplification model: reconstruction can change
 * integrated volume, and incision removes rock without a sediment solver.
 * Those terms are reported separately instead of claiming conservation of
 * an unsimulated high-resolution landscape.
 */
export async function prepareGenesis(
  source: GenesisSource,
  domain: WorldDomain,
  resolution: number,
  seed: number,
  inputSettings: GenesisSettings,
  options: GenesisOptions = {},
): Promise<GenesisResult> {
  checkCancelled(options);
  const settings = normalizeGenesisSettings(inputSettings);
  genesisGridSize(domain, resolution);
  if (domain.boundary !== 'open' && domain.boundary !== 'closed')
    throw new Error(
      'Genesis supports open or closed worlds; periodic drainage is not implemented.',
    );
  if (
    ![domain.originX, domain.originZ, domain.datum].every(Number.isFinite) ||
    !Number.isSafeInteger(seed)
  )
    throw new Error('Genesis requires finite origins, datum and an integer seed.');
  const started = performance.now();
  const geometry = createGeologySampler(domain, seed, settings);
  const sizes = [Math.min(65, resolution), Math.min(129, resolution), resolution].filter(
    (v, i, all) => all.indexOf(v) === i,
  );
  const weights = sizes.length === 1 ? [1] : sizes.length === 2 ? [0.6, 0.4] : [0.5, 0.3, 0.2];
  const report: GenesisReport = {
    algorithmVersion: GENESIS_ALGORITHM_VERSION,
    mode: 'multiscale-stream-power',
    width: 0,
    height: 0,
    spacingX: 0,
    spacingZ: 0,
    levels: [],
    durationYears: settings.enabled ? settings.durationYears : 0,
    upliftVolumeM3: 0,
    incisedVolumeM3: 0,
    hillslopeRedistributedVolumeM3: 0,
    hillslopeResidualM3: 0,
    reconstructionVolumeM3: 0,
    finalVolumeChangeM3: 0,
    outletCount: 0,
    maxDrainageAreaM2: 0,
    drainageAreaResidualM2: 0,
    durationMs: 0,
    limitations: [
      'Artist-controlled stream-power evolution with stylized rock competence; parameters are not geologically calibrated.',
      'Whole-domain reference grids are refined together. Export pixels below the final reference spacing do not receive an independent erosion solve.',
      'Incision removes rock without transporting or depositing its sediment. Incised volume is not outlet sediment export.',
      'Coarse-to-fine displacement reconstruction is not mass conservative; its integrated volume change is reported separately.',
      'Priority-flood spill elevations connect drainage without filling terrain. Implicit incision follows a primary D8 receiver; weighted contributing area splits across downhill neighbors and may cross primary basin divides.',
      'Open edges have fixed base levels. Hillslope diffusion uses monotone pairwise splitting; it is not an exact large-time-step PDE solution.',
      'Diagnostics describe the Genesis stage before any optional World water and sediment transport.',
    ],
  };
  let previous: LevelState | null = null;
  let workspace: GenesisDrainageWorkspace | undefined;
  let hardness = new Float32Array(0),
    lithology = new Uint8Array(0);
  for (let level = 0; level < sizes.length; level++) {
    // Routing workspaces are reused across all iterations at a level. Drop
    // the preceding workspace before allocating the next grid; previous
    // terrain alone is needed for displacement reconstruction.
    workspace = undefined;
    const { width, height: rows } = genesisGridSize(domain, sizes[level]);
    const dx = domain.width / (width - 1),
      dz = domain.depth / (rows - 1);
    const grid: TransportGrid = {
      width,
      height: rows,
      widthMeters: domain.width,
      depthMeters: domain.depth,
      boundary: domain.boundary,
    };
    const count = width * rows;
    const raw = new Float64Array(count),
      height = new Float64Array(count);
    const uplift = new Float64Array(count),
      incision = new Float64Array(count);
    const areas = genesisCellAreas(grid);
    hardness = new Float32Array(count);
    lithology = new Uint8Array(count);
    const old = previous;
    const priorVolume = old ? integratedDifference(old.height, old.source, old.areas) : 0;
    // Canonical division-before-multiplication matches World export sampling.
    for (let z = 0; z < rows; z++) {
      const zz = domain.originZ + (z / (rows - 1)) * domain.depth;
      for (let x = 0; x < width; x++) {
        const i = z * width + x;
        const xx = domain.originX + (x / (width - 1)) * domain.width;
        raw[i] = source(xx, zz, dx, dz);
        if (!Number.isFinite(raw[i])) throw new Error('Genesis requires finite source elevations.');
        height[i] = raw[i];
        if (old) {
          const sx = (x / (width - 1)) * (old.width - 1);
          const sz = (z / (rows - 1)) * (old.rows - 1);
          height[i] +=
            sample(old.height, old.width, old.rows, sx, sz) -
            sample(old.source, old.width, old.rows, sx, sz);
          uplift[i] = sample(old.uplift, old.width, old.rows, sx, sz);
          incision[i] = sample(old.incision, old.width, old.rows, sx, sz);
        }
      }
      if ((z & 31) === 31) await barrier(options);
    }
    report.reconstructionVolumeM3 += integratedDifference(height, raw, areas) - priorVolume;
    const duration = settings.enabled ? settings.durationYears * weights[level] : 0;
    const dt = duration / settings.iterations;
    report.levels.push({
      width,
      height: rows,
      spacingX: dx,
      spacingZ: dz,
      iterations: duration ? settings.iterations : 0,
      durationYears: duration,
    });
    previous = null;
    workspace = createGenesisDrainageWorkspace(grid);
    for (let iteration = 0; iteration < (duration ? settings.iterations : 0); iteration++) {
      options.onProgress?.(
        (level + iteration / settings.iterations) / sizes.length,
        `Genesis ${width} × ${rows} · evolution ${iteration + 1}/${settings.iterations}`,
      );
      await barrier(options);
      for (let z = 0; z < rows; z++) {
        const zz = domain.originZ + (z / (rows - 1)) * domain.depth;
        for (let x = 0; x < width; x++) {
          const i = z * width + x;
          const xx = domain.originX + (x / (width - 1)) * domain.width;
          const oldHeight = height[i];
          height[i] += (geometry.uplift(xx, zz) * dt) / settings.durationYears;
          const addition = height[i] - oldHeight;
          uplift[i] += addition;
          report.upliftVolumeM3 += addition * areas[i];
          const rock = geometry.sample(xx, zz, height[i], uplift[i]);
          hardness[i] = rock.hardness;
          lithology[i] = rock.lithology;
        }
      }
      const drainage = routeGenesisDrainage(height, grid, workspace);
      checkCancelled(options);
      report.incisedVolumeM3 += inciseStreamPower(
        height,
        grid,
        drainage,
        hardness,
        settings.erosionRate,
        settings.rainfall,
        dt,
        incision,
      );
      const hillslope = relaxGenesisHillslopes(
        height,
        grid,
        areas,
        hardness,
        settings.hillslopeRate,
        dt,
      );
      report.hillslopeRedistributedVolumeM3 += hillslope.movedVolumeM3;
      report.hillslopeResidualM3 += hillslope.residualM3;
      await barrier(options);
    }
    previous = { width, rows, height, source: raw, uplift, incision, areas };
  }
  const result = previous!;
  const { width, rows, height, source: sourceHeight, uplift, incision, areas } = result;
  const spacingX = domain.width / (width - 1),
    spacingZ = domain.depth / (rows - 1);
  options.onProgress?.(0.98, 'Genesis · final drainage and exposed rock');
  await barrier(options);
  const drainage = routeGenesisDrainage(
    height,
    {
      width,
      height: rows,
      widthMeters: domain.width,
      depthMeters: domain.depth,
      boundary: domain.boundary,
    },
    workspace,
  );
  const drainageArea = new Float32Array(height.length),
    channel = new Float32Array(height.length);
  const worldArea = domain.width * domain.depth;
  let outletArea = 0;
  for (let z = 0; z < rows; z++) {
    const zz = domain.originZ + (z / (rows - 1)) * domain.depth;
    for (let x = 0; x < width; x++) {
      const i = z * width + x;
      const xx = domain.originX + (x / (width - 1)) * domain.width;
      const rock = geometry.sample(xx, zz, height[i], uplift[i]);
      hardness[i] = rock.hardness;
      lithology[i] = rock.lithology;
      const area = drainage.contributingAreaM2[i];
      drainageArea[i] = area;
      channel[i] = Math.min(1, Math.log1p(area / (worldArea * 0.0001)) / Math.log1p(10000));
      report.maxDrainageAreaM2 = Math.max(report.maxDrainageAreaM2, area);
      if (drainage.receiver[i] < 0) outletArea += area;
      if (!Number.isFinite(height[i])) throw new Error('Genesis produced a non-finite elevation.');
    }
    if ((z & 31) === 31) await barrier(options);
  }
  report.width = width;
  report.height = rows;
  report.spacingX = spacingX;
  report.spacingZ = spacingZ;
  report.finalVolumeChangeM3 = integratedDifference(height, sourceHeight, areas);
  report.drainageAreaResidualM2 = outletArea - worldArea;
  report.outletCount = drainage.outletCount;
  report.durationMs = performance.now() - started;
  options.onProgress?.(1, 'Genesis ready');
  checkCancelled(options);
  return {
    width,
    rows,
    height,
    sourceHeight,
    hardness,
    lithology,
    uplift: Float32Array.from(uplift),
    incision: Float32Array.from(incision),
    drainageArea,
    channel,
    drainage,
    report,
  };
}
