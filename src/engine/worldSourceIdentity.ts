import type { TerrainProject } from '../model/types';
import type { WorldDefinition } from '../model/world';
import { assertRasterBudget, checkRasterDimensions, rasterBytes } from '../model/heightRaster';
import type { HeightRaster } from '../model/heightRaster';
import { compileGraph } from './plan/graph';
import { worldEvaluationSignature } from './worldPreviewPlan';

const digests = new WeakMap<HeightRaster, { data: string; digest: Promise<string> }>();

function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('World build cancelled.', 'AbortError');
}

/**
 * Raster object IDs are intentionally cheap, process-local UI invalidation
 * tokens. They must never identify a result in a cache that survives a worker.
 * Hash original source content in the worker, one bounded asset at a time.
 */
export async function worldSourceSignature(
  project: TerrainProject,
  world: WorldDefinition,
  previewNodeId?: string,
  signal?: AbortSignal,
): Promise<{ signature: string; persistentSafe: boolean }> {
  cancelled(signal);
  const plan = compileGraph(project, previewNodeId);
  const nodes = plan.stages
    .map((stage) => plan.byId.get(stage.nodeId)!)
    .filter((node) => node.kind === 'heightImport' && node.raster);
  assertRasterBudget(nodes);
  if (!nodes.length)
    return {
      signature: worldEvaluationSignature(project, world, previewNodeId),
      persistentSafe: true,
    };
  // Browsers without secure-context Web Crypto still evaluate imported worlds.
  // Their process-local key may miss a prepared-cache hit, but cannot be used to
  // restore an unrelated source from persistent storage.
  if (!globalThis.crypto?.subtle)
    return {
      signature: worldEvaluationSignature(project, world, previewNodeId),
      persistentSafe: false,
    };
  const keys = new Map<HeightRaster, string>();
  for (const node of nodes) {
    cancelled(signal);
    const raster = node.raster!;
    checkRasterDimensions(raster.width, raster.height);
    if (
      (raster.format !== 'u16le' && raster.format !== 'f32le') ||
      typeof raster.data !== 'string' ||
      raster.data.length !== Math.ceil(rasterBytes(raster) / 3) * 4
    )
      throw new Error('Embedded heightmap length does not match its dimensions.');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raster.data))
      throw new Error('Invalid base64 in embedded heightmap.');
    const cached = digests.get(raster);
    let digest = cached?.data === raster.data ? cached.digest : undefined;
    if (!digest) {
      // Encoded data is ASCII with a bounded length. Decoding/finite-sample
      // validation remains the shared sampler's job before any result is stored.
      digest = crypto.subtle
        .digest('SHA-256', new TextEncoder().encode(raster.data))
        .then((buffer) =>
          Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join(''),
        );
      digests.set(raster, { data: raster.data, digest });
    }
    let value: string;
    try {
      value = await digest;
    } catch {
      digests.delete(raster);
      cancelled(signal);
      return {
        signature: worldEvaluationSignature(project, world, previewNodeId),
        persistentSafe: false,
      };
    }
    cancelled(signal);
    keys.set(raster, `sha256:${value}/${raster.width}x${raster.height}/${raster.format}`);
  }
  return {
    signature: worldEvaluationSignature(project, world, previewNodeId, (raster) =>
      keys.get(raster)!,
    ),
    persistentSafe: true,
  };
}
