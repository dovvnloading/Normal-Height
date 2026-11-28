import type { TerrainEdge, TerrainGraph, TerrainNode } from './types';
import { NODE_DEFINITIONS } from './registry';
import { validSplinePoint, MAX_SPLINE_POINTS } from './splines';

/** One authoring/import/execution contract. Increasing these limits requires
 * qualification of project storage, editor operations and evaluation together. */
export const MAX_GRAPH_NODES = 128;
export const MAX_GRAPH_EDGES = 512;
export const GRAPH_LIMIT_ERROR = `The graph exceeds the ${MAX_GRAPH_NODES}-node or ${MAX_GRAPH_EDGES}-connection limit.`;
export const GRAPH_NODE_LIMIT_ERROR = `This project has reached the ${MAX_GRAPH_NODES}-node limit.`;
const LEGACY_DIAGNOSTIC_OUTPUTS: readonly string[] = ['flow', 'wear', 'deposition'];

export function validGraphIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !['__proto__', 'constructor', 'prototype'].includes(value)
  );
}

export const metadata = (node: TerrainNode) => node.kind === 'note' || node.kind === 'group';
export const primaryInputHandle = (node: TerrainNode) => (node.kind === 'blend' ? 'a' : 'in');
export const inputHandle = (edge: Pick<TerrainEdge, 'targetHandle'>, node: TerrainNode) =>
  edge.targetHandle ?? primaryInputHandle(node);
export const outputHandle = (edge: Pick<TerrainEdge, 'sourceHandle'>) =>
  edge.sourceHandle ?? 'height';

/** Old projects may route diagnostics through processors that forward those fields.
 * New connections should use a declared port; imported legacy routes remain valid. */
export function supportsOutput(node: TerrainNode, handle: string, legacy = true): boolean {
  const outputs = NODE_DEFINITIONS[node.kind].outputs;
  return (
    outputs.some((port) => port.id === handle) ||
    (legacy && outputs.length > 0 && LEGACY_DIAGNOSTIC_OUTPUTS.includes(handle))
  );
}
/** Show only declared ports plus compatibility ports already used by the graph.
 * This keeps saved diagnostic wires visible without expanding every node's UI. */
export function graphOutputPorts(node: TerrainNode, edges: readonly TerrainEdge[]) {
  const declared = NODE_DEFINITIONS[node.kind].outputs;
  const used = new Set(edges.filter((edge) => edge.source === node.id).map(outputHandle));
  const compatibility = LEGACY_DIAGNOSTIC_OUTPUTS.filter(
    (id) => used.has(id) && supportsOutput(node, id) && !declared.some((port) => port.id === id),
  ).map((id) => ({ id, label: `${id[0].toUpperCase()}${id.slice(1)} (legacy)` }));
  return [...declared, ...compatibility];
}

// Bypassed processors forward their primary input; secondary branches are not dependencies.
export const usesInput = (edge: TerrainEdge, node: TerrainNode) =>
  !node.bypassed || inputHandle(edge, node) === primaryInputHandle(node);

/** Structural errors are rejected; unfinished, disconnected nodes may remain on the canvas. */
export function validateGraph(graph: TerrainGraph): string | null {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges))
    return 'This project does not contain a valid terrain graph.';
  if (graph.nodes.length > MAX_GRAPH_NODES || graph.edges.length > MAX_GRAPH_EDGES)
    return GRAPH_LIMIT_ERROR;
  const nodes = new Map<string, TerrainNode>();
  for (const node of graph.nodes) {
    if (!node || typeof node !== 'object' || !validGraphIdentifier(node.id) || nodes.has(node.id))
      return 'Each node must have a unique, nonempty identifier.';
    if (!Object.hasOwn(NODE_DEFINITIONS, node.kind))
      return `Unknown node type: ${String(node.kind)}.`;
    if (!node.params || typeof node.params !== 'object' || Array.isArray(node.params))
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
  for (const node of graph.nodes) {
    const ancestry = new Set([node.id]);
    let parentId = node.parentId;
    while (parentId !== undefined) {
      const parent = nodes.get(parentId);
      if (!parent || parent.kind !== 'group') return 'A group has an invalid parent.';
      if (ancestry.has(parentId)) return 'Groups cannot contain one another in a cycle.';
      ancestry.add(parentId);
      parentId = parent.parentId;
    }
  }
  const ports = new Map<string, Set<string>>(),
    edgeIds = new Set<string>();
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!edge || typeof edge !== 'object' || !validGraphIdentifier(edge.id) || edgeIds.has(edge.id))
      return 'Each connection must have a unique, nonempty identifier.';
    edgeIds.add(edge.id);
    const source = nodes.get(edge.source),
      target = nodes.get(edge.target);
    if (!source || !target) return 'A connection refers to a missing node.';
    if (metadata(source) || metadata(target)) return 'Notes and groups cannot carry terrain data.';
    if (source.id === target.id) return 'A node cannot connect to itself.';
    const handle = inputHandle(edge, target);
    if (!NODE_DEFINITIONS[target.kind].inputs.some((port) => port.id === handle))
      return `“${target.label}” does not have a “${handle}” input.`;
    const sourceHandle = outputHandle(edge);
    if (!supportsOutput(source, sourceHandle))
      return `“${source.label}” does not have a “${sourceHandle}” output.`;
    const targetPorts = ports.get(target.id) ?? new Set<string>();
    if (targetPorts.has(handle))
      return `“${target.label}” already has a connection on its “${handle}” input.`;
    targetPorts.add(handle);
    ports.set(target.id, targetPorts);
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
