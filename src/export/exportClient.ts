import type { GenerateRequest, TerrainProject, WorkerResponse } from '../model/types';
import type { ExportFormat } from './heightmap';
import type { EncodeRequest, EncodeResponse } from './exportProtocol';

export type ExportState =
  | { phase: 'idle' }
  | { phase: 'generating'; progress: number; stage: string }
  | { phase: 'encoding'; stage: string }
  | { phase: 'success'; filename: string; bytes: number }
  | { phase: 'error'; message: string }
  | { phase: 'cancelled' };

interface WorkerPort<Request, Response> {
  onmessage: ((event: MessageEvent<Response>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: Request, transfer?: Transferable[]): void;
  terminate(): void;
}

export interface ExportOptions {
  project: TerrainProject;
  resolution: number;
  format: ExportFormat;
  bundle: boolean;
  previewNodeId?: string;
  memoryBudgetMiB: number;
}

export function encodingStage(format: ExportFormat, bundle: boolean): string {
  if (format === 'pbr') return 'Synthesizing material maps and packing ZIP';
  if (format === 'mask16') return bundle ? 'Encoding mask and packing ZIP' : 'Encoding 16-bit mask';
  if (format === 'raw32') return bundle ? 'Writing Float32 elevation and packing ZIP' : 'Writing Float32 elevation';
  return bundle ? 'Encoding map and packing ZIP' : 'Encoding map';
}

const errorText = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

/** One isolated, cancellable export; never share or terminate the viewport worker.
 * A run owns exactly one worker at a time. Both the run id and worker identity
 * guard against queued replies from cancelled, failed, or already-finished phases.
 */
export class TerrainExportClient {
  private generation = 0;
  private active = false;
  private worker: { terminate(): void } | null = null;

  constructor(
    private readonly createTerrain: () => WorkerPort<GenerateRequest, WorkerResponse>,
    private readonly createEncoder: () => WorkerPort<EncodeRequest, EncodeResponse>,
    private readonly download: (blob: Blob, filename: string) => void,
    private readonly publish: (state: ExportState) => void,
  ) {}

  start(options: ExportOptions): void {
    if (this.active) return;
    const id = ++this.generation;
    this.active = true;
    let progress = 0;
    this.publish({
      phase: 'generating',
      progress,
      stage: options.previewNodeId ? 'Preparing mask branch' : 'Preparing full-resolution terrain',
    });
    try {
      const terrain = this.createTerrain();
      this.worker = terrain;
      terrain.onmessage = ({ data }) => {
        if (!this.isCurrent(id, terrain) || data.id !== id) return;
        if (data.type === 'progress') {
          if (Number.isFinite(data.progress)) {
            progress = Math.max(progress, Math.min(1, Math.max(0, data.progress)));
          }
          this.publish({ phase: 'generating', progress, stage: data.stage });
        } else if (data.type === 'error') {
          this.fail(data.message);
        } else {
          this.releaseWorker();
          this.encode(id, options, data.result);
        }
      };
      terrain.onerror = (event) => {
        if (this.isCurrent(id, terrain))
          this.fail(event.message || 'Terrain generation failed. Try a lower resolution.');
      };
      terrain.onmessageerror = () => {
        if (this.isCurrent(id, terrain)) this.fail('Could not read the generated terrain.');
      };
      terrain.postMessage({
        type: 'generate',
        id,
        project: options.project,
        resolution: options.resolution,
        previewNodeId: options.previewNodeId,
      });
    } catch (error) {
      this.fail(errorText(error, 'Could not start terrain generation.'));
    }
  }

  cancel(): void {
    if (!this.active) return;
    this.dispose();
    this.publish({ phase: 'cancelled' });
  }

  /** Unmount/close silently; do not update an unmounted React component. */
  dispose(): void {
    ++this.generation;
    this.active = false;
    this.releaseWorker();
  }

  private encode(id: number, options: ExportOptions, result: Extract<WorkerResponse, { type: 'result' }>['result']): void {
    this.publish({ phase: 'encoding', stage: encodingStage(options.format, options.bundle) });
    try {
      const encoder = this.createEncoder();
      this.worker = encoder;
      encoder.onmessage = ({ data }) => {
        if (!this.isCurrent(id, encoder) || data.id !== id) return;
        if (data.type === 'progress') {
          this.publish({ phase: 'encoding', stage: data.stage });
        } else if (data.type === 'error') {
          this.fail(data.message);
        } else {
          try {
            const blob = new Blob([data.bytes], { type: data.mime });
            this.dispose();
            this.download(blob, data.filename);
            this.publish({ phase: 'success', filename: data.filename, bytes: blob.size });
          } catch (error) {
            this.fail(errorText(error, 'Could not start the download. Try a smaller resolution.'));
          }
        }
      };
      encoder.onerror = (event) => {
        if (this.isCurrent(id, encoder)) this.fail(event.message || 'Could not encode the export.');
      };
      encoder.onmessageerror = () => {
        if (this.isCurrent(id, encoder)) this.fail('Could not read the encoded export.');
      };
      const field = result.field;
      // Source-only graphs can share zero-filled diagnostics. Every transferable
      // must be unique; SharedArrayBuffer is not transferable.
      const transfer = [...new Set([
        field.height.buffer, field.flow.buffer, field.wear.buffer, field.deposition.buffer,
      ])].filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer);
      encoder.postMessage({
        type: 'encode',
        id,
        field,
        project: options.project,
        format: options.format,
        bundle: options.bundle,
        outputNodeId: result.outputNodeId,
        memoryBudgetMiB: options.memoryBudgetMiB,
      }, transfer);
    } catch (error) {
      this.fail(errorText(error, 'Could not start encoding the terrain.'));
    }
  }

  private isCurrent(id: number, worker: { terminate(): void }): boolean {
    return this.active && this.generation === id && this.worker === worker;
  }

  private releaseWorker(): void {
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
  }

  private fail(message: string): void {
    this.dispose();
    this.publish({ phase: 'error', message });
  }
}
