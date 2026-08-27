/**
 * Stream processing, event sourcing and Kafka adapter tests (issue #861).
 *
 * Everything here runs against injected fakes — no broker required.
 */

import {
  StreamProcessor,
  WindowAggregator,
  windowStartFor,
  type StreamMessage,
} from '../stream-processor.service';
import {
  CommandBus,
  ConcurrencyError,
  EventSourcingService,
  InMemoryEventStore,
  type DomainEvent,
  type Projection,
} from '../event-sourcing.service';
import {
  KafkaProducerService,
  serialiseValue,
  type ProducerClient,
  type ProducerRecord,
} from '../kafka-producer.service';
import {
  KafkaConsumerService,
  toStreamMessage,
  type ConsumerClient,
  type ConsumerRecord,
} from '../kafka-consumer.service';

const msg = <T>(over: Partial<StreamMessage<T>> = {}): StreamMessage<T> =>
  ({
    topic: 'events',
    key: 'k1',
    value: 1 as unknown as T,
    timestamp: 1_000,
    ...over,
  }) as StreamMessage<T>;

// ─── Windowing ────────────────────────────────────────────────────────────────

describe('windowStartFor', () => {
  it('floors to the window grid', () => {
    expect(windowStartFor(1_250, 1_000)).toBe(1_000);
    expect(windowStartFor(2_000, 1_000)).toBe(2_000);
  });

  it('is stable across restarts for the same timestamp', () => {
    // Deriving windows from "first message seen" would give a different grid
    // every deploy, and two replicas would disagree.
    expect(windowStartFor(123_456, 60_000)).toBe(windowStartFor(123_456, 60_000));
  });
});

describe('WindowAggregator', () => {
  const counter = (over = {}) =>
    new WindowAggregator<number, number>({
      windowMs: 1_000,
      initial: () => 0,
      reduce: (acc) => acc + 1,
      ...over,
    });

  it('aggregates messages inside one window', () => {
    const closed: Array<{ result: number }> = [];
    const agg = counter({ onWindowClosed: (r: { result: number }) => closed.push(r) });

    agg.add(msg({ timestamp: 1_000 }));
    agg.add(msg({ timestamp: 1_500 }));
    agg.flush();

    expect(closed[0].result).toBe(2);
  });

  it('separates messages into distinct windows', () => {
    const closed: Array<{ windowStart: number; result: number }> = [];
    const agg = counter({ onWindowClosed: (r: never) => closed.push(r) });

    agg.add(msg({ timestamp: 1_000 }));
    agg.add(msg({ timestamp: 2_500 }));
    agg.flush();

    expect(closed).toHaveLength(2);
  });

  it('keys windows separately', () => {
    const closed: Array<{ key: string | null; result: number }> = [];
    const agg = counter({ onWindowClosed: (r: never) => closed.push(r) });

    agg.add(msg({ timestamp: 1_000, key: 'a' }));
    agg.add(msg({ timestamp: 1_100, key: 'b' }));
    agg.flush();

    expect(closed.map((c) => c.key).sort()).toEqual(['a', 'b']);
  });

  it('closes a window once the watermark passes it', () => {
    const closed: unknown[] = [];
    const agg = counter({ onWindowClosed: (r: unknown) => closed.push(r) });

    agg.add(msg({ timestamp: 1_000 }));
    expect(closed).toHaveLength(0);

    agg.add(msg({ timestamp: 3_000 }));
    expect(closed).toHaveLength(1);
  });

  it('accepts a late arrival inside the grace period', () => {
    const late: unknown[] = [];
    const agg = counter({ graceMs: 5_000, onLateMessage: (m: unknown) => late.push(m) });

    agg.add(msg({ timestamp: 1_000 }));
    agg.add(msg({ timestamp: 4_000 }));
    // Window [1000,2000) closes at watermark 7000; 1500 is still in grace.
    expect(agg.add(msg({ timestamp: 1_500 }))).toBe(true);
    expect(late).toHaveLength(0);
  });

  it('drops an arrival too late even for grace', () => {
    const late: unknown[] = [];
    const agg = counter({ graceMs: 0, onLateMessage: (m: unknown) => late.push(m) });

    agg.add(msg({ timestamp: 1_000 }));
    agg.add(msg({ timestamp: 9_000 }));

    // Re-opening an emitted window would produce a second, contradictory
    // result downstream.
    expect(agg.add(msg({ timestamp: 1_200 }))).toBe(false);
    expect(late).toHaveLength(1);
  });

  it('never moves the watermark backwards', () => {
    const agg = counter();
    agg.add(msg({ timestamp: 5_000 }));
    agg.add(msg({ timestamp: 2_000 }));
    expect(agg.currentWatermark()).toBe(5_000);
  });

  it('flushes open windows at shutdown', () => {
    const closed: unknown[] = [];
    const agg = counter({ onWindowClosed: (r: unknown) => closed.push(r) });

    agg.add(msg({ timestamp: 1_000 }));
    expect(agg.openWindowCount()).toBe(1);

    agg.flush();
    expect(agg.openWindowCount()).toBe(0);
    expect(closed).toHaveLength(1);
  });

  it('reports message counts per window', () => {
    const closed: Array<{ messageCount: number }> = [];
    const agg = counter({ onWindowClosed: (r: never) => closed.push(r) });

    agg.add(msg({ timestamp: 1_000 }));
    agg.add(msg({ timestamp: 1_100 }));
    agg.add(msg({ timestamp: 1_200 }));
    agg.flush();

    expect(closed[0].messageCount).toBe(3);
  });
});

// ─── Processing ───────────────────────────────────────────────────────────────

describe('StreamProcessor', () => {
  it('processes a clean batch', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    const result = await new StreamProcessor({ handler }).processBatch([msg(), msg()]);

    expect(result.processed).toBe(2);
    expect(result.failed).toBe(0);
  });

  it('retries a failing message up to the attempt limit', async () => {
    const handler = jest
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(undefined);

    const result = await new StreamProcessor({ handler, maxAttempts: 3 }).processBatch([
      msg(),
    ]);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(result.processed).toBe(1);
    expect(result.retried).toBe(1);
  });

  it('dead-letters a poison message instead of blocking the partition', async () => {
    const dead: unknown[] = [];
    const handler = jest.fn().mockRejectedValue(new Error('always fails'));

    const result = await new StreamProcessor({
      handler,
      maxAttempts: 2,
      onDeadLetter: (m) => {
        dead.push(m);
      },
    }).processBatch([msg()]);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(result.deadLettered).toBe(1);
    expect(dead).toHaveLength(1);
  });

  it('keeps processing after a dead-letter', async () => {
    const handler = jest
      .fn()
      .mockRejectedValueOnce(new Error('bad'))
      .mockRejectedValueOnce(new Error('bad'))
      .mockResolvedValue(undefined);

    const result = await new StreamProcessor({
      handler,
      maxAttempts: 2,
      onDeadLetter: () => undefined,
    }).processBatch([msg({ key: 'a' }), msg({ key: 'b' })]);

    // One lost message beats a stalled consumer group.
    expect(result.deadLettered).toBe(1);
    expect(result.processed).toBe(1);
  });

  it('reports errors with the attempt number', async () => {
    const attempts: number[] = [];
    await new StreamProcessor({
      handler: jest.fn().mockRejectedValue(new Error('x')),
      maxAttempts: 3,
      onError: (_m, _e, attempt) => attempts.push(attempt),
    }).processBatch([msg()]);

    expect(attempts).toEqual([1, 2, 3]);
  });

  it('preserves order within a batch', async () => {
    const seen: string[] = [];
    await new StreamProcessor<string>({
      handler: async (m) => {
        seen.push(m.value);
      },
    }).processBatch([
      msg<string>({ value: 'first' }),
      msg<string>({ value: 'second' }),
    ]);

    expect(seen).toEqual(['first', 'second']);
  });
});

// ─── Event sourcing ───────────────────────────────────────────────────────────

interface ProfileState {
  name: string;
  updates: number;
}

const profileProjection: Projection<ProfileState> = {
  name: 'profile',
  initial: () => ({ name: '', updates: 0 }),
  apply: (state, event) => {
    if (event.type === 'ProfileUpdated') {
      return {
        name: (event.payload as { name: string }).name,
        updates: state.updates + 1,
      };
    }
    return state;
  },
};

describe('EventSourcingService', () => {
  let store: InMemoryEventStore;
  let service: EventSourcingService;

  beforeEach(() => {
    store = new InMemoryEventStore();
    service = new EventSourcingService(store);
  });

  const event = (name: string, at = 1_000) => ({
    type: 'ProfileUpdated',
    payload: { name },
    occurredAt: at,
  });

  it('numbers appended events from one', async () => {
    const result = await service.append('mentor-1', [event('a'), event('b')]);
    expect(result.version).toBe(2);
    expect(result.appended).toBe(2);
  });

  it('continues numbering across appends', async () => {
    await service.append('mentor-1', [event('a')]);
    const second = await service.append('mentor-1', [event('b')]);
    expect(second.version).toBe(2);
  });

  it('is a no-op for an empty append', async () => {
    const result = await service.append('mentor-1', []);
    expect(result.appended).toBe(0);
  });

  it('rejects an append on a stale version', async () => {
    await service.append('mentor-1', [event('a')]);
    // A lost update must be loud, not silently interleaved.
    await expect(service.append('mentor-1', [event('b')], 0)).rejects.toThrow(
      ConcurrencyError,
    );
  });

  it('accepts an append on the expected version', async () => {
    await service.append('mentor-1', [event('a')]);
    await expect(service.append('mentor-1', [event('b')], 1)).resolves.toMatchObject({
      version: 2,
    });
  });

  it('appends unconditionally with version -1', async () => {
    await service.append('mentor-1', [event('a')]);
    await expect(service.append('mentor-1', [event('b')], -1)).resolves.toBeDefined();
  });

  it('rebuilds state by folding the stream', async () => {
    await service.append('mentor-1', [event('first'), event('second')]);
    const projected = await service.project('mentor-1', profileProjection);

    expect(projected.state).toEqual({ name: 'second', updates: 2 });
    expect(projected.version).toBe(2);
  });

  it('leaves state unchanged for an unknown event type', async () => {
    await service.append('mentor-1', [
      { type: 'SomethingNew', payload: {}, occurredAt: 1 },
    ]);
    const projected = await service.project('mentor-1', profileProjection);

    // Adding an event type must not break existing projections on replay.
    expect(projected.state.updates).toBe(0);
  });

  it('catches a projection up incrementally', async () => {
    await service.append('mentor-1', [event('first')]);
    const first = await service.project('mentor-1', profileProjection);

    await service.append('mentor-1', [event('second')]);
    const caughtUp = await service.projectFrom('mentor-1', profileProjection, first);

    expect(caughtUp.state.updates).toBe(2);
    expect(caughtUp.version).toBe(2);
  });

  it('returns the previous state when there is nothing new', async () => {
    await service.append('mentor-1', [event('a')]);
    const first = await service.project('mentor-1', profileProjection);

    expect(await service.projectFrom('mentor-1', profileProjection, first)).toBe(first);
  });

  it('projects state as of a point in time', async () => {
    await service.append('mentor-1', [event('early', 1_000), event('late', 5_000)]);

    const asOf = await service.projectAsOf('mentor-1', profileProjection, 2_000);
    // The audit question event sourcing exists to answer.
    expect(asOf.state.name).toBe('early');
  });

  it('folds defensively when the store returns events out of order', () => {
    const events: DomainEvent[] = [
      { streamId: 's', type: 'ProfileUpdated', version: 2, payload: { name: 'b' }, occurredAt: 2 },
      { streamId: 's', type: 'ProfileUpdated', version: 1, payload: { name: 'a' }, occurredAt: 1 },
    ];

    expect(service.foldEvents(events, profileProjection).state.name).toBe('b');
  });

  it('reports an empty stream as version zero', async () => {
    expect(await service.currentVersion('nothing')).toBe(0);
  });
});

describe('CommandBus', () => {
  it('dispatches to a registered handler', async () => {
    const bus = new CommandBus();
    bus.register('UpdateProfile', async () => ({
      streamId: 'mentor-1',
      version: 1,
      events: 1,
    }));

    await expect(bus.dispatch('UpdateProfile', {})).resolves.toMatchObject({
      version: 1,
    });
  });

  it('throws for an unregistered command', async () => {
    await expect(new CommandBus().dispatch('Unknown', {})).rejects.toThrow(/No handler/);
  });

  it('lists registered commands', () => {
    const bus = new CommandBus();
    bus.register('A', async () => ({ streamId: 's', version: 1, events: 1 }));
    expect(bus.registeredCommands()).toEqual(['A']);
  });
});

// ─── Kafka adapters ───────────────────────────────────────────────────────────

describe('serialiseValue', () => {
  it('serialises a plain object', () => {
    expect(serialiseValue({ a: 1 })).toBe('{"a":1}');
  });

  it('allows null as an empty payload', () => {
    expect(serialiseValue(null)).toBe('null');
  });

  it('rejects undefined', () => {
    // Would otherwise ship `undefined` into the topic as a poison message.
    expect(() => serialiseValue(undefined)).toThrow(/undefined/);
  });

  it('rejects a circular structure', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => serialiseValue(circular)).toThrow(/not serialisable/);
  });
});

class FakeProducerClient implements ProducerClient {
  sent: Array<{ topic: string; records: ProducerRecord[] }> = [];
  failTimes = 0;

  async send(topic: string, records: ProducerRecord[]): Promise<void> {
    if (this.failTimes > 0) {
      this.failTimes -= 1;
      throw new Error('broker unavailable');
    }
    this.sent.push({ topic, records });
  }
}

describe('KafkaProducerService', () => {
  let client: FakeProducerClient;

  beforeEach(() => {
    client = new FakeProducerClient();
  });

  it('buffers until the batch fills', async () => {
    const producer = new KafkaProducerService({ client, batchSize: 3 });

    await producer.publish(msg());
    await producer.publish(msg());
    expect(client.sent).toHaveLength(0);
    expect(producer.pendingCount()).toBe(2);

    await producer.publish(msg());
    expect(client.sent).toHaveLength(1);
  });

  it('flushes remaining messages on demand', async () => {
    const producer = new KafkaProducerService({ client, batchSize: 100 });
    await producer.publish(msg());
    await producer.flush();

    expect(client.sent).toHaveLength(1);
    expect(producer.pendingCount()).toBe(0);
  });

  it('preserves the partition key', async () => {
    const producer = new KafkaProducerService({ client, batchSize: 1 });
    await producer.publish(msg({ key: 'mentor-42' }));

    // A null key would scatter an entity's events across partitions.
    expect(client.sent[0].records[0].key).toBe('mentor-42');
  });

  it('retries a failed send', async () => {
    client.failTimes = 1;
    const producer = new KafkaProducerService({ client, batchSize: 1, maxRetries: 3 });

    await producer.publish(msg());
    expect(client.sent).toHaveLength(1);
    expect(producer.getStats().retries).toBe(1);
  });

  it('throws after exhausting retries', async () => {
    client.failTimes = 99;
    const producer = new KafkaProducerService({ client, batchSize: 100, maxRetries: 2 });

    await producer.publish(msg());
    await expect(producer.flush()).rejects.toThrow(/broker unavailable/);
    expect(producer.getStats().failed).toBe(1);
  });

  it('flushes on disconnect so nothing is lost', async () => {
    const producer = new KafkaProducerService({ client, batchSize: 100 });
    await producer.publish(msg());
    await producer.disconnect();

    expect(client.sent).toHaveLength(1);
  });
});

describe('toStreamMessage', () => {
  const record = (over: Partial<ConsumerRecord> = {}): ConsumerRecord => ({
    topic: 't',
    partition: 0,
    offset: '10',
    key: 'k',
    value: '{"a":1}',
    timestamp: '1000',
    ...over,
  });

  it('parses a JSON record', () => {
    const message = toStreamMessage(record());
    expect(message?.value).toEqual({ a: 1 });
    expect(message?.offset).toBe(10);
  });

  it('returns null for a tombstone', () => {
    expect(toStreamMessage(record({ value: null }))).toBeNull();
  });

  it('returns null for an unparseable payload', () => {
    // Throwing would stall the partition on one bad record.
    expect(toStreamMessage(record({ value: 'not json' }))).toBeNull();
  });

  it('falls back to arrival time for a bad broker timestamp', () => {
    const message = toStreamMessage(record({ timestamp: 'nonsense' }));
    // A bad header must not push the message into 1970 and break windowing.
    expect(message!.timestamp).toBeGreaterThan(0);
  });
});

class FakeConsumerClient implements ConsumerClient {
  commits: Array<{ topic: string; partition: number; offset: string }> = [];
  subscribed: string[] = [];

  async subscribe(topics: string[]): Promise<void> {
    this.subscribed = topics;
  }

  async run(): Promise<void> {
    /* driven directly via handleBatch in tests */
  }

  async commit(topic: string, partition: number, offset: string): Promise<void> {
    this.commits.push({ topic, partition, offset });
  }
}

describe('KafkaConsumerService', () => {
  const record = (over: Partial<ConsumerRecord> = {}): ConsumerRecord => ({
    topic: 't',
    partition: 0,
    offset: '1',
    key: 'k',
    value: '{"n":1}',
    timestamp: '1000',
    ...over,
  });

  it('processes a batch and commits once', async () => {
    const client = new FakeConsumerClient();
    const handler = jest.fn().mockResolvedValue(undefined);
    const consumer = new KafkaConsumerService({
      client,
      topics: ['t'],
      handler,
      commitPolicy: 'after-batch',
    });

    await consumer.handleBatch([record({ offset: '1' }), record({ offset: '2' })]);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(client.commits).toHaveLength(1);
    expect(client.commits[0].offset).toBe('2');
  });

  it('commits per message when configured', async () => {
    const client = new FakeConsumerClient();
    const consumer = new KafkaConsumerService({
      client,
      topics: ['t'],
      handler: jest.fn().mockResolvedValue(undefined),
      commitPolicy: 'per-message',
    });

    await consumer.handleBatch([record({ offset: '1' }), record({ offset: '2' })]);
    expect(client.commits).toHaveLength(2);
  });

  it('does not commit under a manual policy', async () => {
    const client = new FakeConsumerClient();
    const consumer = new KafkaConsumerService({
      client,
      topics: ['t'],
      handler: jest.fn().mockResolvedValue(undefined),
      commitPolicy: 'manual',
    });

    await consumer.handleBatch([record()]);
    expect(client.commits).toHaveLength(0);
  });

  it('skips an unparseable record without retrying it', async () => {
    const client = new FakeConsumerClient();
    const handler = jest.fn().mockResolvedValue(undefined);
    const consumer = new KafkaConsumerService({ client, topics: ['t'], handler });

    await consumer.handleBatch([record({ value: 'garbage' }), record()]);

    // A corrupt payload is just as corrupt on the third attempt.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(consumer.getStats().skipped).toBe(1);
  });

  it('advances past a dead-lettered message under per-message commits', async () => {
    const client = new FakeConsumerClient();
    const consumer = new KafkaConsumerService({
      client,
      topics: ['t'],
      handler: jest.fn().mockRejectedValue(new Error('poison')),
      commitPolicy: 'per-message',
      maxAttempts: 1,
      onDeadLetter: () => undefined,
    });

    await consumer.handleBatch([record()]);

    // Replaying it would dead-letter it forever and never advance the offset.
    expect(consumer.getStats().deadLettered).toBe(1);
    expect(client.commits).toHaveLength(1);
  });

  it('subscribes to its topics on start', async () => {
    const client = new FakeConsumerClient();
    const consumer = new KafkaConsumerService({
      client,
      topics: ['a', 'b'],
      handler: jest.fn(),
    });

    await consumer.start();
    expect(client.subscribed).toEqual(['a', 'b']);
  });
});
