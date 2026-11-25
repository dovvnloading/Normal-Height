import {
  worldExportFilename,
  type WorldExportManifest,
  type WorldExportOptions,
  type WorldExportProgress,
  type WorldExportRequest,
  type WorldExportResponse,
} from './worldExport';
import { preflightWorldExport, WORLD_DOWNLOAD_LIMIT_BYTES } from './worldExportPlan';

export interface WorldFileWriter {
  write(data: ArrayBuffer): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export interface WorldFileHandle {
  createWritable(): Promise<WorldFileWriter>;
}

export interface WorldExportWorkerPort {
  onmessage: ((event: MessageEvent<WorldExportResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: WorldExportRequest): void;
  terminate(): void;
}

export type WorldExportPhase =
  'choosing' | 'preparing' | 'range' | 'encoding' | 'masks' | 'packing' | 'saving';
export interface WorldExportReceipt {
  filename: string;
  bytes: number;
  durationMs: number;
  sink: 'memory' | 'file';
  manifest: WorldExportManifest;
  completedAt: number;
}
export type WorldExportState =
  | { status: 'idle' }
  | {
      status: 'running';
      id: number;
      phase: WorldExportPhase;
      stage: string;
      /** Only counted phase work gets a percentage. Compilation and ZIP finalization do not. */
      progress: number | null;
      completed?: number;
      total?: number;
      bytes: number;
      startedAt: number;
      filename: string;
      sink: 'memory' | 'file';
    }
  | { status: 'success'; receipt: WorldExportReceipt }
  | { status: 'error'; message: string; bytes: number }
  | { status: 'cancelled'; bytes: number };

interface Run {
  id: number;
  options: WorldExportOptions;
  sink: 'memory' | 'file';
  startedAt: number;
  filename: string;
  worker: WorldExportWorkerPort | null;
  writer: WorldFileWriter | null;
  chunks: ArrayBuffer[];
  bytes: number;
  sequence: number;
  tail: Promise<void>;
  finishing: boolean;
  lastReportedAt: number;
  phase: WorldExportPhase;
  stage: string;
  detail?: WorldExportProgress;
}

const text = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

/** A job owns its worker, immutable request, and sink through asynchronous picker,
 * write and close boundaries. Retired jobs cannot acknowledge, download or publish.
 * Exactly one chunk is accepted at a time, preserving worker backpressure.
 */
export class WorldExportClient {
  private generation = 0;
  private run: Run | null = null;
  private lastRequest: WorldExportOptions | null = null;

  constructor(
    private readonly createWorker: () => WorldExportWorkerPort,
    private readonly chooseFile: ((filename: string) => Promise<WorldFileHandle>) | undefined,
    private readonly download: (blob: Blob, filename: string) => void,
    private readonly publish: (state: WorldExportState) => void,
    private readonly now: () => number = Date.now,
  ) {}

  get busy(): boolean {
    return this.run !== null;
  }

  start(options: WorldExportOptions, sink: 'memory' | 'file' = 'memory'): void {
    if (this.run) return;
    const id = ++this.generation;
    try {
      const snapshot = structuredClone({ ...options, sink });
      this.lastRequest = snapshot;
      preflightWorldExport(snapshot);
      if (sink === 'file' && !this.chooseFile)
        throw new Error(
          'Direct file saving is unavailable in this browser. Use a browser download or reduce the package size.',
        );
      const run: Run = {
        id,
        options: snapshot,
        sink,
        startedAt: this.now(),
        filename: worldExportFilename(snapshot),
        worker: null,
        writer: null,
        chunks: [],
        bytes: 0,
        sequence: 0,
        tail: Promise.resolve(),
        finishing: false,
        lastReportedAt: -Infinity,
        phase: sink === 'file' ? 'choosing' : 'preparing',
        stage:
          sink === 'file' ? 'Choose where to save the world package' : 'Preparing world package',
      };
      // Reservation occurs before the native picker and before React can render.
      this.run = run;
      this.report(run);
      void this.begin(run);
    } catch (error) {
      if (id === this.generation)
        this.publish({
          status: 'error',
          message: text(error, 'Could not start world export.'),
          bytes: 0,
        });
    }
  }

  retry(): void {
    if (this.lastRequest) this.start(this.lastRequest, this.lastRequest.sink ?? 'memory');
  }

  cancel(): void {
    const run = this.run;
    if (!run) return;
    this.release(run, true);
    this.publish({ status: 'cancelled', bytes: run.bytes });
  }

  /** Silent unmount cleanup, including a picker that has not resolved yet. */
  dispose(): void {
    const run = this.run;
    if (run) this.release(run, true);
    else ++this.generation;
  }

  private current(run: Run): boolean {
    return this.run === run && this.generation === run.id;
  }

  private async begin(run: Run): Promise<void> {
    try {
      if (run.sink === 'file') {
        const handle = await this.chooseFile!(run.filename);
        if (!this.current(run)) return;
        const writer = await handle.createWritable();
        if (!this.current(run)) {
          await writer.abort().catch(() => {});
          return;
        }
        run.writer = writer;
      }
      if (!this.current(run)) return;
      const worker = this.createWorker();
      run.worker = worker;
      run.phase = 'preparing';
      run.stage = 'Preparing world package';
      this.report(run);
      worker.onmessage = ({ data }) => {
        if (!this.current(run) || run.worker !== worker || data.id !== run.id) return;
        if (data.type === 'progress') {
          if (run.finishing) return;
          run.detail = data.detail;
          run.stage = data.stage;
          run.phase =
            data.detail?.phase === 'range'
              ? 'range'
              : data.detail?.phase === 'encode'
                ? 'encoding'
                : data.detail?.phase === 'masks'
                  ? 'masks'
                  : data.detail?.phase === 'archive'
                    ? 'packing'
                    : 'preparing';
          this.report(run);
          return;
        }
        if (data.type === 'error') {
          this.fail(run, data.message);
          return;
        }
        // Also serialize fault-injected or queued messages. Completion cannot
        // race the final write even when an event is delivered before its ACK.
        run.tail = run.tail
          .then(async () => {
            if (!this.current(run) || run.worker !== worker) return;
            if (data.type === 'chunk') await this.chunk(run, worker, data);
            else await this.complete(run, data);
          })
          .catch((error: unknown) =>
            this.fail(run, text(error, 'Could not save the world package.')),
          );
      };
      worker.onerror = (event) => {
        if (this.current(run) && run.worker === worker)
          this.fail(run, event.message || 'World export stopped unexpectedly. Retry the package.');
      };
      worker.onmessageerror = () => {
        if (this.current(run) && run.worker === worker)
          this.fail(run, 'Could not read the exported data. Retry the package.');
      };
      worker.postMessage({ type: 'export', id: run.id, options: run.options });
    } catch (error) {
      if (!this.current(run)) return;
      if (error instanceof DOMException && error.name === 'AbortError') this.cancel();
      else this.fail(run, text(error, 'Could not start world export.'));
    }
  }

  private async chunk(
    run: Run,
    worker: WorldExportWorkerPort,
    data: Extract<WorldExportResponse, { type: 'chunk' }>,
  ): Promise<void> {
    if (run.finishing || data.sequence !== run.sequence)
      throw new Error('World export chunks arrived out of order. Retry the package.');
    if (run.writer) {
      await run.writer.write(data.bytes);
      if (!this.current(run)) return;
    } else {
      if (run.bytes + data.bytes.byteLength > WORLD_DOWNLOAD_LIMIT_BYTES)
        throw new Error(
          'The archive exceeded the 192 MiB download budget. Save directly to file or export a smaller region.',
        );
      run.chunks.push(data.bytes);
    }
    run.bytes += data.bytes.byteLength;
    run.sequence++;
    this.report(run, false);
    if (this.current(run) && run.worker === worker)
      worker.postMessage({ type: 'ack', id: run.id, sequence: data.sequence });
  }

  private async complete(
    run: Run,
    data: Extract<WorldExportResponse, { type: 'complete' }>,
  ): Promise<void> {
    if (run.finishing) return;
    run.finishing = true;
    run.phase = 'saving';
    run.stage = run.writer ? 'Finishing file save' : 'Preparing browser download';
    run.detail = undefined;
    this.report(run);
    if (run.writer) {
      await run.writer.close();
      if (!this.current(run)) return;
      run.writer = null;
    } else {
      this.download(new Blob(run.chunks, { type: 'application/zip' }), data.filename);
    }
    if (!this.current(run)) return;
    const receipt: WorldExportReceipt = {
      filename: data.filename,
      bytes: run.bytes,
      durationMs: Math.max(0, this.now() - run.startedAt),
      sink: run.sink,
      manifest: data.manifest,
      completedAt: this.now(),
    };
    this.release(run, false);
    this.publish({ status: 'success', receipt });
  }

  private report(run: Run, force = true): void {
    if (!this.current(run)) return;
    const now = this.now();
    if (!force && now - run.lastReportedAt < 100) return;
    run.lastReportedAt = now;
    const detail = run.detail;
    const counted =
      detail?.phase !== 'archive' &&
      detail?.total !== undefined &&
      detail.total > 0 &&
      Number.isFinite(detail.total) &&
      detail.completed !== undefined &&
      Number.isFinite(detail.completed);
    this.publish({
      status: 'running',
      id: run.id,
      phase: run.phase,
      stage: run.stage,
      progress: counted ? Math.max(0, Math.min(1, detail!.completed! / detail!.total!)) : null,
      ...(counted ? { completed: detail!.completed, total: detail!.total } : {}),
      bytes: run.bytes,
      startedAt: run.startedAt,
      filename: run.filename,
      sink: run.sink,
    });
  }

  private fail(run: Run, message: string): void {
    if (!this.current(run)) return;
    this.release(run, true);
    this.publish({ status: 'error', message, bytes: run.bytes });
  }

  private release(run: Run, abort: boolean): void {
    if (this.run !== run) return;
    ++this.generation;
    this.run = null;
    const worker = run.worker;
    run.worker = null;
    try {
      worker?.terminate();
    } catch {
      /* A failed worker cannot prevent sink cleanup. */
    }
    const writer = run.writer;
    run.writer = null;
    if (abort && writer) {
      try {
        void writer.abort().catch(() => {});
      } catch {
        /* Best-effort cleanup also covers faulty writable implementations. */
      }
    }
    run.chunks.length = 0;
  }
}
