/**
 * Kafka consumer adapter (issue #861).
 *
 * ─── Verification status ────────────────────────────────────────────────────
 * Deserialisation, offset-commit policy and the batch handoff are
 * unit-tested against an injected fake. The Kafka transport is not — see the
 * note in `kafka-producer.service.ts`. This talks to a `ConsumerClient`
 * interface so the commit semantics, which are the easy thing to get wrong,
 * are testable without a broker.
 */

import type { StreamMessage } from './stream-processor.service';
import { StreamProcessor } from './stream-processor.service';

export interface ConsumerRecord {
  topic: string;
  partition: number;
  offset: string;
  key: string | null;
  value: string | null;
  timestamp: string;
  headers?: Record<string, string>;
}

export interface ConsumerClient {
  subscribe(topics: string[]): Promise<void>;
  /** Invokes `onBatch` for each fetched batch until stopped. */
  run(onBatch: (records: ConsumerRecord[]) => Promise<void>): Promise<void>;
  commit(topic: string, partition: number, offset: string): Promise<void>;
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
}

export type CommitPolicy =
  /** Commit after the whole batch succeeds. Fewer commits, more replay. */
  | 'after-batch'
  /** Commit after each message. Slower, but replays at most one message. */
  | 'per-message'
  /** Caller commits. For exactly-once flows tied to a transaction. */
  | 'manual';

export interface ConsumerOptions<T> {
  client: ConsumerClient;
  topics: string[];
  handler: (message: StreamMessage<T>) => Promise<void>;
  commitPolicy?: CommitPolicy;
  maxAttempts?: number;
  onDeadLetter?: (record: ConsumerRecord, error: Error) => Promise<void> | void;
  onError?: (error: Error) => void;
}

export interface ConsumerStats {
  consumed: number;
  committed: number;
  skipped: number;
  deadLettered: number;
}

/**
 * Convert a transport record into a `StreamMessage`.
 *
 * Returns `null` for a payload that will not parse. A tombstone (null value)
 * and a corrupt payload are both non-events for a JSON consumer, and throwing
 * here would stall the partition on a single bad record.
 */
export function toStreamMessage<T>(record: ConsumerRecord): StreamMessage<T> | null {
  if (record.value === null) return null;

  let parsed: T;
  try {
    parsed = JSON.parse(record.value) as T;
  } catch {
    return null;
  }

  const timestamp = Number(record.timestamp);

  return {
    topic: record.topic,
    key: record.key,
    value: parsed,
    // Fall back to arrival time when the broker timestamp is unusable, so a
    // bad header cannot push the message into 1970 and break windowing.
    timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now(),
    offset: Number(record.offset),
    headers: record.headers,
  };
}

export class KafkaConsumerService<T> {
  private readonly client: ConsumerClient;
  private readonly topics: string[];
  private readonly commitPolicy: CommitPolicy;
  private readonly processor: StreamProcessor<T>;
  private readonly onDeadLetter?: (r: ConsumerRecord, e: Error) => Promise<void> | void;
  private readonly onError?: (error: Error) => void;
  private stats: ConsumerStats = {
    consumed: 0,
    committed: 0,
    skipped: 0,
    deadLettered: 0,
  };
  private running = false;

  constructor({
    client,
    topics,
    handler,
    commitPolicy = 'after-batch',
    maxAttempts = 3,
    onDeadLetter,
    onError,
  }: ConsumerOptions<T>) {
    this.client = client;
    this.topics = topics;
    this.commitPolicy = commitPolicy;
    this.onDeadLetter = onDeadLetter;
    this.onError = onError;
    this.processor = new StreamProcessor<T>({ handler, maxAttempts });
  }

  async start(): Promise<void> {
    await this.client.connect?.();
    await this.client.subscribe(this.topics);
    this.running = true;
    await this.client.run((records) => this.handleBatch(records));
  }

  /**
   * Process one fetched batch.
   *
   * Unparseable records are counted and skipped rather than retried — a
   * corrupt payload will be just as corrupt on the third attempt, and
   * retrying it only delays every message behind it.
   */
  async handleBatch(records: ConsumerRecord[]): Promise<void> {
    const messages: StreamMessage<T>[] = [];
    const byMessage = new Map<StreamMessage<T>, ConsumerRecord>();

    for (const record of records) {
      const message = toStreamMessage<T>(record);
      if (!message) {
        this.stats.skipped += 1;
        continue;
      }
      messages.push(message);
      byMessage.set(message, record);
    }

    if (this.commitPolicy === 'per-message') {
      for (const message of messages) {
        await this.processOne(message, byMessage.get(message)!);
      }
      return;
    }

    const result = await this.processor.processBatch(messages);
    this.stats.consumed += result.processed;

    if (result.failed > 0 && this.onDeadLetter) {
      // The processor already exhausted retries; route the batch tail aside.
      for (const message of messages.slice(result.processed)) {
        const record = byMessage.get(message);
        if (record) {
          await this.onDeadLetter(record, new Error('processing failed after retries'));
          this.stats.deadLettered += 1;
        }
      }
    }

    if (this.commitPolicy === 'after-batch' && records.length > 0) {
      const last = records[records.length - 1];
      await this.commit(last);
    }
  }

  private async processOne(
    message: StreamMessage<T>,
    record: ConsumerRecord,
  ): Promise<void> {
    const result = await this.processor.processBatch([message]);
    this.stats.consumed += result.processed;

    if (result.failed > 0) {
      if (this.onDeadLetter) {
        await this.onDeadLetter(record, new Error('processing failed after retries'));
        this.stats.deadLettered += 1;
      }
      // Commit anyway: the message is dead-lettered, so replaying it would
      // dead-letter it again forever and never advance the offset.
    }

    await this.commit(record);
  }

  private async commit(record: ConsumerRecord): Promise<void> {
    try {
      await this.client.commit(record.topic, record.partition, record.offset);
      this.stats.committed += 1;
    } catch (error) {
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  getStats(): ConsumerStats {
    return { ...this.stats };
  }

  isRunning(): boolean {
    return this.running;
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.client.disconnect?.();
  }
}
