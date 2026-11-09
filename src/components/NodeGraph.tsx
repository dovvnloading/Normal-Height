import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import {
  Background,
  BackgroundVariant,
  Handle,
  MiniMap,
  NodeResizer,
  Position,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import type { Connection, Edge, Node, NodeProps, OnSelectionChangeParams } from '@xyflow/react';
import {
  Combine,
  Copy,
  Droplets,
  Eye,
  Folder,
  Frame,
  Layers3,
  LayoutGrid,
  Map as MapIcon,
  Minus,
  Mountain,
  Plus,
  Power,
  Scan,
  SlidersHorizontal,
  StickyNote,
  Ungroup,
  Waves,
  Wind,
  Route,
  Workflow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { createNode, NODE_DEFINITIONS } from '../model/registry';
import type { NodeKind, TerrainGraph, TerrainNode } from '../model/types';
import '@xyflow/react/dist/style.css';
import './NodeGraph.css';

export interface NodeGraphProps {
  theme: 'light' | 'dark';
  graph: TerrainGraph;
  onChange: (graph: TerrainGraph, history?: boolean) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  previewNodeId?: string;
  onPreview: (id: string) => void;
  thumbnails?: Record<string, Float32Array>;
  nodeTimings?: Record<string, number>;
  onAdd: () => void;
  onError: (message: string) => void;
}

const NODE_WIDTH = 188;
const ICONS: Record<NodeKind, LucideIcon> = {
  mountain: Mountain,
  noise: Waves,
  warp: Wind,
  spline: Route,
  hydraulic: Droplets,
  thermal: Mountain,
  terrace: Layers3,
  remap: SlidersHorizontal,
  blend: Combine,
  mask: Scan,
  output: Layers3,
  note: StickyNote,
  group: Folder,
};

type EditorNodeData = {
  model: TerrainNode;
  thumbnail?: Float32Array;
  timing?: number;
  previewed: boolean;
  onPreview: (id: string) => void;
  onBypass: (id: string) => void;
  onText: (id: string, text: string) => void;
  onResize: (id: string, bounds: { x: number; y: number; width: number; height: number }) => void;
};
type EditorNode = Node<EditorNodeData, 'terrain' | 'annotation' | 'terrainGroup'>;

function nodeSummary(node: TerrainNode) {
  const p = node.params;
  switch (node.kind) {
    case 'mountain':
      return p.ridges ? `${p.ridges} ridge lines` : 'Connected mountain ranges';
    case 'noise':
      return (
        NODE_DEFINITIONS.noise.params
          .find((param) => param.key === 'mode')
          ?.options?.find((option) => option.value === p.mode)?.label ?? 'Fractal noise'
      );
    case 'spline':
      return `${node.params.mode === 'ridge' ? 'Mountain ridge' : 'River valley'} · ${node.path?.length ?? 0} points`;
    case 'hydraulic':
      return `${Math.round(Number(p.droplets ?? 70000) / 1000)}k drops / 512²`;
    case 'thermal':
      return `${p.iterations ?? 24} relaxation passes`;
    case 'warp':
      return 'Domain displacement';
    case 'terrace':
      return `${p.steps ?? 8} elevation bands`;
    case 'remap':
      return 'Elevation & contrast';
    case 'blend':
      return String(p.mode ?? 'mix').replaceAll('-', ' ');
    case 'mask':
      return String(p.mode ?? p.type ?? 'Elevation mask').replaceAll('-', ' ');
    case 'output':
      return 'Final heightfield';
    default:
      return '';
  }
}

const Thumbnail = memo(function Thumbnail({
  values,
  label,
}: {
  values?: Float32Array;
  label: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, 48, 48);
    if (!values?.length) return;
    const side = Math.round(Math.sqrt(values.length));
    let minimum = Infinity;
    let maximum = -Infinity;
    for (const value of values) {
      if (Number.isFinite(value)) {
        minimum = Math.min(minimum, value);
        maximum = Math.max(maximum, value);
      }
    }
    const span = Math.max(maximum - minimum, 0.00001);
    const pixels = context.createImageData(48, 48);
    for (let y = 0; y < 48; y++) {
      for (let x = 0; x < 48; x++) {
        const sx = Math.min(side - 1, Math.floor((x * side) / 48));
        const sy = Math.min(side - 1, Math.floor((y * side) / 48));
        const value = (values[sy * side + sx] - minimum) / span;
        const light = Math.max(0, Math.min(1, value));
        const i = (y * 48 + x) * 4;
        pixels.data[i] = 25 + light * 202;
        pixels.data[i + 1] = 31 + light * 200;
        pixels.data[i + 2] = 29 + light * 186;
        pixels.data[i + 3] = 255;
      }
    }
    context.putImageData(pixels, 0, 0);
  }, [values]);
  return (
    <div className={`ng-thumbnail ${values?.length ? '' : 'ng-thumbnail-empty'}`}>
      <canvas ref={canvas} width={48} height={48} aria-label={`${label} height preview`} />
      {!values?.length && <Mountain size={20} aria-hidden="true" />}
    </div>
  );
});

const TerrainGraphNode = memo(function TerrainGraphNode({
  id,
  data,
  selected,
}: NodeProps<EditorNode>) {
  const { model, timing } = data;
  const definition = NODE_DEFINITIONS[model.kind];
  const Icon = ICONS[model.kind];
  const portCount = Math.max(definition.inputs.length, definition.outputs.length);
  return (
    <div
      className={`ng-node ${selected ? 'ng-node-selected' : ''} ${data.previewed ? 'ng-node-previewed' : ''} ${model.bypassed ? 'ng-node-bypassed' : ''}`}
      style={{ '--node-color': definition.color } as CSSProperties}
    >
      <div className="ng-node-title">
        <Icon size={14} className="ng-node-icon" aria-hidden="true" />
        <span title={model.label}>{model.label}</span>
        <button
          type="button"
          className={`ng-node-action nodrag nopan ${data.previewed ? 'is-active' : ''}`}
          aria-label={`Preview ${model.label}`}
          title={`Preview ${model.label}`}
          aria-pressed={data.previewed}
          onClick={(event) => {
            event.stopPropagation();
            data.onPreview(id);
          }}
        >
          <Eye size={13} />
        </button>
      </div>
      <div className="ng-node-content">
        <Thumbnail values={data.thumbnail} label={model.label} />
        <div className="ng-node-detail">
          <span className="ng-node-type">{definition.category}</span>
          <span className="ng-node-summary" title={nodeSummary(model)}>
            {nodeSummary(model)}
          </span>
          <div className="ng-node-meta">
            {model.kind === 'output' ? (
              <span className="ng-output-pill">OUTPUT</span>
            ) : model.bypassed ? (
              <span className="ng-bypass-label">Bypassed</span>
            ) : (
              <span>
                {timing === undefined
                  ? 'Ready to build'
                  : `${timing < 10 ? timing.toFixed(1) : Math.round(timing)} ms`}
              </span>
            )}
            {definition.inputs.length > 0 && model.kind !== 'output' && (
              <button
                type="button"
                className="ng-node-action nodrag nopan"
                aria-label={`${model.bypassed ? 'Enable' : 'Bypass'} ${model.label}`}
                title={`${model.bypassed ? 'Enable' : 'Bypass'} node`}
                aria-pressed={Boolean(model.bypassed)}
                onClick={(event) => {
                  event.stopPropagation();
                  data.onBypass(id);
                }}
              >
                <Power size={11} />
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="ng-node-ports">
        {Array.from({ length: portCount }, (_, index) => (
          <div className="ng-port-row" key={index}>
            <span>{definition.inputs[index]?.label}</span>
            <span>{definition.outputs[index]?.label}</span>
          </div>
        ))}
      </div>
      {definition.inputs.map((input, index) => (
        <Handle
          key={`input-${input.id}`}
          type="target"
          position={Position.Left}
          id={input.id}
          className="ng-handle ng-input-handle"
          style={{ top: 109 + index * 18 }}
          aria-label={`${model.label}: ${input.label} input`}
        />
      ))}
      {definition.outputs.map((output, index) => (
        <Handle
          key={`output-${output.id}`}
          type="source"
          position={Position.Right}
          id={output.id}
          className="ng-handle ng-output-handle"
          style={{ top: 109 + index * 18 }}
          aria-label={`${model.label}: ${output.label} output`}
        />
      ))}
    </div>
  );
});

const AnnotationNode = memo(function AnnotationNode({ id, data, selected }: NodeProps<EditorNode>) {
  const [text, setText] = useState(String(data.model.params.text ?? ''));
  useEffect(() => {
    setText(String(data.model.params.text ?? ''));
  }, [data.model.params.text]);
  return (
    <div className={`ng-note ${selected ? 'is-selected' : ''}`}>
      <NodeResizer
        minWidth={180}
        minHeight={110}
        maxWidth={10000}
        maxHeight={10000}
        isVisible={selected}
        color="#967d5b"
        onResizeEnd={(_, bounds) => data.onResize(id, bounds)}
      />
      <div className="ng-note-title">
        <StickyNote size={12} />
        <span>{data.model.label}</span>
      </div>
      <textarea
        className="nodrag nopan nowheel"
        aria-label={`Edit ${data.model.label}`}
        placeholder="Leave a note for your future self…"
        value={text}
        maxLength={4000}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => data.onText(id, text)}
        onKeyDown={(event) => event.stopPropagation()}
        spellCheck={false}
      />
    </div>
  );
});

const TerrainGroupNode = memo(function TerrainGroupNode({
  id,
  data,
  selected,
}: NodeProps<EditorNode>) {
  return (
    <div className={`ng-group ${selected ? 'is-selected' : ''}`}>
      <NodeResizer
        minWidth={240}
        minHeight={170}
        maxWidth={10000}
        maxHeight={10000}
        isVisible={selected}
        color="#678971"
        onResizeEnd={(_, bounds) => data.onResize(id, bounds)}
      />
      <div className="ng-group-title">
        <Folder size={12} />
        <span>{data.model.label}</span>
        <span className="ng-group-caption">GROUP</span>
      </div>
    </div>
  );
});

const nodeTypes = {
  terrain: TerrainGraphNode,
  annotation: AnnotationNode,
  terrainGroup: TerrainGroupNode,
};
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

function absolutePosition(node: TerrainNode, graph: TerrainGraph) {
  const position = { ...node.position };
  let parentId = node.parentId;
  const visited = new Set([node.id]);
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = graph.nodes.find((candidate) => candidate.id === parentId);
    if (!parent) break;
    position.x += parent.position.x;
    position.y += parent.position.y;
    parentId = parent.parentId;
  }
  return position;
}

function connectionError(graph: TerrainGraph, connection: Connection, replacingId?: string) {
  if (!connection.source || !connection.target) return 'Connect an output to an input.';
  if (connection.source === connection.target) return 'A node cannot connect to itself.';
  const source = graph.nodes.find((node) => node.id === connection.source);
  const target = graph.nodes.find((node) => node.id === connection.target);
  if (!source || !target) return 'One of these nodes no longer exists.';
  if (!NODE_DEFINITIONS[source.kind].outputs.some((port) => port.id === connection.sourceHandle))
    return 'Choose a labeled output port.';
  if (!NODE_DEFINITIONS[target.kind].inputs.some((port) => port.id === connection.targetHandle))
    return 'Choose a labeled input port.';
  const edges = graph.edges.filter(
    (edge) =>
      edge.id !== replacingId &&
      !(edge.target === connection.target && edge.targetHandle === connection.targetHandle),
  );
  const queue = [connection.target];
  const visited = new Set<string>();
  while (queue.length) {
    const id = queue.pop()!;
    if (id === connection.source)
      return 'That connection creates a loop. Terrain must flow toward the output.';
    if (visited.has(id)) continue;
    visited.add(id);
    for (const edge of edges) if (edge.source === id) queue.push(edge.target);
  }
  return null;
}

/** Arrange each group independently, treating groups as single units in their parent scope. */
function arrangeGraph(graph: TerrainGraph): TerrainGraph {
  const nodes = graph.nodes.map((node) => ({ ...node, position: { ...node.position } }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const size = (node: TerrainNode) => ({
    width: node.width ?? (node.kind === 'note' ? 220 : NODE_WIDTH),
    height:
      node.height ??
      (node.kind === 'note'
        ? 128
        : 118 +
          Math.max(
            NODE_DEFINITIONS[node.kind].inputs.length,
            NODE_DEFINITIONS[node.kind].outputs.length,
          ) *
            18),
  });
  const layout = (parentId?: string, ancestry = new Set<string>()) => {
    if (parentId && ancestry.has(parentId)) return;
    const nextAncestry = new Set(ancestry);
    if (parentId) nextAncestry.add(parentId);
    const members = nodes.filter((node) => node.parentId === parentId);
    for (const group of members.filter((node) => node.kind === 'group'))
      layout(group.id, nextAncestry);
    const active = members.filter((node) => node.kind !== 'note');
    const memberIds = new Set(active.map((node) => node.id));
    const scopeId = (id: string) => {
      let node = byId.get(id);
      const visited = new Set<string>();
      while (node && !memberIds.has(node.id) && node.parentId && !visited.has(node.id)) {
        visited.add(node.id);
        node = byId.get(node.parentId);
      }
      return node && memberIds.has(node.id) ? node.id : undefined;
    };
    const links = graph.edges
      .map((edge) => ({ source: scopeId(edge.source), target: scopeId(edge.target) }))
      .filter((edge) => edge.source && edge.target && edge.source !== edge.target);
    const ranks = new Map(active.map((node) => [node.id, 0]));
    for (let pass = 0; pass < active.length; pass++) {
      let changed = false;
      for (const edge of links) {
        const rank = Math.min(active.length - 1, (ranks.get(edge.source!) ?? 0) + 1);
        if (rank > (ranks.get(edge.target!) ?? 0)) {
          ranks.set(edge.target!, rank);
          changed = true;
        }
      }
      if (!changed) break;
    }
    const columns = new Map<number, TerrainNode[]>();
    for (const node of active) {
      const rank = ranks.get(node.id)!;
      columns.set(rank, [...(columns.get(rank) ?? []), node]);
    }
    let x = parentId ? 26 : 0;
    let maxBottom = parentId ? 46 : 0;
    for (const rank of [...columns.keys()].sort((a, b) => a - b)) {
      const column = columns.get(rank)!;
      let y = parentId ? 48 : 0;
      for (const node of column) {
        node.position = { x, y };
        y += size(node).height + 44;
      }
      maxBottom = Math.max(maxBottom, y - 44);
      x += Math.max(...column.map((node) => size(node).width)) + 74;
    }
    members
      .filter((node) => node.kind === 'note')
      .forEach((node, index) => {
        node.position = { x: (parentId ? 26 : 0) + index * 250, y: maxBottom + 42 };
      });
    const parent = parentId ? byId.get(parentId) : undefined;
    if (parent) {
      parent.width = Math.max(
        280,
        ...members.map((node) => node.position.x + size(node).width + 26),
      );
      parent.height = Math.max(
        190,
        ...members.map((node) => node.position.y + size(node).height + 26),
      );
    }
  };
  layout();
  return { ...graph, nodes };
}

function GraphCanvas(props: NodeGraphProps) {
  const { graph, selectedId, previewNodeId, thumbnails, nodeTimings, theme } = props;
  const latest = useRef(props);
  latest.current = props;
  const wrapper = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const selected = useRef(new Set(selectedId ? [selectedId] : []));
  const selectedEdges = useRef(new Set<string>());
  const knownIds = useRef(new Set(graph.nodes.map((node) => node.id)));
  const [selectedCount, setSelectedCount] = useState(selectedId ? 1 : 0);
  const [showMap, setShowMap] = useState(false);
  const [zoom, setZoom] = useState(1);
  const {
    fitView,
    zoomIn,
    zoomOut,
    getNodes,
    getEdges,
    getViewport,
    setCenter,
    deleteElements,
    screenToFlowPosition,
  } = useReactFlow<EditorNode, Edge>();
  const [nodes, setNodes, onNodesChange] = useNodesState<EditorNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const preview = useCallback((id: string) => latest.current.onPreview(id), []);
  const bypass = useCallback((id: string) => {
    const current = latest.current.graph;
    latest.current.onChange(
      {
        ...current,
        nodes: current.nodes.map((node) =>
          node.id === id ? { ...node, bypassed: !node.bypassed } : node,
        ),
      },
      true,
    );
  }, []);
  const editText = useCallback((id: string, text: string) => {
    const current = latest.current.graph;
    if (current.nodes.find((node) => node.id === id)?.params.text === text) return;
    latest.current.onChange(
      {
        ...current,
        nodes: current.nodes.map((node) =>
          node.id === id ? { ...node, params: { ...node.params, text } } : node,
        ),
      },
      true,
    );
  }, []);
  const resize = useCallback(
    (id: string, bounds: { x: number; y: number; width: number; height: number }) => {
      const current = latest.current.graph;
      const positions = new Map(getNodes().map((node) => [node.id, node.position]));
      latest.current.onChange(
        {
          ...current,
          nodes: current.nodes.map((node) =>
            node.id === id
              ? {
                  ...node,
                  position: { x: bounds.x, y: bounds.y },
                  width: bounds.width,
                  height: bounds.height,
                }
              : { ...node, position: positions.get(node.id) ?? node.position },
          ),
        },
        true,
      );
    },
    [getNodes],
  );

  useEffect(() => {
    if (dragging.current) return;
    if (selectedId && !selected.current.has(selectedId)) selected.current = new Set([selectedId]);
    if (!selectedId) selected.current.clear();
    const existingIds = new Set(graph.nodes.map((node) => node.id));
    selected.current = new Set([...selected.current].filter((id) => existingIds.has(id)));
    const depth = (model: TerrainNode) => {
      let count = 0;
      let parentId = model.parentId;
      const seen = new Set([model.id]);
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        count++;
        parentId = graph.nodes.find((node) => node.id === parentId)?.parentId;
      }
      return count;
    };
    setNodes(
      [...graph.nodes]
        .sort((a, b) => depth(a) - depth(b))
        .map((model) => ({
          id: model.id,
          type:
            model.kind === 'group'
              ? 'terrainGroup'
              : model.kind === 'note'
                ? 'annotation'
                : 'terrain',
          position: model.position,
          parentId: model.parentId && existingIds.has(model.parentId) ? model.parentId : undefined,
          expandParent: Boolean(model.parentId),
          extent: model.parentId ? 'parent' : undefined,
          selected: selected.current.has(model.id),
          style:
            model.kind === 'group' || model.kind === 'note'
              ? {
                  width: model.width ?? (model.kind === 'group' ? 480 : 220),
                  height: model.height ?? (model.kind === 'group' ? 270 : 128),
                }
              : { width: NODE_WIDTH },
          dragHandle: model.kind === 'group' ? '.ng-group-title' : undefined,
          zIndex: model.kind === 'group' ? -1 : 1,
          ariaLabel: `${model.label}, ${NODE_DEFINITIONS[model.kind].label}`,
          data: {
            model,
            thumbnail: thumbnails?.[model.id],
            timing: nodeTimings?.[model.id],
            previewed: previewNodeId === model.id || (!previewNodeId && model.kind === 'output'),
            onPreview: preview,
            onBypass: bypass,
            onText: editText,
            onResize: resize,
          },
        })),
    );
    setEdges(
      graph.edges.map((edge) => ({
        ...edge,
        sourceHandle: edge.sourceHandle ?? 'height',
        targetHandle: edge.targetHandle ?? 'in',
        type: 'default',
        reconnectable: true,
        selected: selectedEdges.current.has(edge.id),
        style: {
          stroke:
            NODE_DEFINITIONS[graph.nodes.find((node) => node.id === edge.source)?.kind ?? 'noise']
              .color,
          strokeWidth: 1.6,
          opacity: 0.72,
        },
        interactionWidth: 18,
      })),
    );
  }, [
    graph,
    selectedId,
    previewNodeId,
    thumbnails,
    nodeTimings,
    setNodes,
    setEdges,
    preview,
    bypass,
    editText,
    resize,
  ]);

  useEffect(() => {
    const added = graph.nodes.find(
      (node) => node.id === selectedId && !knownIds.current.has(node.id),
    );
    knownIds.current = new Set(graph.nodes.map((node) => node.id));
    if (!added || added.kind === 'group') return;
    const frame = requestAnimationFrame(() => {
      const bounds = wrapper.current?.querySelector('.ng-canvas')?.getBoundingClientRect();
      if (!bounds) return;
      const viewport = getViewport();
      const position = absolutePosition(added, graph);
      const width = added.width ?? NODE_WIDTH;
      const height = added.height ?? 160;
      const x = position.x * viewport.zoom + viewport.x;
      const y = position.y * viewport.zoom + viewport.y;
      if (
        x >= 20 &&
        y >= 20 &&
        x + width * viewport.zoom <= bounds.width - 20 &&
        y + height * viewport.zoom <= bounds.height - 20
      )
        return;
      void setCenter(position.x + width / 2, position.y + height / 2, {
        zoom: viewport.zoom,
        duration: 230,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [graph, selectedId, getViewport, setCenter]);

  const commitPositions = useCallback(() => {
    dragging.current = false;
    const current = latest.current.graph;
    const liveNodes = new Map(getNodes().map((node) => [node.id, node]));
    const nextNodes = current.nodes.map((node) => {
      const live = liveNodes.get(node.id);
      if (!live) return node;
      return {
        ...node,
        position: live.position,
        ...(node.kind === 'group'
          ? {
              width: live.measured?.width ?? node.width,
              height: live.measured?.height ?? node.height,
            }
          : {}),
      };
    });
    const changed = current.nodes.some(
      (node, index) =>
        node.position.x !== nextNodes[index].position.x ||
        node.position.y !== nextNodes[index].position.y ||
        node.width !== nextNodes[index].width ||
        node.height !== nextNodes[index].height,
    );
    if (changed) latest.current.onChange({ ...current, nodes: nextNodes }, true);
  }, [getNodes]);

  const connect = useCallback((connection: Connection, replacingId?: string) => {
    const current = latest.current.graph;
    const error = connectionError(current, connection, replacingId);
    if (error) {
      latest.current.onError(error);
      return;
    }
    latest.current.onChange(
      {
        ...current,
        edges: [
          ...current.edges.filter(
            (edge) =>
              edge.id !== replacingId &&
              !(
                edge.target === connection.target &&
                (edge.targetHandle ?? 'in') === connection.targetHandle
              ),
          ),
          { ...connection, id: replacingId ?? uid('edge') },
        ],
      },
      true,
    );
  }, []);

  const onSelection = useCallback(
    ({ nodes: selection, edges: edgeSelection }: OnSelectionChangeParams<EditorNode>) => {
      if (!getNodes().length && latest.current.graph.nodes.length) return;
      selected.current = new Set(selection.map((node) => node.id));
      selectedEdges.current = new Set(edgeSelection.map((edge) => edge.id));
      setSelectedCount(selection.length);
      const primary = latest.current.selectedId;
      const id =
        primary && selected.current.has(primary) ? primary : (selection.at(-1)?.id ?? null);
      if (id !== primary) latest.current.onSelect(id);
    },
    [getNodes],
  );

  const remove = useCallback(
    ({ nodes: deletedNodes, edges: deletedEdges }: { nodes: EditorNode[]; edges: Edge[] }) => {
      const current = latest.current.graph;
      const nodeIds = new Set(deletedNodes.map((node) => node.id));
      const edgeIds = new Set(deletedEdges.map((edge) => edge.id));
      latest.current.onChange(
        {
          nodes: current.nodes
            .filter((node) => !nodeIds.has(node.id))
            .map((node) =>
              node.parentId && nodeIds.has(node.parentId)
                ? { ...node, parentId: undefined, position: absolutePosition(node, current) }
                : node,
            ),
          edges: current.edges.filter(
            (edge) =>
              !edgeIds.has(edge.id) && !nodeIds.has(edge.source) && !nodeIds.has(edge.target),
          ),
        },
        true,
      );
      if (latest.current.selectedId && nodeIds.has(latest.current.selectedId))
        latest.current.onSelect(null);
    },
    [],
  );

  const addNote = () => {
    if (latest.current.graph.nodes.length >= 128) {
      props.onError('This project has reached the 128-node limit.');
      return;
    }
    const bounds = wrapper.current?.getBoundingClientRect();
    const position = bounds
      ? screenToFlowPosition({
          x: bounds.x + bounds.width / 2 - 100,
          y: bounds.y + bounds.height / 2 - 40,
        })
      : { x: 100, y: 100 };
    const note = createNode('note', position, uid('note'));
    latest.current.onChange(
      { ...latest.current.graph, nodes: [...latest.current.graph.nodes, note] },
      true,
    );
    latest.current.onSelect(note.id);
  };

  const selectedGroup =
    selectedCount === 1
      ? graph.nodes.find((node) => selected.current.has(node.id) && node.kind === 'group')
      : undefined;
  const groupSelection = () => {
    const current = latest.current.graph;
    if (selectedGroup) {
      latest.current.onChange(
        {
          ...current,
          nodes: current.nodes
            .filter((node) => node.id !== selectedGroup.id)
            .map((node) =>
              node.parentId === selectedGroup.id
                ? {
                    ...node,
                    parentId: selectedGroup.parentId,
                    position: {
                      x: node.position.x + selectedGroup.position.x,
                      y: node.position.y + selectedGroup.position.y,
                    },
                  }
                : node,
            ),
        },
        true,
      );
      latest.current.onSelect(null);
      return;
    }
    if (current.nodes.length >= 128) {
      props.onError('This project has reached the 128-node limit.');
      return;
    }
    const members = getNodes().filter((node) => selected.current.has(node.id));
    if (!members.length) return;
    if (members.some((node) => node.parentId || node.data.model.kind === 'group')) {
      latest.current.onError(
        'Select ungrouped nodes to create a group. Select an existing group to ungroup it.',
      );
      return;
    }
    const left = Math.min(...members.map((node) => node.position.x)) - 26;
    const top = Math.min(...members.map((node) => node.position.y)) - 48;
    const right =
      Math.max(...members.map((node) => node.position.x + (node.measured?.width ?? NODE_WIDTH))) +
      26;
    const bottom =
      Math.max(...members.map((node) => node.position.y + (node.measured?.height ?? 140))) + 26;
    if (right - left > 10000 || bottom - top > 10000) {
      props.onError('These nodes are too far apart to group. Move them closer together first.');
      return;
    }
    const group = {
      ...createNode('group', { x: left, y: top }, uid('group')),
      width: right - left,
      height: bottom - top,
    };
    const ids = new Set(members.map((node) => node.id));
    latest.current.onChange(
      {
        ...current,
        nodes: [
          group,
          ...current.nodes.map((node) =>
            ids.has(node.id)
              ? {
                  ...node,
                  parentId: group.id,
                  position: { x: node.position.x - left, y: node.position.y - top },
                }
              : node,
          ),
        ],
      },
      true,
    );
    selected.current = new Set([group.id]);
    latest.current.onSelect(group.id);
  };

  const duplicate = () => {
    const current = latest.current.graph;
    const ids = new Set(selected.current);
    if (!ids.size) return;
    for (let pass = 0; pass < current.nodes.length; pass++)
      for (const node of current.nodes)
        if (node.parentId && ids.has(node.parentId)) ids.add(node.id);
    if (current.nodes.length + ids.size > 128) {
      props.onError('Duplicating this selection would exceed the 128-node limit.');
      return;
    }
    const newIds = new Map([...ids].map((id) => [id, uid('node')]));
    const clones = current.nodes
      .filter((node) => ids.has(node.id))
      .map((node) => ({
        ...node,
        id: newIds.get(node.id)!,
        label: `${node.label} copy`.slice(0, 100),
        params: { ...node.params },
        parentId: node.parentId ? (newIds.get(node.parentId) ?? node.parentId) : undefined,
        position:
          node.parentId && ids.has(node.parentId)
            ? { ...node.position }
            : { x: node.position.x + 32, y: node.position.y + 32 },
      }));
    latest.current.onChange(
      {
        nodes: [...current.nodes, ...clones],
        edges: [
          ...current.edges,
          ...current.edges
            .filter((edge) => ids.has(edge.target))
            .map((edge) => ({
              ...edge,
              id: uid('edge'),
              source: newIds.get(edge.source) ?? edge.source,
              target: newIds.get(edge.target)!,
            })),
        ],
      },
      true,
    );
    selected.current = new Set(newIds.values());
    latest.current.onSelect(clones[0]?.id ?? null);
  };

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]'))
      return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      event.stopPropagation();
      void deleteElements({
        nodes: getNodes()
          .filter((node) => node.selected)
          .map((node) => ({ id: node.id })),
        edges: getEdges()
          .filter((edge) => edge.selected)
          .map((edge) => ({ id: edge.id })),
      });
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      event.stopPropagation();
      duplicate();
    }
    if (event.key === 'Home') {
      event.preventDefault();
      void fitView({ padding: 0.2, duration: 250 });
    }
    if (
      event.key.toLowerCase() === 'f' &&
      !event.ctrlKey &&
      !event.metaKey &&
      selected.current.size
    ) {
      event.preventDefault();
      void fitView({
        nodes: [...selected.current].map((id) => ({ id })),
        padding: 0.5,
        maxZoom: 1.25,
        duration: 250,
      });
    }
  };

  const arrange = () => {
    const next = arrangeGraph(graph);
    if (next.nodes.some((node) => (node.width ?? 0) > 10000 || (node.height ?? 0) > 10000)) {
      props.onError(
        'This group is too large to arrange in one row. Split it into smaller groups first.',
      );
      return;
    }
    props.onChange(next, true);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        void fitView({ padding: 0.18, duration: 300 });
      }),
    );
  };

  return (
    <section
      className="node-graph"
      ref={wrapper}
      onKeyDown={keyDown}
      onKeyUp={(event) => {
        if (
          event.key.startsWith('Arrow') &&
          !(event.target as HTMLElement).closest(
            'input, textarea, select, [contenteditable="true"]',
          )
        )
          commitPositions();
      }}
      aria-label="Terrain node graph"
    >
      <header className="ng-toolbar">
        <div className="ng-panel-title">
          <Workflow size={14} />
          <span>Node graph</span>
          <span className="ng-count">
            {graph.nodes.filter((node) => node.kind !== 'note' && node.kind !== 'group').length}
          </span>
        </div>
        <div className="ng-toolbar-actions">
          <button
            type="button"
            className="ng-tool ng-icon-tool"
            disabled={!selectedCount}
            onClick={duplicate}
            title="Duplicate selection (⌘/Ctrl D)"
            aria-label="Duplicate selected nodes"
          >
            <Copy size={14} />
          </button>
          <button
            type="button"
            className="ng-tool ng-icon-tool"
            disabled={!selectedCount}
            onClick={groupSelection}
            title={selectedGroup ? 'Ungroup nodes' : 'Group selected nodes'}
            aria-label={selectedGroup ? 'Ungroup nodes' : 'Group selected nodes'}
          >
            {selectedGroup ? <Ungroup size={15} /> : <Folder size={15} />}
          </button>
          <button
            type="button"
            className="ng-tool ng-icon-tool"
            onClick={addNote}
            title="Add a note"
            aria-label="Add a note"
          >
            <StickyNote size={14} />
          </button>
          <span className="ng-divider" />
          <button type="button" className="ng-tool ng-add" onClick={props.onAdd}>
            <Plus size={14} />
            <span>Add node</span>
            <kbd>Tab</kbd>
          </button>
        </div>
      </header>
      <div className="ng-canvas">
        <ReactFlow<EditorNode, Edge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={(connection) => connect(connection)}
          onReconnect={(edge, connection) => connect(connection, edge.id)}
          onSelectionChange={onSelection}
          onNodeDragStart={() => {
            dragging.current = true;
          }}
          onNodeDragStop={commitPositions}
          onSelectionDragStart={() => {
            dragging.current = true;
          }}
          onSelectionDragStop={commitPositions}
          onDelete={remove}
          onBeforeDelete={async ({ nodes: candidates, edges: candidatesEdges }) => {
            const explicit = candidates.filter((node) => node.selected);
            const ids = new Set(explicit.map((node) => node.id));
            return {
              nodes: explicit,
              edges: candidatesEdges.filter(
                (edge) => edge.selected || ids.has(edge.source) || ids.has(edge.target),
              ),
            };
          }}
          onMove={(_, viewport) => setZoom(viewport.zoom)}
          onInit={() => {
            requestAnimationFrame(() => {
              void fitView({ padding: 0.18, maxZoom: 1, duration: 0 });
            });
          }}
          onPaneClick={() => props.onSelect(null)}
          onPaneContextMenu={(event) => event.preventDefault()}
          minZoom={0.2}
          maxZoom={2}
          fitView
          fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
          selectionOnDrag
          selectionMode={SelectionMode.Partial}
          panOnDrag={[1, 2]}
          panActivationKeyCode="Space"
          multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
          deleteKeyCode={null}
          snapToGrid
          snapGrid={[8, 8]}
          connectionRadius={24}
          colorMode={theme}
          attributionPosition="bottom-left"
          defaultEdgeOptions={{ type: 'default', interactionWidth: 18 }}
          connectionLineStyle={{ stroke: theme === 'dark' ? '#a3b5a3' : '#6d846d', strokeWidth: 2 }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            color={theme === 'dark' ? '#3b4546' : '#b5beb7'}
            bgColor={theme === 'dark' ? '#222729' : '#e4e7e3'}
            gap={20}
            size={1}
          />
          {showMap && (
            <MiniMap
              className="ng-minimap"
              nodeColor={(node) => NODE_DEFINITIONS[(node as EditorNode).data.model.kind].color}
              maskColor={theme === 'dark' ? '#202626b8' : '#d4ddd6bb'}
              pannable
              zoomable
              position="bottom-right"
            />
          )}
        </ReactFlow>
        {!graph.nodes.length && (
          <div className="ng-empty">
            <Workflow size={26} />
            <strong>Start with a source</strong>
            <span>Add a mountain range or noise, then connect it to an output.</span>
            <button type="button" className="ng-tool ng-add" onClick={props.onAdd}>
              <Plus size={14} />
              Add your first node
            </button>
          </div>
        )}
      </div>
      <footer className="ng-footer">
        <span className="ng-navigation-hint">
          {selectedCount > 1
            ? `${selectedCount} nodes selected`
            : 'Drag to select · Space + drag to pan'}
        </span>
        <div className="ng-footer-tools">
          <button
            type="button"
            className="ng-tool ng-footer-label"
            onClick={arrange}
            title="Arrange nodes by data flow"
          >
            <LayoutGrid size={13} />
            <span>Arrange</span>
          </button>
          <button
            type="button"
            className="ng-tool ng-footer-label"
            onClick={() => {
              void fitView({ padding: 0.18, duration: 250, maxZoom: 1.15 });
            }}
            title="Fit graph (Home)"
          >
            <Frame size={13} />
            <span>Fit</span>
          </button>
          <span className="ng-divider" />
          <button
            type="button"
            className="ng-tool ng-icon-tool"
            onClick={() => {
              void zoomOut({ duration: 150 });
            }}
            aria-label="Zoom out"
          >
            <Minus size={13} />
          </button>
          <span className="ng-zoom">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            className="ng-tool ng-icon-tool"
            onClick={() => {
              void zoomIn({ duration: 150 });
            }}
            aria-label="Zoom in"
          >
            <Plus size={13} />
          </button>
          <span className="ng-divider" />
          <button
            type="button"
            className={`ng-tool ng-icon-tool ${showMap ? 'is-active' : ''}`}
            onClick={() => setShowMap((value) => !value)}
            aria-label="Toggle graph minimap"
            aria-pressed={showMap}
            title="Toggle minimap"
          >
            <MapIcon size={14} />
          </button>
        </div>
      </footer>
    </section>
  );
}

export function NodeGraph(props: NodeGraphProps) {
  return (
    <ReactFlowProvider>
      <GraphCanvas {...props} />
    </ReactFlowProvider>
  );
}

export default NodeGraph;
