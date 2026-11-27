import { describe, expect, it, vi } from 'vitest';
import { createProject } from '../model/presets';
import { WorldMaterialPreviewClient } from './worldMaterialPreviewClient';
import type { WorldMaterialPreviewInput } from './worldMaterialPreviewClient';
import type {
  WorldMaterialPreview,
  WorldMaterialPreviewRequest,
  WorldMaterialPreviewResponse,
} from './worldMaterialPreview';

class WorkerStub {
  onmessage: ((event: MessageEvent<WorldMaterialPreviewResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  requests: WorldMaterialPreviewRequest[] = [];
  terminated = 0;
  postMessage(request: WorldMaterialPreviewRequest) {
    this.requests.push(request);
  }
  terminate() {
    this.terminated++;
  }
  finish(maps = preview()) {
    const request = this.requests.at(-1)!;
    this.onmessage?.({
      data: { type: 'result', id: request.id, fieldId: request.fieldId, maps },
    } as MessageEvent<WorldMaterialPreviewResponse>);
  }
}
function preview(): WorldMaterialPreview {
  return {
    width: 3,
    height: 2,
    basecolor: new Uint8ClampedArray(24),
    orm: new Uint8ClampedArray(24),
    detailNormal: new Uint8ClampedArray(24),
  };
}
function input(): WorldMaterialPreviewInput {
  const field = {
    resolution: 3,
    height: new Float32Array(6),
    flow: new Float32Array(6),
    wear: new Float32Array(6),
    deposition: new Float32Array(6),
  };
  return {
    project: createProject(),
    ranges: { min: 0, span: 1, wearReference: 1, depositionReference: 1 },
    source: {
      field,
      sampling: {
        grid: {
          width: 3,
          height: 2,
          originX: 0,
          originZ: 0,
          spacingX: 10,
          spacingZ: 20,
          heightScale: 1000,
          datum: 0,
        },
      },
    },
  };
}
const callbacks = () => ({ start: vi.fn(), result: vi.fn(), error: vi.fn() });

describe('World material worker lifecycle', () => {
  it('reuses idle terrain data for material edits without cloning graph assets or detaching original arrays', () => {
    const worker = new WorkerStub(),
      factory = vi.fn(() => worker),
      client = new WorldMaterialPreviewClient(factory);
    const first = input(),
      events = callbacks();
    client.request(first, events);
    expect(worker.requests[0].project.graph).toEqual({ nodes: [], edges: [] });
    expect(first.source.field.height.byteLength).toBe(24);
    worker.finish();
    const edited = {
      ...first,
      project: { ...first.project, surface: { ...first.project.surface!, moisture: 0.9 } },
    };
    client.request(edited, events);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(worker.requests[1].source).toBeUndefined();
    expect(worker.requests[1].fieldId).toBe(worker.requests[0].fieldId);
    worker.finish();
    client.request(edited, events);
    expect(worker.requests).toHaveLength(2);
    expect(events.result).toHaveBeenLastCalledWith(expect.anything(), true);
    client.dispose();
    expect(worker.terminated).toBe(1);
  });

  it('terminates superseded work and rejects stale or malformed results before publication', () => {
    const workers: WorkerStub[] = [];
    const client = new WorldMaterialPreviewClient(() => {
      const worker = new WorkerStub();
      workers.push(worker);
      return worker;
    });
    const first = input(),
      previous = callbacks(),
      current = callbacks();
    client.request(first, previous);
    const late = workers[0].onmessage!;
    client.request({ ...first, project: { ...first.project, seed: 10 } }, current);
    expect(workers[0].terminated).toBe(1);
    const original = workers[0].requests[0];
    late({
      data: { type: 'result', id: original.id, fieldId: original.fieldId, maps: preview() },
    } as MessageEvent<WorldMaterialPreviewResponse>);
    expect(previous.result).not.toHaveBeenCalled();
    workers[1].finish({ ...preview(), width: 2 });
    expect(current.error).toHaveBeenCalledWith(expect.stringMatching(/dimensions/));
    expect(current.result).not.toHaveBeenCalled();
    expect(workers[1].terminated).toBe(1);
    client.request(first, current);
    workers[2].finish();
    expect(current.result).toHaveBeenCalledTimes(1);
    client.dispose();
  });
});
