import type { TerrainProject } from '../../model/types';
import type { WorldDefinition } from '../../model/world';
import { WORLD_REGION_BUDGET } from '../../model/world';
import { assertRasterBudget, rasterBytes } from '../../model/heightRaster';
import { compileGraph } from '../plan/graph';
import { estimateGenesisPeakBytes, genesisGridSize } from '../genesis';
import { isWorldGlobalNode } from './classification';

export const WORLD_PREPARATION_BUDGET_MESSAGE =
  'The imported rasters and whole-domain reference, formation and transport working fields exceed 128 MiB. Reduce the imported samples, global reference resolution or number of global stages.';

/** One conservative allocation ledger for capability, delivery and evaluator admission.
 * This estimates live application data, not process RSS. No raster is decoded and
 * no simulation-sized arrays are allocated while calculating it.
 */
export function estimateWorldPreparation(
  project: TerrainProject,
  world: WorldDefinition,
  previewNodeId?: string,
) {
  const plan = compileGraph(project, previewNodeId);
  const n = world.globalResolution;
  const post = !previewNodeId || plan.target.kind === 'output';
  const transport = post && !!world.transport?.enabled;
  const genesis = post && !!world.genesis?.enabled;
  const importedNodes = plan.stages
    .map((stage) => plan.byId.get(stage.nodeId)!)
    .filter((node) => node.kind === 'heightImport');
  assertRasterBudget(importedNodes);
  const importedBytes = importedNodes.reduce(
    (sum, node) => sum + (node.raster ? rasterBytes(node.raster) : 0),
    0,
  );
  const importScratch = importedNodes.reduce(
    (maximum, node) => Math.max(maximum, node.raster ? rasterBytes(node.raster) * 3 : 0),
    0,
  );
  const globalStages = plan.stages.filter((stage) =>
    isWorldGlobalNode(plan.byId.get(stage.nodeId)!, stage.inputs.length > 0),
  );
  const dimensions = genesisGridSize(world.domain, n);
  const globalBytes =
    (globalStages.length + (transport ? 1 : 0)) * n * n * 24 +
    (genesis ? dimensions.width * dimensions.height * 25 : 0);
  let scratchBytes = Math.max(
    importScratch,
    transport ? n * n * 224 : 0,
    genesis ? estimateGenesisPeakBytes(world.domain, n) : 0,
  );
  for (const stage of globalStages) {
    const node = plan.byId.get(stage.nodeId)!;
    let scratch = n * n * 24;
    if (node.kind === 'hydraulic') {
      const solver = ['landscape', 'fluid', 'hybrid'].includes(
        String(node.params.method ?? 'landscape'),
      )
        ? Math.min(n, 512)
        : n;
      scratch = n * n * 64 + solver * solver * 224;
    } else if (node.kind === 'thermal') scratch = n * n * 40;
    else if (node.kind === 'spline') scratch = n * n * 56;
    else if (node.kind === 'coast') scratch = n * n * 40 + (n + 1) * 32;
    else if (
      node.kind === 'mountain' &&
      ['fluvial', 'orogenic'].includes(String(node.params.profile))
    )
      scratch = n * n * 160;
    scratchBytes = Math.max(scratchBytes, scratch);
  }
  const peakBytes = importedBytes + globalBytes + scratchBytes;
  return {
    importedBytes,
    globalBytes,
    scratchBytes,
    peakBytes,
    supported: peakBytes <= WORLD_REGION_BUDGET,
  };
}
