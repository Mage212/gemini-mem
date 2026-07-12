import { MemoryDatabase } from './database';
import { GeminiClient } from '../gemini/client';

export type CompressionJob = {
  observationId: string;
  functionName: string;
  functionArgs?: string;
  functionResult?: string;
};

export type DrainResult = {
  drained: boolean;
  remaining: number;
  waitedMs: number;
};

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Background compression queue for MCP tool handlers.
 * Observations are stored immediately; Gemini compression runs asynchronously.
 */
export class CompressionQueue {
  private queue: CompressionJob[] = [];
  private processing = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private db: MemoryDatabase,
    private gemini: GeminiClient,
    private pollMs = 200
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.processNext();
    }, this.pollMs);
    // Do not keep the process alive solely for the timer (stdio MCP lifecycle).
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      (this.timer as NodeJS.Timeout).unref();
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  enqueue(job: CompressionJob): number {
    this.queue.push(job);
    this.start();
    return this.queue.length;
  }

  get pending(): number {
    return this.queue.length;
  }

  get busy(): boolean {
    return this.processing || this.queue.length > 0;
  }

  /**
   * Wait until the queue is idle (no pending jobs and nothing in-flight),
   * or until timeoutMs elapses. Used before session summarization so
   * freshly recorded observations are compressed when possible.
   */
  async drain(timeoutMs = 60_000): Promise<DrainResult> {
    const started = Date.now();
    this.start();

    while (this.busy) {
      // Keep pumping while waiting so we do not depend only on the poll timer.
      void this.processNext();
      if (Date.now() - started >= timeoutMs) {
        return {
          drained: false,
          remaining: this.queue.length + (this.processing ? 1 : 0),
          waitedMs: Date.now() - started
        };
      }
      await new Promise((r) => setTimeout(r, Math.min(50, this.pollMs)));
    }

    return {
      drained: true,
      remaining: 0,
      waitedMs: Date.now() - started
    };
  }

  private async processNext() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    const job = this.queue.shift();
    if (!job) {
      this.processing = false;
      return;
    }

    try {
      const compressed = await this.gemini.compressObservation({
        functionName: job.functionName,
        functionArgs: job.functionArgs,
        functionResult: job.functionResult
      });
      const originalTokens = estimateTokens(
        `${job.functionArgs || ''}${job.functionResult || ''}`
      );
      const compressedTokens = estimateTokens(compressed);
      this.db.markObservationCompressed(
        job.observationId,
        compressed,
        originalTokens,
        compressedTokens
      );
    } catch (err: any) {
      console.error('[CompressionQueue] failed:', err?.message || err);
      try {
        this.db.markObservationFailed(job.observationId, err?.message || String(err));
      } catch (markErr: any) {
        console.error('[CompressionQueue] mark failed:', markErr?.message || markErr);
      }
    } finally {
      this.processing = false;
    }
  }
}
