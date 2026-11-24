import type { HeightField, TerrainNode, TerrainProject } from '../../model/types';
import type { SedimentBudget } from '../erosion';
import { canonical } from '../plan/graph';

export interface CachedField extends HeightField {
  eroded: number;
  deposited: number;
  exportedSediment: number;
  sedimentBudget?: SedimentBudget;
}
export interface ComputeNodeDiagnostic {
  nodeId: string;
  status: 'hit' | 'computed';
  reason: 'reused' | 'not-cached' | 'inputs-or-settings-changed' | 'evicted';
  durationMs: number;
}
export interface ComputeDiagnostics {
  backend: 'cpu-reference';
  cacheHits: number;
  cacheMisses: number;
  cacheBytes: number;
  cacheBudgetBytes: number;
  estimatedWorkingBytes: number;
  evictions: number;
  nodes: ComputeNodeDiagnostic[];
}

const channels = ['height', 'flow', 'wear', 'deposition'] as const;
const buffersOf = (field: CachedField) => new Set(channels.map((key) => field[key].buffer));

/** Independent, alias-preserving snapshot; transferring it cannot detach cached data. */
export function cloneWorkingField(field: CachedField): CachedField {
  const copies = new Map<Float32Array, Float32Array>();
  const copy = (values: Float32Array) => {
    let result = copies.get(values);
    if (!result) {
      result = values.slice();
      copies.set(values, result);
    }
    return result;
  };
  return {
    ...field,
    height: copy(field.height),
    flow: copy(field.flow),
    wear: copy(field.wear),
    deposition: copy(field.deposition),
    sedimentBudget: field.sedimentBudget ? { ...field.sedimentBudget } : undefined,
  };
}

/**
 * Worker-owned immutable fields. All evaluator operators must treat inputs as
 * immutable, and the evaluator publishes independent snapshots to callers.
 * Unique backing buffers are counted once even when many forwarding stages
 * share a field. Cache admission never raises the existing working-set budget.
 */
export class GraphFieldCache {
  private entries = new Map<string, CachedField>();
  private references = new Map<ArrayBufferLike, number>();
  private identities = new Map<string, string>();
  private previous = new Map<string, string>();
  private serial = 0;
  private currentBytes = 0;
  private limitBytes: number;
  readonly maxBytes: number;
  evictions = 0;

  constructor(maxBytes = 192 * 1024 * 1024) {
    this.maxBytes = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
    this.limitBytes = this.maxBytes;
  }
  get bytes() {
    return this.currentBytes;
  }
  get budgetBytes() {
    return this.limitBytes;
  }
  get size() {
    return this.entries.size;
  }

  prepare(availableBytes: number, nodeIds: Iterable<string>): void {
    this.limitBytes = Number.isFinite(availableBytes)
      ? Math.min(this.maxBytes, Math.max(0, Math.floor(availableBytes)))
      : 0;
    this.trim();
    const present = new Set(nodeIds);
    for (const id of this.previous.keys()) if (!present.has(id)) this.previous.delete(id);
    // Bound metadata too. Clearing interned identities is safe because the
    // monotonic content IDs are never reused, including across cache clears.
    if (this.identities.size > 4096) this.clear();
  }

  identity(
    project: TerrainProject,
    node: TerrainNode,
    resolution: number,
    inputs: { port: string; channel: string; contentId: string }[],
  ): string {
    const signature = canonical({
      implementation: 'cpu-graph-1',
      schema: project.version,
      kind: node.kind,
      params: node.params,
      bypassed: !!node.bypassed,
      path: node.path,
      seed: project.seed,
      worldSize: project.worldSize,
      heightScale: project.heightScale,
      resolution,
      inputs: [...inputs].sort((a, b) => a.port.localeCompare(b.port)),
    });
    let key = this.identities.get(signature);
    if (!key) {
      key = String(++this.serial);
      this.identities.set(signature, key);
    }
    return key;
  }

  lookup(key: string): CachedField | undefined {
    const field = this.entries.get(key);
    if (field) {
      this.entries.delete(key);
      this.entries.set(key, field);
    }
    return field;
  }

  reason(nodeId: string, key: string): ComputeNodeDiagnostic['reason'] {
    const before = this.previous.get(nodeId);
    return before === undefined
      ? 'not-cached'
      : before === key
        ? 'evicted'
        : 'inputs-or-settings-changed';
  }

  /** Publish only after the complete requested field has passed validation. */
  commit(fields: Map<string, CachedField>, nodeKeys: Map<string, string>): void {
    for (const [key, field] of fields) {
      if (this.entries.has(key)) continue;
      const buffers = buffersOf(field);
      // An entry that cannot fit by itself must not evict useful small fields.
      if ([...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0) > this.limitBytes)
        continue;
      this.entries.set(key, field);
      for (const buffer of buffers) {
        const count = this.references.get(buffer) || 0;
        if (count === 0) this.currentBytes += buffer.byteLength;
        this.references.set(buffer, count + 1);
      }
      this.trim();
    }
    this.previous = new Map(nodeKeys);
  }

  clear(): void {
    this.entries.clear();
    this.references.clear();
    this.identities.clear();
    this.previous.clear();
    this.currentBytes = 0;
  }

  private trim(): void {
    while (this.currentBytes > this.limitBytes && this.entries.size) {
      const [key, field] = this.entries.entries().next().value!;
      this.entries.delete(key);
      for (const buffer of buffersOf(field)) {
        const remaining = this.references.get(buffer)! - 1;
        if (remaining > 0) this.references.set(buffer, remaining);
        else {
          this.references.delete(buffer);
          this.currentBytes -= buffer.byteLength;
        }
      }
      this.evictions++;
    }
  }
}
