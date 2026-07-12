import type { OutboxEvent, OutboxRepository, SharedEventPublisher } from "./types.js";

export interface OutboxPumpOptions {
  workerId: string;
  batchSize?: number;
  leaseMilliseconds?: number;
  maximumRetryDelayMilliseconds?: number;
  maximumDeliveryAttempts?: number;
}

export interface OutboxPumpResult {
  claimed: number;
  published: number;
  failed: number;
  deadLettered: number;
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
  private readonly maximumDeliveryAttempts: number;

  constructor(
    private readonly repository: OutboxRepository,
    private readonly publisher: SharedEventPublisher,
    private readonly options: OutboxPumpOptions,
  ) {
    this.batchSize = options.batchSize ?? 50;
    this.leaseMilliseconds = options.leaseMilliseconds ?? 30_000;
    this.maximumRetryDelayMilliseconds = options.maximumRetryDelayMilliseconds ?? 300_000;
    this.maximumDeliveryAttempts = options.maximumDeliveryAttempts ?? 12;
    if (!Number.isSafeInteger(this.maximumDeliveryAttempts) || this.maximumDeliveryAttempts < 1) {
      throw new Error("maximumDeliveryAttempts must be a positive integer");
    }
  }

  async runOnce(): Promise<OutboxPumpResult> {
    const events = await this.repository.claim(this.batchSize, this.options.workerId, this.leaseMilliseconds);
    let published = 0;
    let failed = 0;
    let deadLettered = 0;
    // Preserve the repository's durable event order. Membership revocations
    // and workspace mutations for the same aggregate must never overtake one
    // another on the shared stream.
    for (const event of events) {
      try {
        await this.publisher.publish(event);
        await this.repository.markPublished(event.eventId, this.options.workerId);
        published += 1;
      } catch (error) {
        failed += 1;
        const message = sanitizedError(error);
        if (event.attemptCount >= this.maximumDeliveryAttempts) {
          await this.repository.deadLetter(event.eventId, this.options.workerId, message);
          deadLettered += 1;
        } else {
          await this.repository.release(
            event.eventId,
            this.options.workerId,
            message,
            retryDelay(event, this.maximumRetryDelayMilliseconds),
          );
        }
      }
    }
    return { claimed: events.length, published, failed, deadLettered };
  }
}
