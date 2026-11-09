export type NodeKind =
  | 'mountain'
  | 'noise'
  | 'warp'
  | 'hydraulic'
  | 'thermal'
  | 'terrace'
  | 'remap'
  | 'blend'
  | 'mask'
  | 'output'
  | 'note'
  | 'group';
export type ParamValue = number | string | boolean;
export interface TerrainNode {
  id: string;
  kind: NodeKind;
  label: string;
  params: Record<string, ParamValue>;
  position: { x: number; y: number };
  bypassed?: boolean;
  parentId?: string;
  width?: number;
  height?: number;
}
export interface TerrainEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}
export interface TerrainGraph {
  nodes: TerrainNode[];
  edges: TerrainEdge[];
}
export interface TerrainProject {
  version: 1;
  name: string;
  seed: number;
  resolution: number;
  worldSize: number;
  heightScale: number;
  presetId: string;
  graph: TerrainGraph;
}
export interface HeightField {
  resolution: number;
  height: Float32Array;
  flow: Float32Array;
  wear: Float32Array;
  deposition: Float32Array;
}
export interface TerrainStats {
  min: number;
  max: number;
  mean: number;
  eroded: number;
  deposited: number;
  exportedSediment: number;
}
export interface EvaluationResult {
  field: HeightField;
  thumbnails: Record<string, Float32Array>;
  nodeTimings: Record<string, number>;
  stats: TerrainStats;
  duration: number;
  outputNodeId: string;
}
export interface EvaluationOptions {
  resolution: number;
  previewNodeId?: string;
  onProgress?: (progress: number, stage: string) => void;
}
export interface GenerateRequest {
  type: 'generate';
  id: number;
  project: TerrainProject;
  resolution: number;
  previewNodeId?: string;
}
export type WorkerResponse =
  | { type: 'progress'; id: number; progress: number; stage: string }
  | { type: 'result'; id: number; result: EvaluationResult }
  | { type: 'error'; id: number; message: string };
export type MapChannel = 'height' | 'terrain' | 'normal' | 'slope' | 'flow' | 'wear' | 'deposition';
export type ViewMode = '3d' | '2d' | 'split';
export interface ViewSettings {
  material: 'alpine' | 'clay' | 'height';
  sunAzimuth: number;
  sunElevation: number;
  exaggeration: number;
  contours: boolean;
  wireframe: boolean;
  autoRotate: boolean;
}
export interface ParamDefinition {
  key: string;
  label: string;
  type: 'range' | 'number' | 'select' | 'toggle' | 'text';
  default: ParamValue;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  description?: string;
  options?: { value: string; label: string }[];
  section?: string;
}
export interface NodeDefinition {
  kind: NodeKind;
  label: string;
  category: 'Source' | 'Shape' | 'Simulate' | 'Combine' | 'Utility';
  description: string;
  color: string;
  inputs: { id: string; label: string }[];
  outputs: { id: string; label: string }[];
  params: ParamDefinition[];
}
