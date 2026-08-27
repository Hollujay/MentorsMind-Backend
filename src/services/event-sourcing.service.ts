/**
 * Event sourcing and CQRS projections (issue #861).
 *
 * `event-store.service.ts` already persists events. This adds the layer above
 * it: rebuilding state by folding an event stream, and keeping read-side
 * projections in step with the write side.
 *
 * The store is injected through a narrow interface, so the folding,
 * versioning and optimistic-concurrency logic is unit-testable against an
 * in-memory store — and that logic is where event sourcing actually goes
 * wrong (a lost update, a projection silently drifting from its stream).
 */

export interface DomainEvent<T = unknown> {
  /** Stream this belongs to, e.g. `mentor-42`. */
  streamId: string;
  /** Discriminator, e.g. `MentorProfileUpdated`. */
  type: string;
  /** Position within the stream, starting at 1. */
  version: number;
  payload: T;
  /** Epoch ms the event occurred. */
  occurredAt: number;
  metadata?: Record<string, unknown>;
}

export interface AppendResult {
  streamId: string;
  /** Version after appending. */
  version: number;
  appended: number;
}

/** Narrow persistence contract — deliberately smaller than the full store. */
export interface EventStoreAdapter {
  read(streamId: string, fromVersion?: number): Promise<DomainEvent[]>;
  append(streamId: string, events: DomainEvent[]): Promise<void>;
  lastVersion(streamId: string): Promise<number>;
}

/** Thrown when an append races another writer. */
export class ConcurrencyError extends Error {
  constructor(
    readonly streamId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `Concurrency conflict on "${streamId}": expected version ${expectedVersion}, found ${actualVersion}`,
    );
    this.name = 'ConcurrencyError';
  }
}

/** In-memory adapter for tests and local development. */
export class InMemoryEventStore implements EventStoreAdapter {
  private readonly streams = new Map<string, DomainEvent[]>();

  async read(streamId: string, fromVersion = 0): Promise<DomainEvent[]> {
    return (this.streams.get(streamId) ?? []).filter((e) => e.version > fromVersion);
  }

  async append(streamId: string, events: DomainEvent[]): Promise<void> {
    const existing = this.streams.get(streamId) ?? [];
    this.streams.set(streamId, [...existing, ...events]);
  }

  async lastVersion(streamId: string): Promise<number> {
    const events = this.streams.get(streamId) ?? [];
    return events.length === 0 ? 0 : events[events.length - 1].version;
  }

  clear(): void {
    this.streams.clear();
  }
}

/** Folds a stream into read-model state. */
export interface Projection<S> {
  name: string;
  initial: () => S;
  /**
   * Apply one event. Must be pure and total: an unknown type returns the
   * state unchanged rather than throwing, so adding a new event type does not
   * break every existing projection on replay.
   */
  apply: (state: S, event: DomainEvent) => S;
}

export interface ProjectionState<S> {
  state: S;
  /** Stream version this state reflects. */
  version: number;
}

export class EventSourcingService {
  constructor(private readonly store: EventStoreAdapter) {}

  /**
   * Append events with optimistic concurrency.
   *
   * `expectedVersion` is the version the caller believed it was writing on top
   * of. If the stream has moved on, the append is rejected rather than
   * silently interleaved — the whole point of a version check is that a lost
   * update is loud instead of invisible.
   *
   * Pass `-1` to append unconditionally.
   */
  async append<T>(
    streamId: string,
    events: Array<Omit<DomainEvent<T>, 'streamId' | 'version'>>,
    expectedVersion = -1,
  ): Promise<AppendResult> {
    if (events.length === 0) {
      return { streamId, version: await this.store.lastVersion(streamId), appended: 0 };
    }

    const current = await this.store.lastVersion(streamId);
    if (expectedVersion !== -1 && current !== expectedVersion) {
      throw new ConcurrencyError(streamId, expectedVersion, current);
    }

    const numbered: DomainEvent[] = events.map((e, i) => ({
      ...e,
      streamId,
      version: current + i + 1,
    }));

    await this.store.append(streamId, numbered);

    return {
      streamId,
      version: current + numbered.length,
      appended: numbered.length,
    };
  }

  /** Rebuild state by folding the whole stream. */
  async project<S>(
    streamId: string,
    projection: Projection<S>,
  ): Promise<ProjectionState<S>> {
    const events = await this.store.read(streamId);
    return this.foldEvents(events, projection);
  }

  /**
   * Advance an existing projection with only the events after `fromVersion`.
   *
   * Full replay is correct but gets linearly slower forever; incremental
   * catch-up is what keeps a long-lived stream usable.
   */
  async projectFrom<S>(
    streamId: string,
    projection: Projection<S>,
    previous: ProjectionState<S>,
  ): Promise<ProjectionState<S>> {
    const events = await this.store.read(streamId, previous.version);
    if (events.length === 0) return previous;

    let state = previous.state;
    let version = previous.version;
    for (const event of events) {
      state = projection.apply(state, event);
      version = event.version;
    }
    return { state, version };
  }

  /** Fold an in-memory event list — used by both project paths. */
  foldEvents<S>(events: DomainEvent[], projection: Projection<S>): ProjectionState<S> {
    let state = projection.initial();
    let version = 0;

    // Sort defensively: a store that returns out of order would otherwise
    // produce a state that depends on retrieval order rather than on the
    // events themselves.
    const ordered = [...events].sort((a, b) => a.version - b.version);
    for (const event of ordered) {
      state = projection.apply(state, event);
      version = event.version;
    }

    return { state, version };
  }

  /**
   * State as of a point in time — the audit question event sourcing exists to
   * answer ("what did this look like when the dispute was raised?").
   */
  async projectAsOf<S>(
    streamId: string,
    projection: Projection<S>,
    asOf: number,
  ): Promise<ProjectionState<S>> {
    const events = await this.store.read(streamId);
    return this.foldEvents(
      events.filter((e) => e.occurredAt <= asOf),
      projection,
    );
  }

  async currentVersion(streamId: string): Promise<number> {
    return this.store.lastVersion(streamId);
  }
}

/**
 * CQRS command/query separation.
 *
 * Commands go to the write side and return the resulting version; queries read
 * a projection. Keeping them apart in the type system is what stops a "query"
 * quietly acquiring a write six months later.
 */
export interface CommandResult {
  streamId: string;
  version: number;
  events: number;
}

export class CommandBus {
  private readonly handlers = new Map<
    string,
    (payload: unknown) => Promise<CommandResult>
  >();

  register<P>(
    commandType: string,
    handler: (payload: P) => Promise<CommandResult>,
  ): void {
    this.handlers.set(commandType, handler as (p: unknown) => Promise<CommandResult>);
  }

  async dispatch<P>(commandType: string, payload: P): Promise<CommandResult> {
    const handler = this.handlers.get(commandType);
    if (!handler) {
      throw new Error(`No handler registered for command "${commandType}"`);
    }
    return handler(payload);
  }

  registeredCommands(): string[] {
    return [...this.handlers.keys()];
  }
}
