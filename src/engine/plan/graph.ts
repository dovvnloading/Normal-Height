import type { TerrainEdge, TerrainGraph, TerrainNode, TerrainProject } from '../../model/types';
import { validSplinePoint, MAX_SPLINE_POINTS } from '../../model/splines';
import { NODE_DEFINITIONS } from '../../model/registry';
import { rasterIdentity } from '../../model/heightRaster';

export const metadata = (node: TerrainNode) => node.kind === 'note' || node.kind === 'group';
export const inputHandle = (edge: TerrainEdge, node: TerrainNode) =>
  edge.targetHandle || (node.kind === 'blend' ? 'a' : 'in');
// Bypassed processors forward their primary input; secondary branches are not dependencies.
export const usesInput = (edge: TerrainEdge, node: TerrainNode) =>
  !node.bypassed || inputHandle(edge, node) === (node.kind === 'blend' ? 'a' : 'in');

/** Structural errors are rejected; unfinished, disconnected nodes may remain on the canvas. */
export function validateGraph(graph: TerrainGraph): string | null {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges))
    return 'This project does not contain a valid terrain graph.';
  if (graph.nodes.length > 256 || graph.edges.length > 768)
    return 'The graph exceeds the 256-node or 768-connection limit.';
  const nodes = new Map<string, TerrainNode>();
  for (const node of graph.nodes) {
    if (!node.id || nodes.has(node.id)) return 'Each node must have a unique identifier.';
    if (!Object.hasOwn(NODE_DEFINITIONS, node.kind)) return `Unknown node type: ${String(node.kind)}.`;
    if (!node.params || typeof node.params !== 'object')
      return `“${node.label || node.id}” has invalid parameters.`;
    if (
      node.kind === 'spline' &&
      (!Array.isArray(node.path) ||
        node.path.length < 2 ||
        node.path.length > MAX_SPLINE_POINTS ||
        !node.path.every(validSplinePoint))
    )
      return `“${node.label || node.id}” needs at least two valid spline points.`;
    nodes.set(node.id, node);
  }
  const ports = new Set<string>(),
    edgeIds = new Set<string>();
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!edge.id || edgeIds.has(edge.id)) return 'Each connection must have a unique identifier.';
    edgeIds.add(edge.id);
    const source = nodes.get(edge.source),
      target = nodes.get(edge.target);
    if (!source || !target) return 'A connection refers to a missing node.';
    if (metadata(source) || metadata(target)) return 'Notes and groups cannot carry terrain data.';
    if (source.id === target.id) return 'A node cannot connect to itself.';
    const handle = inputHandle(edge, target);
    if (!NODE_DEFINITIONS[target.kind].inputs.some((port) => port.id === handle))
      return `“${target.label}” does not have a “${handle}” input.`;
    const sourceHandle = edge.sourceHandle || 'height';
    // Preserve legacy diagnostic routes while requiring declared new ports.
    const outputs = NODE_DEFINITIONS[source.kind].outputs;
    const legacyDiagnostic = outputs.length > 0 && ['flow', 'wear', 'deposition'].includes(sourceHandle);
    if (!legacyDiagnostic && !outputs.some((port) => port.id === sourceHandle))
      return `“${source.label}” does not have a “${sourceHandle}” output.`;
    const port = `${target.id}:${handle}`;
    if (ports.has(port))
      return `“${target.label}” already has a connection on its “${handle}” input.`;
    ports.add(port);
    outgoing.set(source.id, [...(outgoing.get(source.id) || []), target.id]);
  }
  const visited = new Set<string>(),
    active = new Set<string>();
  const visit = (id: string): boolean => {
    if (active.has(id)) return false;
    if (visited.has(id)) return true;
    active.add(id);
    for (const next of outgoing.get(id) || []) if (!visit(next)) return false;
    active.delete(id);
    visited.add(id);
    return true;
  };
  for (const node of graph.nodes)
    if (!visit(node.id))
      return 'This connection creates a cycle. Terrain must flow forward through the graph.';
  return null;
}

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
        channel: edge.sourceHandle || 'height',
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
export function semanticProjectSignature(project: TerrainProject, previewNodeId?: string): string {
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
      raster: node.raster && rasterIdentity(node.raster),
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
      sourceHandle: edge.sourceHandle || 'height',
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
