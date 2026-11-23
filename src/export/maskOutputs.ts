import { slug } from '../model/project';
import type { TerrainGraph } from '../model/types';

/** Keep the graph node ID as the export target even when several labels slugify to the same name. */
export function listMaskOutputs(graph: TerrainGraph) {
  const used = new Set<string>();
  return graph.nodes.filter((node) => node.kind === 'maskOutput').map((node) => {
    const label = node.label.trim() || 'Mask output';
    const base = slug(label);
    let stem = base;
    let index = 1;
    while (used.has(stem)) stem = `${base}-${++index}`;
    used.add(stem);
    const input = graph.edges.find((edge) => edge.target === node.id);
    return {
      id: node.id,
      label,
      displayName: index === 1 ? label : `${label} (${index})`,
      stem,
      input,
    };
  });
}
