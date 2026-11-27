import type { TerrainProject } from '../../model/types';
import { validateWorldDefinition } from '../../model/world';
import type { WorldDefinition } from '../../model/world';
import { compileGraph } from '../plan/graph';
import type { WorldCapability, WorldStageReport } from './types';
import { GENESIS_ALGORITHM_VERSION } from '../../model/genesis';
import { genesisGridSize } from '../genesis';
import { isWorldGlobalNode } from './classification';
import { estimateWorldPreparation, WORLD_PREPARATION_BUDGET_MESSAGE } from './memory';
export { isWorldGlobalNode } from './classification';

/** Classify every reachable stage before starting allocations or global solves. */
export function describeWorldGraph(
  project: TerrainProject,
  world: WorldDefinition,
  previewNodeId?: string,
): { stages: WorldStageReport[]; capability: WorldCapability } {
  const error = validateWorldDefinition(world);
  if (error) throw new Error(error);
  const plan = compileGraph(project, previewNodeId),
    d = world.domain,
    warnings: string[] = [];
  const transportEnabled =
    !!world.transport?.enabled && !(previewNodeId && plan.target.kind !== 'output');
  const genesisEnabled =
    !!world.genesis?.enabled && !(previewNodeId && plan.target.kind !== 'output');
  if (world.genesis?.enabled && !genesisEnabled)
    warnings.push(
      'Intermediate and mask previews show authored graph fields before World Genesis.',
    );
  if (world.transport?.enabled && !transportEnabled)
    warnings.push(
      'Intermediate and mask previews show authored graph fields before optional post-graph World transport.',
    );
  const stages: WorldStageReport[] = plan.stages.map((stage) => {
    const node = plan.byId.get(stage.nodeId)!,
      global = isWorldGlobalNode(node, stage.inputs.length > 0);
    const simulation =
      node.kind === 'hydraulic' && !['droplet', 'watershed'].includes(String(node.params.method))
        ? Math.min(512, world.globalResolution)
        : world.globalResolution;
    const scope = node.kind === 'warp' ? 'local' : stage.scope;
    let reason = global
      ? `${world.globalResolution} × ${world.globalResolution} whole-domain CPU reference; interpolated to requested samples.`
      : 'Evaluated at canonical world coordinates on the requested sample grid.';
    if (global && ['hydraulic', 'thermal', 'spline'].includes(node.kind))
      reason = `One whole-domain solve; ${simulation} × ${simulation} simulation/reference samples. Its displacement is reconstructed over the native input; no independent tile resets.`;
    if (global && node.kind === 'coast')
      reason = `One ${simulation} × ${simulation} whole-domain coastal connectivity and physical-distance solve; its displacement is reconstructed over native input. Shore and water masks share this reference; no tile-edge ocean seeds.`;
    if (node.kind === 'heightImport')
      reason =
        'Bilinear samples from the original embedded raster across the authored world rectangle; original gain, elevation offset and north/south orientation are preserved.';
    if (node.kind === 'maskOutput')
      reason =
        'Named scalar output clamped to its fixed linear 0–1 range; independent of per-tile extrema and bypass state.';
    if (node.kind === 'mask' && node.params.mode === 'slope')
      reason = 'Physical central differences query the upstream field beyond internal tile edges.';
    if (node.kind === 'warp')
      reason =
        'Bounded world-space displacement queries the same upstream field across tile boundaries.';
    if (node.bypassed && stage.inputs.length && node.kind !== 'maskOutput')
      reason = 'Bypassed: forwards the primary field without scheduling secondary inputs.';
    return {
      nodeId: node.id,
      label: node.label,
      kind: node.kind,
      scope,
      mode: global ? 'reconstructed' : 'native',
      backend: 'cpu-reference',
      algorithmVersion: `world-1/${node.kind}/${node.params.noiseModel ?? 'reference'}`,
      samplesX: global ? simulation : d.cellsX + 1,
      samplesZ: global ? simulation : d.cellsZ + 1,
      spacingX: d.width / (global ? simulation - 1 : d.cellsX),
      spacingZ: d.depth / (global ? simulation - 1 : d.cellsZ),
      simulationResolution: global ? simulation : null,
      reason,
    };
  });
  const graphGlobal = stages.some((stage) => stage.mode !== 'native');
  const legacyGlobal = stages.some((stage) => stage.mode !== 'native' && stage.kind !== 'coast');
  if (genesisEnabled) {
    const grid = genesisGridSize(d, world.globalResolution);
    stages.push({
      nodeId: 'world-genesis',
      label: 'World Genesis',
      kind: 'world-genesis',
      scope: 'iterative',
      mode: 'reconstructed',
      backend: 'cpu-reference',
      algorithmVersion: GENESIS_ALGORITHM_VERSION,
      samplesX: grid.width,
      samplesZ: grid.height,
      spacingX: d.width / (grid.width - 1),
      spacingZ: d.depth / (grid.height - 1),
      simulationResolution: world.globalResolution,
      reason:
        'One whole-domain coarse-to-fine geological solve: uplift, exposed rock competence, implicit stream-power incision and hillslope diffusion. Its displacement is reconstructed over native input; geology is sampled at physical coordinates.',
    });
    warnings.push(
      'World Genesis is an artistic landscape evolution model. Its removed-rock and uplift volumes describe the reference grids, not sediment export or a calibrated geological age. Drainage and incision diagnostics precede optional World transport.',
    );
  }
  if (transportEnabled) {
    stages.push({
      nodeId: 'world-transport',
      label: 'World transport',
      kind: 'world-transport',
      scope: 'iterative',
      mode: 'reconstructed',
      backend: 'cpu-reference',
      algorithmVersion: 'world-transport-1/f64-conservative',
      samplesX: world.globalResolution,
      samplesZ: world.globalResolution,
      spacingX: d.width / (world.globalResolution - 1),
      spacingZ: d.depth / (world.globalResolution - 1),
      simulationResolution: world.globalResolution,
      reason:
        'Experimental whole-domain finite-volume water/sediment and thermal transport. Every shared face is reconciled once; coarse displacement is reconstructed over native graph detail.',
    });
    warnings.push(
      'World transport is an experimental artistic CPU reference, not a calibrated geophysical simulation. Its mass budget is measured before fine-grid reconstruction.',
    );
  }
  const requiresGlobal = graphGlobal || transportEnabled || genesisEnabled;
  let reason: string | undefined;
  if (legacyGlobal && d.width !== d.depth)
    reason =
      'This graph contains square-domain legacy/global stages. Use equal width and depth, or a Noise Studio graph with native World stages for a rectangular world.';
  if (requiresGlobal && d.boundary === 'periodic')
    reason =
      'World Genesis, global transport and legacy solvers do not implement periodic boundary conditions. Use an open or closed domain, or disable global stages.';
  if (d.boundary === 'periodic' && stages.some((stage) => stage.kind === 'heightImport'))
    reason =
      'Imported rasters require an open or closed World domain. Their authored opposite borders are not assumed to be periodic.';
  const missingImport = plan.stages
    .map((stage) => plan.byId.get(stage.nodeId)!)
    .find((node) => node.kind === 'heightImport' && !node.raster);
  if (missingImport)
    reason = `Choose a heightmap file in the inspector for “${missingImport.label}”.`;
  if (!reason && !estimateWorldPreparation(project, world, previewNodeId).supported)
    reason = WORLD_PREPARATION_BUDGET_MESSAGE;
  if (requiresGlobal)
    warnings.push(
      'Global stages retain their bounded reference/simulation spacing. More output samples do not imply finer erosion.',
    );
  if (legacyGlobal) {
    warnings.push(
      'Legacy global solvers retain their authored outer-boundary rules; the World boundary setting does not rewrite their numerical model.',
    );
  }
  if (stages.some((stage) => stage.kind === 'coast' && stage.mode !== 'native'))
    warnings.push(
      'Coastal connectivity and distance are measured once at the reported whole-domain reference resolution. Narrow channels and islands below that spacing are not resolved by increasing export samples. Open and closed domains both seed ocean connectivity only at the outer world boundary.',
    );
  if (
    stages.some(
      (stage) => stage.kind === 'mountain' || (stage.kind === 'noise' && stage.mode !== 'native'),
    )
  )
    warnings.push(
      'Legacy sources are anchored to the whole authored domain; the origin georeferences those fields. Studio v3 sources are anchored to absolute world coordinates.',
    );
  if (
    plan.stages.some((stage) =>
      stage.inputs.some((input) => ['flow', 'wear', 'deposition'].includes(input.channel)),
    )
  )
    warnings.push(
      'Diagnostic routes use one whole-domain normalization at the global reference resolution.',
    );
  if (d.cellsX > 8192 || d.cellsZ > 8192)
    warnings.push(
      'Dimensions above 8192 intervals describe a logical tiled domain; no monolithic allocation or native large-grid erosion is implied.',
    );
  return {
    stages,
    capability: {
      supported: !reason,
      native: !requiresGlobal,
      fullGraph: true,
      requiresGlobal,
      warnings,
      reason,
    },
  };
}
