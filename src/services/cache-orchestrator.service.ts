/**
 * Multi-layer cache orchestrator (issue #864).
 *
 * Reads walk the hierarchy fastest-first (L1 in-process → L2 Redis → L3 CDN or
 * origin) and *promote* on the way back: a value found in L2 is written into
 * L1 so the next request for it never leaves the process.
 *
 * Writes fan out to every layer, because a write that only reached L2 leaves
 * L1 serving the old value until its TTL lapses — the classic "I deployed the
 * fix but one pod still shows the old data" bug.
 *
 * Layers are injected via the `CacheLayer` interface, so the whole promotion,
 * stampede-protection and invalidation story is unit-testable without Redis.
 */

import { CacheLayer } from './performance/cache-layer';
import {
  CacheDependencyGraph,
  DependencyNode,
} from './performance/cache-dependency-graph';

export interface OrchestratorOptions {
  /** Ordered fastest-first. The orchestrator never reorders them. */
  layers: CacheLayer[];
  /** Default TTL when a caller does not specify one. */
  defaultTtlSeconds?: number;
  /**
   * TTL applied when promoting a value into a faster layer.
   *
   * Shorter than the source TTL on purpose: L1 is per-process and cannot be
   * invalidated across a fleet, so a long-lived L1 entry is the tier most
   * likely to serve something stale.
   */
  promotionTtlSeconds?: number;
  dependencyGraph?: CacheDependencyGraph;
  onEvent?: (event: CacheEvent) => void;
}

export type CacheEventType =
  | 'hit'
  | 'miss'
  | 'set'
  | 'invalidate'
  | 'promote'
  | 'error';

export interface CacheEvent {
  type: CacheEventType;
  key: string;
  /** Layer that served or handled it, when applicable. */
  layer?: string;
  /** Wall-clock duration of the lookup, in ms. */
  durationMs?: number;
}

export interface GetOrSetOptions {
  ttlSeconds?: number;
  /** Entities this value derives from, for dependency-tracked invalidation. */
  dependsOn?: DependencyNode[];
}

export class CacheOrchestrator {
  private readonly layers: CacheLayer[];
  private readonly defaultTtl: number;
  private readonly promotionTtl: number;
  private readonly graph: CacheDependencyGraph;
  private readonly onEvent?: (event: CacheEvent) => void;

  /**
   * In-flight loads, keyed by cache key.
   *
   * Without this, a popular key expiring under load sends every concurrent
   * request to the origin at once — a cache stampede that can be worse than
   * having no cache, because it arrives as a thundering herd rather than
   * steady traffic. Callers share one promise instead.
   */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor({
    layers,
    defaultTtlSeconds = 300,
    promotionTtlSeconds = 60,
    dependencyGraph,
    onEvent,
  }: OrchestratorOptions) {
    if (layers.length === 0) {
      throw new Error('CacheOrchestrator requires at least one layer');
    }
    this.layers = layers;
    this.defaultTtl = defaultTtlSeconds;
    this.promotionTtl = promotionTtlSeconds;
    this.graph = dependencyGraph ?? new CacheDependencyGraph();
    this.onEvent = onEvent;
  }

  private emit(event: CacheEvent): void {
    // A misbehaving metrics sink must never break a cache read.
    try {
      this.onEvent?.(event);
    } catch {
      /* swallow */
    }
  }

  /**
   * Read through the hierarchy, promoting on the way back up.
   *
   * A layer that throws is skipped rather than failing the read — a Redis
   * blip should degrade to the origin, not surface as a 500.
   */
  async get<T>(key: string): Promise<T | null> {
    const startedAt = Date.now();

    for (let i = 0; i < this.layers.length; i += 1) {
      const layer = this.layers[i];
      if (!layer.isAvailable()) continue;

      let value: T | null = null;
      try {
        value = await layer.get<T>(key);
      } catch {
        this.emit({ type: 'error', key, layer: layer.name });
        continue;
      }

      if (value === null || value === undefined) continue;

      this.emit({
        type: 'hit',
        key,
        layer: layer.name,
        durationMs: Date.now() - startedAt,
      });

      // Promote into every faster layer that missed.
      if (i > 0) await this.promote(key, value, i);

      return value;
    }

    this.emit({ type: 'miss', key, durationMs: Date.now() - startedAt });
    return null;
  }

  private async promote<T>(key: string, value: T, foundAt: number): Promise<void> {
    for (let i = 0; i < foundAt; i += 1) {
      const layer = this.layers[i];
      if (!layer.isAvailable()) continue;
      try {
        await layer.set(key, value, this.promotionTtl);
        this.emit({ type: 'promote', key, layer: layer.name });
      } catch {
        this.emit({ type: 'error', key, layer: layer.name });
      }
    }
  }

  /** Write to every available layer. */
  async set<T>(
    key: string,
    value: T,
    { ttlSeconds, dependsOn }: GetOrSetOptions = {},
  ): Promise<void> {
    const ttl = ttlSeconds ?? this.defaultTtl;

    for (const layer of this.layers) {
      if (!layer.isAvailable()) continue;
      try {
        await layer.set(key, value, ttl);
      } catch {
        this.emit({ type: 'error', key, layer: layer.name });
      }
    }

    if (dependsOn && dependsOn.length > 0) {
      this.graph.register({ key, dependsOn });
    }

    this.emit({ type: 'set', key });
  }

  /**
   * Cache-aside read with stampede protection.
   *
   * Concurrent callers that miss share a single `loader` invocation. The
   * in-flight entry is cleared in `finally` so a failed load does not poison
   * subsequent attempts.
   */
  async getOrSet<T>(
    key: string,
    loader: () => Promise<T>,
    options: GetOrSetOptions = {},
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const load = (async () => {
      const value = await loader();
      await this.set(key, value, options);
      return value;
    })().finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, load);
    return load;
  }

  /** Drop a single key from every layer. */
  async invalidate(key: string): Promise<void> {
    for (const layer of this.layers) {
      if (!layer.isAvailable()) continue;
      try {
        await layer.del(key);
      } catch {
        this.emit({ type: 'error', key, layer: layer.name });
      }
    }

    this.graph.deregister(key);
    this.emit({ type: 'invalidate', key });
  }

  /**
   * Invalidate everything derived from `node`.
   *
   * This is the point of the dependency graph: changing `mentor:42`
   * invalidates the search pages and listings built from it, none of which
   * share its key prefix.
   *
   * @returns the keys that were dropped
   */
  async invalidateDependents(node: DependencyNode): Promise<string[]> {
    const keys = this.graph.resolveInvalidations(node);
    await Promise.all(keys.map((key) => this.invalidate(key)));
    return keys;
  }

  /** Declare that `derived` is computed from `source`. */
  linkDependency(source: DependencyNode, derived: DependencyNode): void {
    this.graph.link(source, derived);
  }

  dependencyStats() {
    return this.graph.stats();
  }
}
