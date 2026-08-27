/**
 * Cache warming and preloading (issue #864).
 *
 * A cold cache after a deploy or a Redis restart is when the origin is least
 * able to cope: every request misses at once, against a database that was
 * sized for a warm cache. Warming pays that cost deliberately, in a controlled
 * order, before traffic arrives.
 *
 * Warmers are registered rather than hardcoded so each domain owns its own,
 * and the runner is transport-agnostic — it takes a `warm` function and knows
 * nothing about Redis.
 */

export interface CacheWarmer {
  /** Unique id, used for reporting and de-duplication. */
  name: string;
  /**
   * Higher runs first. Warm the things a cold page load needs before the
   * long-tail ones, so the system is useful early rather than complete late.
   */
  priority: number;
  /** Populates the cache. Should be idempotent — it may be retried. */
  warm: () => Promise<void>;
  /**
   * Skip when this returns false — e.g. a warmer for a feature that is
   * disabled, or one whose data has not changed since the last run.
   */
  shouldRun?: () => boolean | Promise<boolean>;
}

export interface WarmingResult {
  name: string;
  status: 'ok' | 'failed' | 'skipped' | 'timed-out';
  durationMs: number;
  error?: string;
}

export interface WarmingReport {
  results: WarmingResult[];
  totalDurationMs: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

export interface WarmingRunOptions {
  /** Warmers running at once. Too many and warming becomes the load spike. */
  concurrency?: number;
  /** Per-warmer timeout. A hung warmer must not block startup forever. */
  timeoutMs?: number;
  onResult?: (result: WarmingResult) => void;
}

/** Reject after `ms`, so one stuck warmer cannot hold the run open. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('warmer timed out')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class CacheWarmingService {
  private readonly warmers = new Map<string, CacheWarmer>();

  /** Register a warmer. Re-registering the same name replaces it. */
  register(warmer: CacheWarmer): void {
    this.warmers.set(warmer.name, warmer);
  }

  unregister(name: string): void {
    this.warmers.delete(name);
  }

  /** Registered warmers, highest priority first. */
  list(): CacheWarmer[] {
    return [...this.warmers.values()].sort((a, b) => b.priority - a.priority);
  }

  /**
   * Run every registered warmer.
   *
   * A failing warmer is recorded and the run continues: warming is best-effort
   * by nature, and aborting startup because one cache segment could not be
   * preloaded would turn a performance optimisation into an outage.
   */
  async warmAll({
    concurrency = 4,
    timeoutMs = 30_000,
    onResult,
  }: WarmingRunOptions = {}): Promise<WarmingReport> {
    const startedAt = Date.now();
    const queue = this.list();
    const results: WarmingResult[] = [];

    const runOne = async (warmer: CacheWarmer): Promise<void> => {
      const began = Date.now();

      try {
        if (warmer.shouldRun) {
          const should = await warmer.shouldRun();
          if (!should) {
            const result: WarmingResult = {
              name: warmer.name,
              status: 'skipped',
              durationMs: Date.now() - began,
            };
            results.push(result);
            onResult?.(result);
            return;
          }
        }

        await withTimeout(warmer.warm(), timeoutMs);

        const result: WarmingResult = {
          name: warmer.name,
          status: 'ok',
          durationMs: Date.now() - began,
        };
        results.push(result);
        onResult?.(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const result: WarmingResult = {
          name: warmer.name,
          status: message === 'warmer timed out' ? 'timed-out' : 'failed',
          durationMs: Date.now() - began,
          error: message,
        };
        results.push(result);
        onResult?.(result);
      }
    };

    // Fixed-size worker pool: warmers are pulled off the priority-ordered
    // queue, so high-priority work starts first even though completion order
    // is not guaranteed.
    const workers = Array.from(
      { length: Math.max(1, Math.min(concurrency, queue.length || 1)) },
      async () => {
        for (;;) {
          const warmer = queue.shift();
          if (!warmer) return;
          await runOne(warmer);
        }
      },
    );

    await Promise.all(workers);

    return {
      results,
      totalDurationMs: Date.now() - startedAt,
      succeeded: results.filter((r) => r.status === 'ok').length,
      failed: results.filter((r) => r.status === 'failed' || r.status === 'timed-out')
        .length,
      skipped: results.filter((r) => r.status === 'skipped').length,
    };
  }

  /** Run a single warmer by name — useful for targeted refresh after a deploy. */
  async warmOne(name: string, options: WarmingRunOptions = {}): Promise<WarmingResult> {
    const warmer = this.warmers.get(name);
    if (!warmer) {
      return {
        name,
        status: 'failed',
        durationMs: 0,
        error: `no warmer registered as "${name}"`,
      };
    }

    const single = new CacheWarmingService();
    single.register(warmer);
    const report = await single.warmAll(options);
    return report.results[0];
  }
}
