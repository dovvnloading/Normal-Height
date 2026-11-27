import type { TerrainNode, TerrainProject } from '../../model/types';
import { validateWorldDefinition, WORLD_REGION_BUDGET } from '../../model/world';
import type { WorldDefinition } from '../../model/world';
import { compileGraph } from '../plan/graph';
import { describeWorldGraph, isWorldGlobalNode as isGlobal } from './capabilities';
import { evaluateGraph } from '../index';
import { clamp, mix, Noise, smoothstep } from '../noise';
import { hydraulicErosion, sampleHeight, thermalErosion } from '../erosion';
import { reconstructionWeight } from '../erosionMask';
import { sculptSpline } from '../spline';
import { COAST_DEFAULTS, shapeCoast } from '../coast';
import { createImportedHeightSampler } from '../heightImport';
import { createPointwiseBackend } from '../gpu/pointwise';
import type { ComputeCapability, PointwiseBackend, PointwiseOperation } from '../gpu/pointwise';
import { createWorldNoiseSampler } from './noise';
import { quintic } from '../noiseStudio/math';
import { gridIndex, gridSpacing, validateWorldGrid, worldCoordinate } from './grid';
import { simulateWorldTransport } from './hydrology';
import type { WorldMassBudget } from './hydrology';
import { prepareGenesis, createGeologySampler, genesisGridSize } from '../genesis';
import type { GenesisReport } from '../genesis/types';
import { estimateWorldPreparation } from './memory';
import type {
  WorldCapability,
  WorldRegionResult,
  WorldRunOptions,
  WorldSampleGrid,
  WorldStageReport,
  WorldGenesisFields,
} from './types';
export { describeWorldGraph } from './capabilities';
export * from './types';
export * from './grid';
export * from './hydrology';

type Channels = {
  height: Float32Array;
  flow: Float32Array;
  wear: Float32Array;
  deposition: Float32Array;
};
// Optional coastal ports are fixed-range scalar fields. They are never
// normalized as erosion diagnostics or retained on unrelated processors.
type Sample = readonly [number, number, number, number, number?, number?];
type Sampler = (x: number, z: number, dx: number, dz: number) => Sample;
const channels = ['height', 'flow', 'wear', 'deposition'] as const;
const F = Math.fround;
const number = (node: TerrainNode, key: string, fallback: number, min = -1e6, max = 1e6) => {
  const value = Number(node.params[key] ?? fallback);
  return clamp(Number.isFinite(value) ? value : fallback, min, max);
};
const text = (node: TerrainNode, key: string, fallback: string) =>
  String(node.params[key] ?? fallback);
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('World build cancelled.', 'AbortError');
}
const channelIndex = (channel: string) =>
  Math.max(0, channels.indexOf(channel as (typeof channels)[number])) as 0 | 1 | 2 | 3;

export interface WorldPrepareOptions extends WorldRunOptions {
  previewNodeId?: string;
  pointwiseBackend?: PointwiseBackend;
}
export interface PreparedWorldEvaluation {
  readonly stages: WorldStageReport[];
  readonly capability: WorldCapability;
  readonly computeCapability: ComputeCapability;
  readonly transportBudget?: WorldMassBudget;
  readonly genesisReport?: GenesisReport;
  sampleRegion(grid: WorldSampleGrid, options?: WorldRunOptions): Promise<WorldRegionResult>;
  dispose(): void;
}

function operation(node: TerrainNode): PointwiseOperation | null {
  if (node.kind === 'remap')
    return {
      kind: 'remap',
      contrast: number(node, 'contrast', 1.05, 0.05, 5),
      brightness: number(node, 'brightness', 0, -1, 1),
      gamma: number(node, 'gamma', 1, 0.1, 5),
      clamp: node.params.clamp !== false,
    };
  if (node.kind === 'terrace')
    return {
      kind: 'terrace',
      steps: Math.round(number(node, 'steps', 12, 2, 80)),
      softness: number(node, 'softness', 0.3, 0.001, 1),
    };
  if (node.kind === 'blend') {
    const mode = text(node, 'mode', 'mix');
    return {
      kind: 'blend',
      mode: ['add', 'multiply', 'min', 'max'].includes(mode)
        ? (mode as 'add' | 'multiply' | 'min' | 'max')
        : 'mix',
      amount: number(node, 'amount', 0.35, 0, 1),
    };
  }
  if (node.kind === 'mask' && node.params.mode !== 'slope') {
    const low = number(node, 'low', 0.25, 0, 1);
    return {
      kind: 'mask',
      low,
      high: Math.max(low, number(node, 'high', 0.7, 0, 1)),
      softness: number(node, 'softness', 0.15, 0.001, 1),
      invert: node.params.invert === true,
    };
  }
  return null;
}
function scalar(op: PointwiseOperation, a: number, b = 0, mask = 1): number {
  if (op.kind === 'remap') {
    const adjusted = (a - 0.5) * op.contrast + 0.5 + op.brightness;
    const value = Math.sign(adjusted) * Math.pow(Math.abs(adjusted), 1 / op.gamma);
    return F(op.clamp ? clamp(value) : value);
  }
  if (op.kind === 'terrace') {
    const level = a * op.steps,
      floor = Math.floor(level);
    return F(
      (floor + smoothstep(0.5 - op.softness / 2, 0.5 + op.softness / 2, level - floor)) / op.steps,
    );
  }
  if (op.kind === 'mask') {
    const selected =
      smoothstep(op.low - op.softness, op.low + op.softness, a) *
      (1 - smoothstep(op.high - op.softness, op.high + op.softness, a));
    return F(op.invert ? 1 - selected : selected);
  }
  const amount = op.amount * clamp(mask);
  return F(
    op.mode === 'add'
      ? a + b * amount
      : mix(
          a,
          op.mode === 'multiply'
            ? a * b
            : op.mode === 'min'
              ? Math.min(a, b)
              : op.mode === 'max'
                ? Math.max(a, b)
                : b,
          amount,
        ),
  );
}

/**
 * Prepare global context once, then evaluate bounded strips or tiles. Each
 * returned field is independently owned; cancellation publishes no partial field.
 */
export async function prepareWorldEvaluation(
  project: TerrainProject,
  world: WorldDefinition,
  options: WorldPrepareOptions = {},
): Promise<PreparedWorldEvaluation> {
  cancelled(options.signal);
  const initialError = validateWorldDefinition(world);
  if (initialError) throw new Error(initialError);
  // Prepared evaluators own their authored snapshot, including nested settings.
  // External edits cannot change a sampler halfway through a tiled export.
  project = structuredClone(project);
  world = structuredClone(world);
  const excludedTransport =
    !!world.transport?.enabled &&
    !!options.previewNodeId &&
    project.graph.nodes.find((node) => node.id === options.previewNodeId)?.kind !== 'output';
  if (excludedTransport && world.transport)
    world = { ...world, transport: { ...world.transport, enabled: false } };
  const excludedGenesis =
    !!world.genesis?.enabled &&
    !!options.previewNodeId &&
    project.graph.nodes.find((node) => node.id === options.previewNodeId)?.kind !== 'output';
  if (excludedGenesis && world.genesis)
    world = { ...world, genesis: { ...world.genesis, enabled: false } };
  const description = describeWorldGraph(project, world, options.previewNodeId);
  if (excludedTransport)
    description.capability.warnings.push(
      'Intermediate and mask previews show authored graph fields before optional post-graph World transport.',
    );
  if (excludedGenesis)
    description.capability.warnings.push(
      'Intermediate and mask previews show authored graph fields before World Genesis.',
    );
  if (!description.capability.supported) throw new Error(description.capability.reason);
  const plan = compileGraph(project, options.previewNodeId),
    d = world.domain,
    n = world.globalResolution;
  const {
    importedBytes,
    globalBytes,
    scratchBytes: globalScratchBytes,
  } = estimateWorldPreparation(project, world, options.previewNodeId);
  const genesisGrid = genesisGridSize(d, n);
  const sampleCosts = new Map<string, number>();
  for (const stage of plan.stages) {
    const node = plan.byId.get(stage.nodeId)!;
    let cost =
      1 + stage.inputs.reduce((sum, input) => sum + (sampleCosts.get(input.nodeId) ?? 1), 0);
    if (node.kind === 'mask' && node.params.mode === 'slope' && !node.bypassed) cost *= 5;
    if (cost > 4096)
      throw new Error(
        'This graph requires too many nested spatial samples. Reduce repeated slope-mask branches or simplify the graph before building a World region.',
      );
    sampleCosts.set(node.id, cost);
  }
  const backend = options.pointwiseBackend ?? (await createPointwiseBackend(world.backend));
  const ownsBackend = !options.pointwiseBackend;
  let disposed = false,
    sampling = false;
  const samplers = new Map<string, Sampler>(),
    normalizers = new Map<string, number>();
  const retained: (Float32Array | Uint8Array)[] = [];
  let transportBudget: WorldMassBudget | undefined, postSampler: Sampler | undefined;
  let genesisReference: WorldGenesisFields | undefined;
  let genesisSampler: Sampler | undefined;
  let geology: ReturnType<typeof createGeologySampler> | undefined;
  const stageById = new Map(description.stages.map((stage) => [stage.nodeId, stage]));
  const check = (signal?: AbortSignal) => {
    if (disposed) throw new Error('This World evaluation has been disposed.');
    cancelled(options.signal);
    cancelled(signal);
  };
  const bounded = (x: number, z: number) =>
    d.boundary === 'periodic'
      ? {
          x: d.originX + ((((x - d.originX) % d.width) + d.width) % d.width),
          z: d.originZ + ((((z - d.originZ) % d.depth) + d.depth) % d.depth),
        }
      : {
          x: clamp(x, d.originX, d.originX + d.width),
          z: clamp(z, d.originZ, d.originZ + d.depth),
        };
  const coarseGrid: WorldSampleGrid = {
    startX: 0,
    startZ: 0,
    cellsX: d.cellsX,
    cellsZ: d.cellsZ,
    samplesX: n,
    samplesZ: n,
  };

  async function renderSampler(
    sampler: Sampler,
    grid: WorldSampleGrid,
    signal?: AbortSignal,
    progress?: (fraction: number, completed: number, total: number) => void,
  ): Promise<Channels> {
    const count = grid.samplesX * grid.samplesZ;
    const field: Channels = {
      height: new Float32Array(count),
      flow: new Float32Array(count),
      wear: new Float32Array(count),
      deposition: new Float32Array(count),
    };
    const dx = gridSpacing(d, grid, 'X'),
      dz = gridSpacing(d, grid, 'Z');
    for (let row = 0; row < grid.samplesZ; row++) {
      const j = gridIndex(d, grid, 'Z', row);
      for (let column = 0; column < grid.samplesX; column++) {
        const i = gridIndex(d, grid, 'X', column),
          p = worldCoordinate(d, i, j);
        const values = sampler(p.x, p.z, dx, dz),
          at = row * grid.samplesX + column;
        for (let c = 0; c < 4; c++) {
          if (!Number.isFinite(values[c]))
            throw new Error('A World stage produced a non-finite value. Reduce its strength.');
          field[channels[c]][at] = values[c]!;
        }
      }
      if ((row & 7) === 7 || row === grid.samplesZ - 1) {
        check(signal);
        progress?.((row + 1) / grid.samplesZ, row + 1, grid.samplesZ);
        await tick();
      }
    }
    check(signal);
    return field;
  }
  const interpolate = (values: Float32Array, x: number, z: number) =>
    sampleHeight(
      values,
      n,
      ((x - d.originX) / d.width) * (n - 1),
      ((z - d.originZ) / d.depth) * (n - 1),
    );
  const interpolateGenesis = (values: ArrayLike<number>, x: number, z: number) => {
    const { width, height } = genesisGrid;
    const u = clamp(((x - d.originX) / d.width) * (width - 1), 0, width - 1);
    const v = clamp(((z - d.originZ) / d.depth) * (height - 1), 0, height - 1);
    const x0 = Math.floor(u),
      z0 = Math.floor(v);
    const x1 = Math.min(width - 1, x0 + 1),
      z1 = Math.min(height - 1, z0 + 1);
    return mix(
      mix(values[z0 * width + x0], values[z0 * width + x1], u - x0),
      mix(values[z1 * width + x0], values[z1 * width + x1], u - x0),
      v - z0,
    );
  };
  const keep = (field: Channels) => {
    for (const key of channels) retained.push(field[key]);
  };
  const normalize = async (id: string, channel: string): Promise<number> => {
    const key = `${id}:${channel}`;
    if (normalizers.has(key)) return normalizers.get(key)!;
    const sampler = samplers.get(id)!,
      c = channelIndex(channel);
    const report = (completed: number) =>
      options.onProgressDetail?.({
        phase: 'preparing',
        stage: `Measuring ${channel} range`,
        progress: completed / n,
        completed,
        total: n,
        unit: 'rows',
      });
    report(0);
    let max = 0;
    for (let j = 0; j < n; j++) {
      const z = d.originZ + (j * d.depth) / (n - 1);
      for (let i = 0; i < n; i++)
        max = Math.max(
          max,
          sampler(d.originX + (i * d.width) / (n - 1), z, d.width / (n - 1), d.depth / (n - 1))[c],
        );
      if ((j & 7) === 7 || j === n - 1) {
        check();
        report(j + 1);
        await tick();
      }
    }
    normalizers.set(key, max);
    return max;
  };
  try {
    for (let stageIndex = 0; stageIndex < plan.stages.length; stageIndex++) {
      check();
      const stage = plan.stages[stageIndex],
        node = plan.byId.get(stage.nodeId)!;
      const detail = (progress: number | null, label = `Preparing · ${node.label}`) =>
        options.onProgressDetail?.({
          phase: 'preparing',
          stage: label,
          progress,
          nodeId: node.id,
          completed: stageIndex,
          total: plan.stages.length,
          unit: 'stages',
          stageIndex: stageIndex + 1,
          stageCount: plan.stages.length,
        });
      detail(null);
      const inputs = new Map<string, Sampler>();
      for (const input of stage.inputs) {
        const original = samplers.get(input.nodeId)!;
        if (input.channel === 'height') inputs.set(input.port, original);
        else if (input.channel === 'shore' || input.channel === 'water') {
          const index = input.channel === 'shore' ? 4 : 5;
          inputs.set(input.port, (x, z, dx, dz) => [
            F(clamp(original(x, z, dx, dz)[index] ?? 0)),
            0,
            0,
            0,
          ]);
        } else {
          const maximum = await normalize(input.nodeId, input.channel),
            c = channelIndex(input.channel);
          inputs.set(input.port, (x, z, dx, dz) => {
            const values = original(x, z, dx, dz);
            const value =
              maximum > 0
                ? clamp(
                    input.channel === 'flow'
                      ? Math.log1p(Math.max(0, values[c])) / Math.log1p(maximum)
                      : values[c] / maximum,
                  )
                : values[c];
            return [F(value), values[1], values[2], values[3]];
          });
        }
      }
      const primary = inputs.get('in') ?? inputs.get('a');
      if (node.bypassed && primary && node.kind !== 'maskOutput')
        samplers.set(
          node.id,
          node.kind === 'coast'
            ? (x, z, dx, dz) => {
                const value = primary(x, z, dx, dz);
                return [value[0], value[1], value[2], value[3]];
              }
            : primary,
        );
      else if (node.kind === 'heightImport') {
        const source = createImportedHeightSampler(node, d.heightScale);
        samplers.set(node.id, (x, z) => [
          F(source.sample((x - d.originX) / d.width, (z - d.originZ) / d.depth)),
          0,
          0,
          0,
        ]);
      } else if (node.kind === 'noise' && node.params.noiseModel === 'v3') {
        const noise = createWorldNoiseSampler(node.params, project.seed, d);
        samplers.set(node.id, (x, z, dx, dz) => [F(noise(x, z, dx, dz)), 0, 0, 0]);
      } else if (node.kind === 'mountain' || node.kind === 'noise') {
        options.onProgress?.(stageIndex / plan.stages.length, `Global source · ${node.label}`);
        const field = evaluateGraph(
          { ...project, worldSize: d.width, heightScale: d.heightScale },
          {
            resolution: n,
            previewNodeId: node.id,
            onProgress: (progress) => {
              check();
              detail(progress, `Global source · ${node.label}`);
              options.onProgress?.(
                (stageIndex + progress) / plan.stages.length,
                `Global source · ${node.label}`,
              );
            },
          },
        ).field;
        keep(field);
        samplers.set(node.id, (x, z) => [
          F(interpolate(field.height, x, z)),
          F(interpolate(field.flow, x, z)),
          F(interpolate(field.wear, x, z)),
          F(interpolate(field.deposition, x, z)),
        ]);
      } else {
        if (!primary) throw new Error(`Connect a height input to “${node.label}”.`);
        if (node.kind === 'coast') {
          options.onProgress?.(stageIndex / plan.stages.length, `Coastal context · ${node.label}`);
          const input = await renderSampler(primary, coarseGrid);
          const level = F(number(node, 'seaLevel', COAST_DEFAULTS.seaLevel, -1, 2));
          const includeLakes = node.params.includeLakes === true;
          check();
          const formed = shapeCoast(input.height, n, {
            worldSize: d.width,
            worldDepth: d.depth,
            heightScale: d.heightScale,
            seaLevel: level,
            beachWidth: number(node, 'beachWidth', COAST_DEFAULTS.beachWidth, 0, 3000),
            shelfWidth: number(node, 'shelfWidth', COAST_DEFAULTS.shelfWidth, 0, 5000),
            beachSlope: number(node, 'beachSlope', COAST_DEFAULTS.beachSlope, 0.1, 35),
            shelfSlope: number(node, 'shelfSlope', COAST_DEFAULTS.shelfSlope, 0.1, 25),
            strength: number(node, 'strength', COAST_DEFAULTS.strength, 0, 1),
            includeLakes,
          });
          check();
          retained.push(input.height, formed.height, formed.shore, formed.water);
          const dryFloor = level + Math.max(2 ** -149, Math.abs(level) * 2 ** -23);
          samplers.set(node.id, (x, z, dx, dz) => {
            const a = primary(x, z, dx, dz);
            const wet = a[0] <= level;
            // Connectivity belongs to the single whole-world reference, never
            // to the requested tile. Keep categorical water binary and avoid
            // classifying dry native detail as ocean after reconstruction.
            const selectedWater = wet && (includeLakes || interpolate(formed.water, x, z) >= 0.5);
            if (wet && !selectedWater) return [a[0], a[1], a[2], a[3], 0, 0];
            const reconstructed =
              a[0] + (interpolate(formed.height, x, z) - interpolate(input.height, x, z));
            const height = wet
              ? Math.min(level, reconstructed)
              : reconstructed <= level
                ? dryFloor
                : reconstructed;
            return [
              F(height),
              a[1],
              a[2],
              a[3],
              F(clamp(interpolate(formed.shore, x, z))),
              selectedWater ? 1 : 0,
            ];
          });
        } else if (node.kind === 'maskOutput') {
          samplers.set(node.id, (x, z, dx, dz) => [F(clamp(primary(x, z, dx, dz)[0])), 0, 0, 0]);
        } else if (isGlobal(node, true)) {
          options.onProgress?.(stageIndex / plan.stages.length, `Global context · ${node.label}`);
          const input = await renderSampler(primary, coarseGrid);
          const maskSampler = inputs.get('mask'),
            mask = maskSampler ? (await renderSampler(maskSampler, coarseGrid)).height : undefined;
          const progress = (fraction: number) => {
            check();
            detail(fraction, `Global solve · ${node.label}`);
            options.onProgress?.(
              (stageIndex + fraction) / plan.stages.length,
              `Global solve · ${node.label}`,
            );
          };
          let formed: Channels;
          if (node.kind === 'hydraulic') {
            const seed =
              ((Number(project.seed) || 0) +
                Math.round(number(node, 'seed', 0, -2147483647, 2147483647))) >>>
              0;
            const result = hydraulicErosion(
              input.height,
              n,
              {
                droplets: number(node, 'droplets', 70000, 0, 500000),
                lifetime: number(node, 'lifetime', 64, 8, 200),
                inertia: number(node, 'inertia', 0.18, 0, 0.95),
                capacity: number(node, 'capacity', 4, 0.1, 20),
                erosion: number(node, 'erosion', 0.28, 0, 1),
                deposition: number(node, 'deposition', 0.28, 0, 1),
                evaporation: number(node, 'evaporation', 0.018, 0.001, 0.5),
                radius: number(node, 'radius', 3, 1, 8),
                gravity: number(node, 'gravity', 4, 0.01, 20),
                seed,
                multiscale: node.params.multiscale !== false,
                method: ['hybrid', 'fluid', 'droplet', 'watershed'].includes(
                  text(node, 'method', 'landscape'),
                )
                  ? (text(node, 'method', 'landscape') as
                      'hybrid' | 'fluid' | 'droplet' | 'watershed')
                  : 'landscape',
                cycles: number(node, 'cycles', 28, 4, 72),
                featureMeters: number(node, 'featureMeters', 140, 24, 600),
                hillslope: number(node, 'hillslope', 0.38, 0, 1),
                bankAngle: number(node, 'bankAngle', 38, 18, 80),
                bedrockPreserve: node.params.bedrockPreserve === true,
                soilDepthMeters: number(node, 'soilDepthMeters', 1.5, 0, 30),
                bedrockResistance: number(node, 'bedrockResistance', 0.6, 0, 1),
                worldSize: d.width,
                heightScale: d.heightScale,
              },
              mask,
              progress,
            );
            formed = result;
            for (let i = 0; i < n * n; i++) {
              formed.flow[i] += input.flow[i];
              formed.wear[i] += input.wear[i];
              formed.deposition[i] += input.deposition[i];
            }
          } else if (node.kind === 'thermal')
            formed = {
              ...input,
              height: thermalErosion(
                input.height,
                n,
                number(node, 'iterations', 20, 0, 150),
                number(node, 'talus', 0.008, 0, 0.2),
                number(node, 'strength', 0.5, 0, 1),
                progress,
              ),
            };
          else
            formed = {
              ...input,
              height: sculptSpline(input.height, n, node.path, {
                mode: text(node, 'mode', 'river') === 'ridge' ? 'ridge' : 'river',
                width: number(node, 'width', 0.016, 0.002, 0.12),
                strength: number(node, 'strength', 0.09, 0, 0.55),
                falloff: number(node, 'falloff', 3, 1.5, 6),
                downhill: node.params.downhill !== false,
                worldSize: d.width,
                heightScale: d.heightScale,
              }),
            };
          const delta = new Float32Array(n * n),
            flowDelta = new Float32Array(n * n),
            wearDelta = new Float32Array(n * n),
            depositionDelta = new Float32Array(n * n);
          for (let i = 0; i < delta.length; i++) {
            delta[i] = formed.height[i] - input.height[i];
            flowDelta[i] = formed.flow[i] - input.flow[i];
            wearDelta[i] = formed.wear[i] - input.wear[i];
            depositionDelta[i] = formed.deposition[i] - input.deposition[i];
          }
          retained.push(delta, flowDelta, wearDelta, depositionDelta);
          if (mask) retained.push(mask);
          samplers.set(node.id, (x, z, dx, dz) => {
            const a = primary(x, z, dx, dz);
            const weight =
              mask && maskSampler
                ? reconstructionWeight(maskSampler(x, z, dx, dz)[0], interpolate(mask, x, z))
                : 1;
            return [
              F(a[0] + interpolate(delta, x, z) * weight),
              F(a[1] + interpolate(flowDelta, x, z)),
              F(a[2] + interpolate(wearDelta, x, z) * weight),
              F(a[3] + interpolate(depositionDelta, x, z) * weight),
            ];
          });
        } else if (node.kind === 'output') samplers.set(node.id, primary);
        else if (node.kind === 'warp') {
          const noise = new Noise(
            ((Number(project.seed) || 0) +
              Math.round(number(node, 'seed', 0, -2147483647, 2147483647))) >>>
              0,
          );
          const strength = number(node, 'strength', 0.35, 0, 2),
            scale = number(node, 'scale', 3, 0.1, 30),
            octaves = Math.round(number(node, 'octaves', 3, 1, 6));
          const displacement = (x: number, z: number, ox: number, oz: number): number => {
            const sample = (px: number, pz: number) =>
              noise.fractal((px / d.width) * scale + ox, (pz / d.depth) * scale + oz, octaves);
            if (d.boundary !== 'periodic') return sample(x, z);
            const p = bounded(x, z),
              u = (p.x - d.originX) / d.width,
              v = (p.z - d.originZ) / d.depth;
            return mix(
              mix(sample(p.x, p.z), sample(p.x - d.width, p.z), quintic(u)),
              mix(sample(p.x, p.z - d.depth), sample(p.x - d.width, p.z - d.depth), quintic(u)),
              quintic(v),
            );
          };
          samplers.set(node.id, (x, z, dx, dz) => {
            const p = bounded(
              x + displacement(x, z, 12.7, 1.9) * strength * d.width * 0.16,
              z + displacement(x, z, 2.3, 41.9) * strength * d.depth * 0.16,
            );
            return primary(p.x, p.z, dx, dz);
          });
        } else if (node.kind === 'mask' && node.params.mode === 'slope') {
          const low = number(node, 'low', 0.25, 0, 1),
            high = Math.max(low, number(node, 'high', 0.7, 0, 1)),
            softness = number(node, 'softness', 0.15, 0.001, 1);
          samplers.set(node.id, (x, z, dx, dz) => {
            const left = bounded(x - dx, z),
              right = bounded(x + dx, z),
              north = bounded(x, z - dz),
              south = bounded(x, z + dz);
            const gx =
              ((primary(right.x, right.z, dx, dz)[0] - primary(left.x, left.z, dx, dz)[0]) *
                d.heightScale) /
              (2 * dx);
            const gz =
              ((primary(south.x, south.z, dx, dz)[0] - primary(north.x, north.z, dx, dz)[0]) *
                d.heightScale) /
              (2 * dz);
            const slope = Math.atan(Math.hypot(gx, gz)) / (Math.PI / 2),
              a = primary(x, z, dx, dz);
            const selected =
              smoothstep(low - softness, low + softness, slope) *
              (1 - smoothstep(high - softness, high + softness, slope));
            return [F(node.params.invert === true ? 1 - selected : selected), a[1], a[2], a[3]];
          });
        } else {
          const op = operation(node);
          if (!op) throw new Error(`“${node.label}” does not have a World evaluator.`);
          const second = inputs.get('b'),
            mask = inputs.get('mask');
          if (op.kind === 'blend' && !second)
            throw new Error(`Connect both A and B inputs to “${node.label}”.`);
          samplers.set(node.id, (x, z, dx, dz) => {
            const a = primary(x, z, dx, dz),
              b = second?.(x, z, dx, dz),
              weight = mask ? mask(x, z, dx, dz)[0] : 1;
            const height = scalar(op, a[0], b?.[0], weight);
            if (op.kind !== 'blend' || !b) return [height, a[1], a[2], a[3]];
            const wb =
              (op.mode === 'max' && b[0] <= a[0]) || (op.mode === 'min' && b[0] >= a[0])
                ? 0
                : op.amount * clamp(weight);
            const wa = op.mode === 'add' ? 1 : 1 - wb;
            return [
              height,
              F(a[1] * wa + b[1] * wb),
              F(a[2] * wa + b[2] * wb),
              F(a[3] * wa + b[3] * wb),
            ];
          });
        }
      }
      options.onProgress?.((stageIndex + 1) / plan.stages.length, `Prepared · ${node.label}`);
      options.onProgressDetail?.({
        phase: 'preparing',
        stage: `Prepared · ${node.label}`,
        progress: 1,
        nodeId: node.id,
        completed: stageIndex + 1,
        total: plan.stages.length,
        unit: 'stages',
        stageIndex: stageIndex + 1,
        stageCount: plan.stages.length,
      });
      await tick();
    }
    if (world.genesis?.enabled) {
      check();
      const sourceSampler = samplers.get(plan.target.id)!;
      const seed = (Number(project.seed) || 0) >>> 0;
      const formed = await prepareGenesis(
        (x, z, dx, dz) => d.datum + sourceSampler(x, z, dx, dz)[0] * d.heightScale,
        d,
        n,
        seed,
        world.genesis,
        {
          signal: options.signal,
          onProgress: (fraction, stage) => {
            check();
            options.onProgress?.(fraction, stage);
            options.onProgressDetail?.({
              phase: 'preparing',
              stage,
              nodeId: 'world-genesis',
              progress: fraction,
            });
          },
        },
      );
      check();
      const delta = new Float32Array(formed.height.length);
      for (let i = 0; i < delta.length; i++)
        delta[i] = (formed.height[i] - formed.sourceHeight[i]) / d.heightScale;
      genesisReference = {
        hardness: formed.hardness,
        lithology: formed.lithology,
        uplift: formed.uplift,
        incision: formed.incision,
        drainageArea: formed.drainageArea,
        channel: formed.channel,
        report: structuredClone(formed.report),
      };
      const reference = genesisReference;
      retained.push(
        delta,
        reference.hardness,
        reference.lithology,
        reference.uplift,
        reference.incision,
        reference.drainageArea,
        reference.channel,
      );
      geology = createGeologySampler(d, seed, world.genesis);
      genesisSampler = (x, z, dx, dz) => {
        const source = sourceSampler(x, z, dx, dz);
        return [
          F(source[0] + interpolateGenesis(delta, x, z)),
          F(interpolateGenesis(reference.drainageArea, x, z)),
          F(source[2] + interpolateGenesis(reference.incision, x, z) / d.heightScale),
          source[3],
        ];
      };
      postSampler = genesisSampler;
      samplers.set(plan.target.id, postSampler);
    }
    if (world.transport?.enabled) {
      check();
      options.onProgress?.(0, 'World transport · preparing global field');
      const sourceSampler = samplers.get(plan.target.id)!;
      const source = await renderSampler(
        sourceSampler,
        coarseGrid,
        options.signal,
        (fraction, completed, total) =>
          options.onProgressDetail?.({
            phase: 'transport',
            stage: 'Preparing transport field',
            progress: fraction,
            completed,
            total,
            unit: 'rows',
          }),
      );
      const metres = Float64Array.from(source.height, (value) => d.datum + value * d.heightScale);
      const transport = await simulateWorldTransport(
        metres,
        {
          width: n,
          height: n,
          widthMeters: d.width,
          depthMeters: d.depth,
          boundary: d.boundary as 'open' | 'closed',
        },
        world.transport,
        {
          signal: options.signal,
          tileCells: world.tileCells,
          onProgress: (fraction) => {
            check();
            options.onProgress?.(fraction, 'World transport · exchanging water and sediment');
            options.onProgressDetail?.({
              phase: 'transport',
              stage: 'Exchanging water and sediment',
              progress: fraction,
              completed: Math.round(fraction * world.transport!.iterations),
              total: world.transport!.iterations,
              unit: 'iterations',
            });
          },
        },
      );
      transportBudget = transport.budget;
      const delta = new Float32Array(n * n),
        flow = new Float32Array(n * n),
        wear = new Float32Array(n * n),
        deposition = new Float32Array(n * n);
      for (let i = 0; i < delta.length; i++) {
        delta[i] = (transport.height[i] - metres[i]) / d.heightScale;
        flow[i] = transport.flow[i];
        wear[i] = source.wear[i] + transport.wear[i] / d.heightScale;
        deposition[i] = source.deposition[i] + transport.deposition[i] / d.heightScale;
      }
      retained.push(delta, flow, wear, deposition);
      postSampler = (x, z, dx, dz) => [
        F(sourceSampler(x, z, dx, dz)[0] + interpolate(delta, x, z)),
        F(interpolate(flow, x, z)),
        F(interpolate(wear, x, z)),
        F(interpolate(deposition, x, z)),
      ];
      samplers.set(plan.target.id, postSampler);
    }
    const hasFlow =
      !!world.transport?.enabled ||
      !!world.genesis?.enabled ||
      plan.stages.some((stage) => {
        const node = plan.byId.get(stage.nodeId)!;
        return node.kind === 'hydraulic' && !node.bypassed;
      });
    const outputFlowMax =
      genesisReference && !world.transport?.enabled
        ? genesisReference.drainageArea.reduce((maximum, value) => Math.max(maximum, value), 0)
        : hasFlow
          ? await normalize(plan.target.id, 'flow')
          : 0;
    const retainedBytes =
      importedBytes +
      [...new Set(retained.map((array) => array.buffer))].reduce(
        (sum, buffer) => sum + buffer.byteLength,
        0,
      );
    const gpuEligible = new Set(
      plan.stages
        .filter((stage) => {
          if (world.transport?.enabled || world.genesis?.enabled) return false;
          const node = plan.byId.get(stage.nodeId)!;
          // GPU results cannot feed a CPU spatial resampler or a precomputed global
          // stage: their boundaries must use one numerical implementation throughout.
          const descendants: string[] = [node.id],
            seen = new Set<string>();
          while (descendants.length) {
            const id = descendants.pop()!;
            if (seen.has(id)) continue;
            seen.add(id);
            const child = plan.byId.get(id)!;
            if (
              id !== node.id &&
              (isGlobal(child, true) ||
                child.kind === 'warp' ||
                (child.kind === 'mask' && child.params.mode === 'slope'))
            )
              return false;
            for (const consumer of plan.stages)
              if (
                consumer.inputs.some((input) => input.nodeId === id && input.channel !== 'height')
              )
                return false;
            descendants.push(...(plan.consumers.get(id) ?? []));
          }
          return (
            !node.bypassed &&
            operation(node) !== null &&
            stage.inputs.every((input) => input.channel === 'height')
          );
        })
        .map((stage) => stage.nodeId),
    );
    for (const id of gpuEligible)
      if (backend.capability.backend === 'webgpu') stageById.get(id)!.backend = 'webgpu';

    // The final preparation/render yield can deliver cancellation too.
    check();
    return {
      stages: description.stages,
      capability: {
        ...description.capability,
        warnings: [
          ...description.capability.warnings,
          ...(world.backend !== 'cpu-reference' && backend.capability.backend !== 'webgpu'
            ? [backend.capability.reason]
            : []),
        ],
      },
      computeCapability: backend.capability,
      transportBudget,
      ...(genesisReference ? { genesisReport: structuredClone(genesisReference.report) } : {}),
      async sampleRegion(grid, run = {}) {
        check(run.signal);
        if (sampling)
          throw new Error('A prepared World evaluation processes one bounded region at a time.');
        validateWorldGrid(d, grid);
        const count = grid.samplesX * grid.samplesZ;
        // Includes retained global fields, region channels, a second render pass,
        // typed-array snapshots and GPU upload/readback staging when selected.
        const peakBytes = Math.max(
          importedBytes + globalBytes + globalScratchBytes,
          retainedBytes + count * (4 * (8 + 4 * plan.stages.length) + (genesisReference ? 42 : 0)),
        );
        if (peakBytes > WORLD_REGION_BUDGET)
          throw new Error(
            `This region needs an estimated ${Math.ceil(peakBytes / 1048576)} MiB, above the 128 MiB World region budget. Request smaller tiles or strips.`,
          );
        sampling = true;
        const started = performance.now(),
          fields = new Map<string, Channels>();
        const dx = gridSpacing(d, grid, 'X'),
          dz = gridSpacing(d, grid, 'Z');
        const localStages = description.stages.map((stage) =>
          stage.mode === 'native'
            ? {
                ...stage,
                samplesX: grid.samplesX,
                samplesZ: grid.samplesZ,
                spacingX: dx,
                spacingZ: dz,
              }
            : { ...stage },
        );
        try {
          for (let index = 0; !postSampler && index < plan.stages.length; index++) {
            check(run.signal);
            const stage = plan.stages[index],
              node = plan.byId.get(stage.nodeId)!;
            const detail = (
              fraction: number | null,
              completed?: number,
              total?: number,
              unit?: 'rows' | 'samples',
            ) =>
              run.onProgressDetail?.({
                phase: 'sampling',
                stage: node.label,
                nodeId: node.id,
                progress: fraction,
                completed,
                total,
                unit,
                stageIndex: index + 1,
                stageCount: plan.stages.length,
              });
            detail(null);
            let field: Channels;
            const inputs = new Map(
              stage.inputs
                .filter((input) => input.channel === 'height')
                .map((input) => [input.port, fields.get(input.nodeId)!]),
            );
            const primary = inputs.get('in') ?? inputs.get('a'),
              second = inputs.get('b'),
              mask = inputs.get('mask');
            const op = operation(node);
            if (node.kind === 'maskOutput' && primary) {
              const zero = new Float32Array(count);
              field = {
                height: primary.height.map((value) => clamp(value)),
                flow: zero,
                wear: zero,
                deposition: zero,
              };
            } else if ((node.bypassed || node.kind === 'output') && primary) field = primary;
            else if (primary && op && stage.inputs.every((input) => input.channel === 'height')) {
              const height =
                backend.capability.backend === 'webgpu' && gpuEligible.has(node.id)
                  ? (await backend.apply(op, primary.height, second?.height, mask?.height)).values
                  : new Float32Array(count);
              const gpu = backend.capability.backend === 'webgpu' && gpuEligible.has(node.id);
              field = { ...primary, height };
              if (op.kind === 'blend') {
                if (!second) throw new Error('Blend needs two connected inputs.');
                field.flow = new Float32Array(count);
                field.wear = new Float32Array(count);
                field.deposition = new Float32Array(count);
              }
              for (let i = 0; i < count; i++) {
                if (!gpu)
                  height[i] = scalar(
                    op,
                    primary.height[i],
                    second?.height[i],
                    mask?.height[i] ?? 1,
                  );
                if (op.kind === 'blend' && second) {
                  const wb =
                      (op.mode === 'max' && second.height[i] <= primary.height[i]) ||
                      (op.mode === 'min' && second.height[i] >= primary.height[i])
                        ? 0
                        : op.amount * clamp(mask?.height[i] ?? 1),
                    wa = op.mode === 'add' ? 1 : 1 - wb;
                  for (const channel of ['flow', 'wear', 'deposition'] as const)
                    field[channel][i] = primary[channel][i] * wa + second[channel][i] * wb;
                }
                if ((i & 32767) === 32767) {
                  check(run.signal);
                  detail((i + 1) / count, i + 1, count, 'samples');
                  await tick();
                }
              }
            } else
              field = await renderSampler(
                samplers.get(node.id)!,
                grid,
                run.signal,
                (fraction, completed, total) => {
                  run.onProgress?.((index + fraction) / plan.stages.length, node.label);
                  detail(fraction, completed, total, 'rows');
                },
              );
            fields.set(node.id, field);
            run.onProgress?.((index + 1) / plan.stages.length, node.label);
            detail(1, count, count, 'samples');
          }
          check(run.signal);
          const output = postSampler
            ? await renderSampler(postSampler, grid, run.signal, (fraction, completed, total) => {
                run.onProgress?.(fraction, 'World formation · reconstructing region');
                run.onProgressDetail?.({
                  phase: 'sampling',
                  stage: 'Reconstructing formed terrain',
                  progress: fraction,
                  completed,
                  total,
                  unit: 'rows',
                });
              })
            : fields.get(plan.target.id)!;
          let genesis: WorldGenesisFields | undefined;
          if (genesisReference && genesisSampler && geology) {
            const reference = genesisReference;
            genesis = {
              hardness: new Float32Array(count),
              lithology: new Uint8Array(count),
              uplift: new Float32Array(count),
              incision: new Float32Array(count),
              drainageArea: new Float32Array(count),
              channel: new Float32Array(count),
              report: structuredClone(reference.report),
            };
            for (let row = 0; row < grid.samplesZ; row++) {
              const j = gridIndex(d, grid, 'Z', row);
              for (let col = 0; col < grid.samplesX; col++) {
                const p = worldCoordinate(d, gridIndex(d, grid, 'X', col), j);
                const i = row * grid.samplesX + col;
                const uplift = interpolateGenesis(reference.uplift, p.x, p.z);
                const elevation =
                  d.datum +
                  (world.transport?.enabled
                    ? genesisSampler(p.x, p.z, dx, dz)[0]
                    : output.height[i]) *
                    d.heightScale;
                const rock = geology.sample(p.x, p.z, elevation, uplift);
                genesis.hardness[i] = rock.hardness;
                genesis.lithology[i] = rock.lithology;
                genesis.uplift[i] = uplift;
                genesis.incision[i] = Math.max(0, interpolateGenesis(reference.incision, p.x, p.z));
                genesis.drainageArea[i] = Math.max(
                  0,
                  interpolateGenesis(reference.drainageArea, p.x, p.z),
                );
                genesis.channel[i] = clamp(interpolateGenesis(reference.channel, p.x, p.z));
              }
              if ((row & 7) === 7 || row === grid.samplesZ - 1) {
                check(run.signal);
                run.onProgressDetail?.({
                  phase: 'sampling',
                  stage: 'Sampling geological fields',
                  progress: (row + 1) / grid.samplesZ,
                  completed: row + 1,
                  total: grid.samplesZ,
                  unit: 'rows',
                });
                await tick();
              }
            }
          }
          check(run.signal);
          let min = Infinity,
            max = -Infinity;
          for (const value of output.height) {
            if (!Number.isFinite(value))
              throw new Error('World output contains non-finite elevations.');
            min = Math.min(min, value);
            max = Math.max(max, value);
          }
          const flow = output.flow.map((value) =>
            outputFlowMax > 0
              ? clamp(Math.log1p(Math.max(0, value)) / Math.log1p(outputFlowMax))
              : value,
          );
          return {
            width: grid.samplesX,
            height: grid.samplesZ,
            heights: output.height,
            flow,
            wear: output.wear,
            deposition: output.deposition,
            min,
            max,
            stages: localStages,
            spacingX: dx,
            spacingZ: dz,
            duration: performance.now() - started,
            backend: localStages.some((stage) => stage.backend === 'webgpu')
              ? 'webgpu'
              : 'cpu-reference',
            estimatedPeakBytes: peakBytes,
            ...(transportBudget ? { transportBudget: { ...transportBudget } } : {}),
            ...(genesis ? { genesis } : {}),
          };
        } finally {
          sampling = false;
          fields.clear();
        }
      },
      dispose() {
        disposed = true;
        samplers.clear();
        retained.length = 0;
        normalizers.clear();
        genesisReference = undefined;
        genesisSampler = undefined;
        postSampler = undefined;
        geology = undefined;
        if (ownsBackend) backend.dispose();
      },
    };
  } catch (error) {
    samplers.clear();
    retained.length = 0;
    if (ownsBackend) backend.dispose();
    throw error;
  }
}

export async function generateWorldRegion(
  project: TerrainProject,
  world: WorldDefinition,
  grid: WorldSampleGrid,
  options: WorldPrepareOptions = {},
): Promise<WorldRegionResult> {
  const prepared = await prepareWorldEvaluation(project, world, options);
  try {
    return await prepared.sampleRegion(grid, options);
  } finally {
    prepared.dispose();
  }
}
