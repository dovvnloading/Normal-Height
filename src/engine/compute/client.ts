import type {
  EvaluationResult,
  GenerateRequest,
  TerrainProject,
  WorkerResponse,
} from '../../model/types';

export interface TerrainWorkerPort {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: GenerateRequest): void;
  terminate(): void;
}
export interface ComputeCallbacks {
  progress(progress: number, stage: string): void;
  result(result: EvaluationResult): void;
  error(message: string): void;
}

/**
 * An idle worker survives edits, preserving its bounded immutable field cache.
 * Legacy solvers are synchronous, so interrupting a running build terminates
 * that worker. The next build starts fresh; the last published UI field stays
 * intact. Epoch checks also reject already-queued replies from older workers.
 */
export class TerrainComputeClient {
  private worker: TerrainWorkerPort | null = null;
  private epoch = 0;
  private active = false;
  constructor(private readonly createWorker: () => TerrainWorkerPort) {}

  generate(
    project: TerrainProject,
    previewNodeId: string | undefined,
    callbacks: ComputeCallbacks,
  ): void {
    if (this.active) this.reset();
    const id = ++this.epoch;
    try {
      const worker = this.worker || this.createWorker();
      this.worker = worker;
      this.active = true;
      worker.onmessage = (event) => {
        const message = event.data;
        if (id !== this.epoch || message.id !== id || !this.active) return;
        if (message.type === 'progress') callbacks.progress(message.progress, message.stage);
        else {
          this.active = false;
          if (message.type === 'result') callbacks.result(message.result);
          else callbacks.error(message.message);
        }
      };
      worker.onerror = (event) => {
        if (id !== this.epoch) return;
        this.reset();
        callbacks.error(
          event.message ||
            'The terrain worker stopped unexpectedly. Try a lower working resolution.',
        );
      };
      worker.postMessage({
        type: 'generate',
        id,
        project,
        resolution: project.resolution,
        previewNodeId,
      });
    } catch (error) {
      this.reset();
      callbacks.error(
        error instanceof Error ? error.message : 'Could not start terrain generation.',
      );
    }
  }

  cancel(): void {
    if (this.active) this.reset();
  }
  clearCache(): void {
    this.reset();
  }
  dispose(): void {
    this.reset();
  }

  private reset(): void {
    ++this.epoch;
    this.active = false;
    this.worker?.terminate();
    this.worker = null;
  }
}
