import type { OutboxEvent, OutboxRepository, SharedEventPublisher } from "./types.js";

export interface OutboxPumpOptions {
  workerId: string;
  batchSize?: number;
  leaseMilliseconds?: number;
  maximumRetryDelayMilliseconds?: number;
}

export interface OutboxPumpResult {
  claimed: number;
  published: number;
  failed: number;
}

function sanitizedError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown publisher error";
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 2_000);
}

function retryDelay(event: OutboxEvent, maximum: number): number {
  const exponential = 1_000 * (2 ** Math.min(event.attemptCount, 8));
  return Math.min(maximum, exponential);
}

export class OutboxPump {
  private readonly batchSize: number;
  private readonly leaseMilliseconds: number;
  private readonly maximumRetryDelayMilliseconds: number;

  constructor(
    private readonly repository: OutboxRepository,
    private readonly publisher: SharedEventPublisher,
    private readonly options: OutboxPumpOptions,
  ) {
    this.batchSize = options.batchSize ?? 50;
    this.leaseMilliseconds = options.leaseMilliseconds ?? 30_000;
    this.maximumRetryDelayMilliseconds = options.maximumRetryDelayMilliseconds ?? 300_000;
  }

  async runOnce(): Promise<OutboxPumpResult> {
    const events = await this.repository.claim(this.batchSize, this.options.workerId, this.leaseMilliseconds);
    let published = 0;
    let failed = 0;
    await Promise.all(events.map(async (event) => {
      try {
        await this.publisher.publish(event);
        await this.repository.markPublished(event.eventId, this.options.workerId);
        published += 1;
      } catch (error) {
        failed += 1;
        await this.repository.release(
          event.eventId,
          this.options.workerId,
          sanitizedError(error),
          retryDelay(event, this.maximumRetryDelayMilliseconds),
        );
      }
    }));
    return { claimed: events.length, published, failed };
  }
}
