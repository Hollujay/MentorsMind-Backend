/**
 * Multi-layer cache orchestrator tests (issue #864).
 */

import {
  CacheOrchestrator,
  type CacheEvent,
} from '../cache-orchestrator.service';
import { MemoryCacheLayer, type CacheLayer } from '../performance/cache-layer';
import { CacheDependencyGraph } from '../performance/cache-dependency-graph';

/** Scriptable layer so failure and unavailability are testable. */
class FakeLayer implements CacheLayer {
  readonly store = new Map<string, unknown>();
  available = true;
  failOn: Set<'get' | 'set' | 'del'> = new Set();
  getCalls = 0;
  setCalls = 0;

  constructor(readonly name: string) {}

  async get<T>(key: string): Promise<T | null> {
    this.getCalls += 1;
    if (this.failOn.has('get')) throw new Error(`${this.name} get failed`);
    return (this.store.get(key) as T) ?? null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.setCalls += 1;
    if (this.failOn.has('set')) throw new Error(`${this.name} set failed`);
    this.store.set(key, value);
  }

  async del(key: string): Promise<void> {
    if (this.failOn.has('del')) throw new Error(`${this.name} del failed`);
    this.store.delete(key);
  }

  isAvailable(): boolean {
    return this.available;
  }
}

describe('CacheOrchestrator', () => {
  let l1: FakeLayer;
  let l2: FakeLayer;
  let orchestrator: CacheOrchestrator;
  let events: CacheEvent[];

  beforeEach(() => {
    l1 = new FakeLayer('L1');
    l2 = new FakeLayer('L2');
    events = [];
    orchestrator = new CacheOrchestrator({
      layers: [l1, l2],
      onEvent: (e) => events.push(e),
    });
  });

  it('requires at least one layer', () => {
    expect(() => new CacheOrchestrator({ layers: [] })).toThrow();
  });

  describe('read path', () => {
    it('serves from the fastest layer without touching slower ones', async () => {
      l1.store.set('k', 'from-l1');
      l2.store.set('k', 'from-l2');

      await expect(orchestrator.get('k')).resolves.toBe('from-l1');
      expect(l2.getCalls).toBe(0);
    });

    it('falls through to a slower layer on a miss', async () => {
      l2.store.set('k', 'from-l2');
      await expect(orchestrator.get('k')).resolves.toBe('from-l2');
    });

    it('promotes a slow-layer hit into the fast layer', async () => {
      l2.store.set('k', 'v');
      await orchestrator.get('k');

      // The next read must not need L2 at all.
      expect(l1.store.get('k')).toBe('v');
      expect(events.some((e) => e.type === 'promote' && e.layer === 'L1')).toBe(true);
    });

    it('does not promote when the fastest layer already served it', async () => {
      l1.store.set('k', 'v');
      await orchestrator.get('k');
      expect(events.some((e) => e.type === 'promote')).toBe(false);
    });

    it('returns null when every layer misses', async () => {
      await expect(orchestrator.get('nope')).resolves.toBeNull();
      expect(events.some((e) => e.type === 'miss')).toBe(true);
    });

    it('skips an unavailable layer instead of failing', async () => {
      l1.available = false;
      l2.store.set('k', 'v');

      await expect(orchestrator.get('k')).resolves.toBe('v');
      expect(l1.getCalls).toBe(0);
    });

    it('degrades past a throwing layer rather than surfacing the error', async () => {
      l1.failOn.add('get');
      l2.store.set('k', 'v');

      // A Redis blip should reach the origin, not become a 500.
      await expect(orchestrator.get('k')).resolves.toBe('v');
      expect(events.some((e) => e.type === 'error' && e.layer === 'L1')).toBe(true);
    });

    it('emits the serving layer on a hit', async () => {
      l2.store.set('k', 'v');
      await orchestrator.get('k');

      const hit = events.find((e) => e.type === 'hit');
      expect(hit?.layer).toBe('L2');
    });
  });

  describe('write path', () => {
    it('writes to every layer', async () => {
      await orchestrator.set('k', 'v');
      // A write that only reached L2 would leave L1 serving the old value.
      expect(l1.store.get('k')).toBe('v');
      expect(l2.store.get('k')).toBe('v');
    });

    it('still writes the remaining layers when one fails', async () => {
      l1.failOn.add('set');
      await orchestrator.set('k', 'v');
      expect(l2.store.get('k')).toBe('v');
    });

    it('skips unavailable layers', async () => {
      l2.available = false;
      await orchestrator.set('k', 'v');
      expect(l2.setCalls).toBe(0);
    });
  });

  describe('getOrSet', () => {
    it('returns a cached value without calling the loader', async () => {
      l1.store.set('k', 'cached');
      const loader = jest.fn();

      await expect(orchestrator.getOrSet('k', loader)).resolves.toBe('cached');
      expect(loader).not.toHaveBeenCalled();
    });

    it('loads and caches on a miss', async () => {
      const loader = jest.fn().mockResolvedValue('loaded');

      await expect(orchestrator.getOrSet('k', loader)).resolves.toBe('loaded');
      expect(l1.store.get('k')).toBe('loaded');
      expect(l2.store.get('k')).toBe('loaded');
    });

    it('collapses a concurrent stampede into one load', async () => {
      // Built up front so `resolve` exists before the loader is ever invoked —
      // `getOrSet` awaits the read path first, so the loader runs a tick later.
      let resolve!: (v: string) => void;
      const deferred = new Promise<string>((r) => {
        resolve = r;
      });
      const loader = jest.fn(() => deferred);

      const all = Promise.all([
        orchestrator.getOrSet('hot', loader),
        orchestrator.getOrSet('hot', loader),
        orchestrator.getOrSet('hot', loader),
      ]);

      // Let the three reads miss and register their in-flight entry.
      await Promise.resolve();
      await Promise.resolve();
      resolve('once');

      await expect(all).resolves.toEqual(['once', 'once', 'once']);
      // Without single-flighting, an expiring hot key sends every concurrent
      // request to the origin at once.
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it('does not poison the key after a failed load', async () => {
      const failing = jest.fn().mockRejectedValue(new Error('origin down'));
      await expect(orchestrator.getOrSet('k', failing)).rejects.toThrow('origin down');

      const succeeding = jest.fn().mockResolvedValue('ok');
      await expect(orchestrator.getOrSet('k', succeeding)).resolves.toBe('ok');
    });
  });

  describe('invalidation', () => {
    it('drops a key from every layer', async () => {
      await orchestrator.set('k', 'v');
      await orchestrator.invalidate('k');

      expect(l1.store.has('k')).toBe(false);
      expect(l2.store.has('k')).toBe(false);
    });

    it('invalidates keys derived from a changed entity', async () => {
      await orchestrator.set('search:cat:5', ['a'], { dependsOn: ['mentor:42'] });
      await orchestrator.set('profile:42', { id: 42 }, { dependsOn: ['mentor:42'] });
      await orchestrator.set('unrelated:1', 'keep', { dependsOn: ['mentor:99'] });

      const dropped = await orchestrator.invalidateDependents('mentor:42');

      expect(dropped.sort()).toEqual(['profile:42', 'search:cat:5']);
      // None of these share a key prefix with `mentor:42` — pattern-based
      // invalidation would have missed them.
      expect(l1.store.has('unrelated:1')).toBe(true);
    });

    it('cascades through linked entities', async () => {
      await orchestrator.set('listing:page1', [], { dependsOn: ['category:5'] });
      orchestrator.linkDependency('mentor:42', 'category:5');

      const dropped = await orchestrator.invalidateDependents('mentor:42');
      expect(dropped).toContain('listing:page1');
    });

    it('returns an empty list for an entity nothing depends on', async () => {
      await expect(orchestrator.invalidateDependents('ghost:1')).resolves.toEqual([]);
    });
  });

  it('accepts an injected dependency graph', async () => {
    const graph = new CacheDependencyGraph();
    const o = new CacheOrchestrator({ layers: [l1], dependencyGraph: graph });

    await o.set('k', 'v', { dependsOn: ['e:1'] });
    expect(graph.directDependents('e:1')).toEqual(['k']);
  });

  it('survives a metrics sink that throws', async () => {
    const o = new CacheOrchestrator({
      layers: [l1],
      onEvent: () => {
        throw new Error('sink exploded');
      },
    });

    await expect(o.set('k', 'v')).resolves.toBeUndefined();
  });
});

describe('MemoryCacheLayer', () => {
  it('stores and returns a value', async () => {
    const layer = new MemoryCacheLayer();
    await layer.set('k', { a: 1 }, 60);
    await expect(layer.get('k')).resolves.toEqual({ a: 1 });
  });

  it('expires an entry once its TTL lapses', async () => {
    let now = 1_000;
    const layer = new MemoryCacheLayer({ now: () => now });

    await layer.set('k', 'v', 10);
    now += 9_000;
    await expect(layer.get('k')).resolves.toBe('v');

    now += 2_000;
    await expect(layer.get('k')).resolves.toBeNull();
  });

  it('evicts the oldest entry at capacity', async () => {
    const layer = new MemoryCacheLayer({ maxEntries: 2 });

    await layer.set('a', 1, 60);
    await layer.set('b', 2, 60);
    await layer.set('c', 3, 60);

    // Unbounded growth in a long-lived process is a memory leak that presents
    // as an OOM restart loop.
    expect(layer.size()).toBe(2);
    await expect(layer.get('a')).resolves.toBeNull();
    await expect(layer.get('c')).resolves.toBe(3);
  });

  it('refreshing a key moves it to the back of the eviction order', async () => {
    const layer = new MemoryCacheLayer({ maxEntries: 2 });

    await layer.set('a', 1, 60);
    await layer.set('b', 2, 60);
    await layer.set('a', 11, 60); // refresh a
    await layer.set('c', 3, 60); // should evict b, not a

    await expect(layer.get('a')).resolves.toBe(11);
    await expect(layer.get('b')).resolves.toBeNull();
  });

  it('deletes and clears', async () => {
    const layer = new MemoryCacheLayer();
    await layer.set('k', 'v', 60);

    await layer.del('k');
    await expect(layer.get('k')).resolves.toBeNull();

    await layer.set('x', 1, 60);
    layer.clear();
    expect(layer.size()).toBe(0);
  });
});
