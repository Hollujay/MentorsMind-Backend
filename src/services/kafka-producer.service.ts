/**
 * Kafka producer adapter (issue #861).
 *
 * ─── Verification status ────────────────────────────────────────────────────
 * The batching, keying and retry bookkeeping here are unit-tested against an
 * injected fake client. The *Kafka transport itself is not*: there is no
 * broker available in CI and no `kafkajs` dependency in `package.json`, so
 * this deliberately talks to a `ProducerClient` interface rather than
 * importing a driver it cannot exercise.
 *
 * Wiring it up means adding `kafkajs`, implementing `ProducerClient` over
 * `kafka.producer()`, and testing that adapter against a real broker. The
 * logic below does not change when that happens — which is the reason it is
 * separated out.
 */

import type { StreamMessage } from './stream-processor.service';

/** Minimal producer contract — one method, so an adapter is trivial. */
export interface ProducerClient {
  send(topic: string, records: ProducerRecord[]): Promise<void>;
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
}

export interface ProducerRecord {
  key: string | null;
  value: string;
  timestamp: string;
  headers?: Record<string, string>;
}

export interface ProducerOptions {
  client: ProducerClient;
  /** Records buffered before an automatic flush. */
  batchSize?: number;
  /** Send attempts before giving up on a batch. */
  maxRetries?: number;
  onError?: (error: Error, attempt: number) => void;
}

export interface PublishStats {
  published: number;
  batches: number;
  retries: number;
  failed: number;
}

/**
 * Serialise a payload for the wire.
 *
 * Rejects values that cannot round-trip rather than shipping `undefined` or a
 * circular-reference crash into the topic, where it becomes a poison message
 * every consumer chokes on.
 */
export function serialiseValue(value: unknown): string {
  if (value === undefined) {
    throw new Error('cannot publish undefined; use null for an empty payload');
  }
  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new Error(
      `payload is not serialisable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export class KafkaProducerService {
  private readonly client: ProducerClient;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private readonly onError?: (error: Error, attempt: number) => void;
  private readonly buffers = new Map<string, ProducerRecord[]>();
  private stats: PublishStats = { published: 0, batches: 0, retries: 0, failed: 0 };

  constructor({ client, batchSize = 100, maxRetries = 3, onError }: ProducerOptions) {
    this.client = client;
    this.batchSize = Math.max(1, batchSize);
    this.maxRetries = Math.max(1, maxRetries);
    this.onError = onError;
  }

  async connect(): Promise<void> {
    await this.client.connect?.();
  }

  /**
   * Buffer a message, flushing when the batch fills.
   *
   * Keyed messages land on the same partition, which is what preserves
   * per-entity ordering — publishing `mentor-42` events with a null key would
   * scatter them across partitions and lose their order.
   */
  async publish<T>(message: Omit<StreamMessage<T>, 'offset'>): Promise<void> {
    const record: ProducerRecord = {
      key: message.key,
      value: serialiseValue(message.value),
      timestamp: String(message.timestamp),
      headers: message.headers,
    };

    const buffer = this.buffers.get(message.topic) ?? [];
    buffer.push(record);
    this.buffers.set(message.topic, buffer);

    if (buffer.length >= this.batchSize) {
      await this.flushTopic(message.topic);
    }
  }

  /** Flush one topic's buffer with bounded retries. */
  async flushTopic(topic: string): Promise<void> {
    const buffer = this.buffers.get(topic);
    if (!buffer || buffer.length === 0) return;

    this.buffers.set(topic, []);
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      try {
        await this.client.send(topic, buffer);
        this.stats.published += buffer.length;
        this.stats.batches += 1;
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.onError?.(lastError, attempt);
        if (attempt < this.maxRetries) this.stats.retries += 1;
      }
    }

    this.stats.failed += buffer.length;
    if (lastError) throw lastError;
  }

  /** Flush every buffered topic. Call before shutdown or messages are lost. */
  async flush(): Promise<void> {
    for (const topic of [...this.buffers.keys()]) {
      await this.flushTopic(topic);
    }
  }

  pendingCount(): number {
    let total = 0;
    for (const buffer of this.buffers.values()) total += buffer.length;
    return total;
  }

  getStats(): PublishStats {
    return { ...this.stats };
  }

  async disconnect(): Promise<void> {
    await this.flush();
    await this.client.disconnect?.();
  }
}
