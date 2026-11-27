import type { TerrainEdge, TerrainNode, TerrainProject } from '../../model/types';
import { rasterIdentity } from '../../model/heightRaster';
import type { HeightRaster } from '../../model/heightRaster';
import { inputHandle, outputHandle, metadata, usesInput, validateGraph } from '../../model/graph';
export { inputHandle, metadata, usesInput, validateGraph } from '../../model/graph';

export type ExecutionScope = 'pointwise' | 'local' | 'global' | 'iterative';
export interface PlannedStage {
  nodeId: string;
  scope: ExecutionScope;
  inputs: { port: string; nodeId: string; channel: string }[];
}
export interface GraphPlan {
  target: TerrainNode;
  byId: Map<string, TerrainNode>;
  incoming: Map<string, TerrainEdge[]>;
  needed: Set<string>;
  stages: PlannedStage[];
  /** Direct reverse dependencies; disconnected branches are absent. */
  consumers: Map<string, string[]>;
}

/** Compile the active, typed DAG without evaluating or allocating terrain. */
export function compileGraph(project: TerrainProject, previewNodeId?: string): GraphPlan {
  const error = validateGraph(project.graph);
  if (error) throw new Error(error);
  const byId = new Map(project.graph.nodes.map((node) => [node.id, node]));
  const target = previewNodeId
    ? byId.get(previewNodeId)
    : project.graph.nodes.find((node) => node.kind === 'output');
  if (!target || metadata(target))
    throw new Error(
      previewNodeId
        ? 'Choose a terrain node to preview.'
        : 'Add an Output node and connect a terrain to it.',
    );
  const incoming = new Map<string, TerrainEdge[]>();
  for (const edge of project.graph.edges)
    incoming.set(edge.target, [...(incoming.get(edge.target) || []), edge]);
  const needed = new Set<string>();
  const stages: PlannedStage[] = [];
  const consumers = new Map<string, string[]>();
  const visit = (node: TerrainNode) => {
    if (needed.has(node.id)) return;
    needed.add(node.id);
    const inputs = (incoming.get(node.id) || [])
      .filter((edge) => usesInput(edge, node))
      .map((edge) => ({
        port: inputHandle(edge, node),
        nodeId: edge.source,
        channel: outputHandle(edge),
      }));
    for (const input of inputs) {
      visit(byId.get(input.nodeId)!);
      consumers.set(input.nodeId, [...(consumers.get(input.nodeId) || []), node.id]);
    }
    const scope: ExecutionScope =
      node.bypassed && inputs.length > 0
        ? 'pointwise'
        : node.kind === 'hydraulic' || node.kind === 'thermal'
          ? 'iterative'
          : node.kind === 'mountain' || node.kind === 'coast'
            ? 'global'
            : node.kind === 'warp' || node.kind === 'spline'
              ? 'global'
              : node.kind === 'mask' && node.params.mode === 'slope'
                ? 'local'
                : 'pointwise';
    stages.push({ nodeId: node.id, scope, inputs });
  };
  visit(target);
  return { target, byId, incoming, needed, stages, consumers };
}

/** Exact canonical JSON. Cache identities use this string, not a lossy hash. */
export function canonical(value: unknown): string {
  if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0)))
    return `~number:${Object.is(value, -0) ? '-0' : String(value)}`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(',')}}`;
}

/** View-only edits and disconnected experiments do not enqueue a terrain build. */
export function semanticProjectSignature(
  project: TerrainProject,
  previewNodeId?: string,
  rasterSignature: (raster: HeightRaster) => string | number = rasterIdentity,
): string {
  let needed: Set<string> | undefined;
  try {
    needed = compileGraph(project, previewNodeId).needed;
  } catch {
    /* Include malformed edits. */
  }
  const nodes = project.graph.nodes
    .filter((node) => !metadata(node) && (!needed || needed.has(node.id)))
    .map((node) => ({
      id: node.id,
      kind: node.kind,
      params: node.params,
      bypassed: !!node.bypassed,
      path: node.path,
      raster: node.raster && rasterSignature(node.raster),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const byId = new Map(project.graph.nodes.map((node) => [node.id, node]));
  const edges = project.graph.edges
    .filter(
      (edge) => !needed || (needed.has(edge.target) && usesInput(edge, byId.get(edge.target)!)),
    )
    .map((edge) => ({
      source: edge.source,
      target: edge.target,
      sourceHandle: outputHandle(edge),
      targetHandle: byId.has(edge.target)
        ? inputHandle(edge, byId.get(edge.target)!)
        : edge.targetHandle,
    }))
    .sort((a, b) => canonical(a).localeCompare(canonical(b)));
  return canonical({
    seed: project.seed,
    resolution: project.resolution,
    worldSize: project.worldSize,
    heightScale: project.heightScale,
    previewNodeId: previewNodeId || project.graph.nodes.find((node) => node.kind === 'output')?.id,
    nodes,
    edges,
  });
}
