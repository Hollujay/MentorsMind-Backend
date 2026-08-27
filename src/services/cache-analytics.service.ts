/**
 * Cache analytics and optimisation recommendations (issue #864).
 *
 * A single global hit-rate hides everything useful. 85% overall can be one
 * namespace at 99% masking another at 20% — and the 20% is the one costing
 * money. Stats are therefore kept per namespace, and the recommendations point
 * at specific namespaces with a reason attached.
 *
 * Pure in-memory accounting with no external dependencies, so it is testable
 * directly and cheap enough to run on every cache event.
 */

import type { CacheEvent } from './cache-orchestrator.service';

export interface NamespaceStats {
  namespace: string;
  hits: number;
  misses: number;
  sets: number;
  invalidations: number;
  errors: number;
  /** hits / (hits + misses), 0–1. `null` until there is at least one read. */
  hitRate: number | null;
  /** Mean lookup duration in ms across recorded reads. */
  avgLookupMs: number | null;
  /** Hits served by each layer, keyed by layer name. */
  hitsByLayer: Record<string, number>;
}

export type RecommendationKind =
  | 'increase-ttl'
  | 'add-warming'
  | 'reconsider-caching'
  | 'investigate-errors'
  | 'promote-to-l1';

export interface Recommendation {
  namespace: string;
  kind: RecommendationKind;
  /** Why this is being suggested, in terms an on-call engineer can act on. */
  reason: string;
  /** Rough ordering hint: higher is more worth doing. */
  impact: number;
}

interface MutableStats {
  hits: number;
  misses: number;
  sets: number;
  invalidations: number;
  errors: number;
  totalLookupMs: number;
  lookupSamples: number;
  hitsByLayer: Map<string, number>;
}

/**
 * Namespace = the segment before the first colon.
 *
 * Matches the `namespace:part:part` convention `CacheKeyBuilder` already uses
 * elsewhere in the codebase, so analytics group the same way keys are built.
 */
export function namespaceOf(key: string): string {
  const idx = key.indexOf(':');
  return idx === -1 ? key : key.slice(0, idx);
}

/** Minimum reads before a namespace is judged — small samples are noise. */
const MIN_SAMPLE = 20;

export class CacheAnalyticsService {
  private readonly stats = new Map<string, MutableStats>();

  private bucket(namespace: string): MutableStats {
    let entry = this.stats.get(namespace);
    if (!entry) {
      entry = {
        hits: 0,
        misses: 0,
        sets: 0,
        invalidations: 0,
        errors: 0,
        totalLookupMs: 0,
        lookupSamples: 0,
        hitsByLayer: new Map(),
      };
      this.stats.set(namespace, entry);
    }
    return entry;
  }

  /** Feed straight from `CacheOrchestrator`'s `onEvent` hook. */
  record(event: CacheEvent): void {
    const bucket = this.bucket(namespaceOf(event.key));

    switch (event.type) {
      case 'hit':
        bucket.hits += 1;
        if (event.layer) {
          bucket.hitsByLayer.set(
            event.layer,
            (bucket.hitsByLayer.get(event.layer) ?? 0) + 1,
          );
        }
        break;
      case 'miss':
        bucket.misses += 1;
        break;
      case 'set':
        bucket.sets += 1;
        break;
      case 'invalidate':
        bucket.invalidations += 1;
        break;
      case 'error':
        bucket.errors += 1;
        break;
      case 'promote':
        // Promotions are an internal mechanic, not a read outcome — counting
        // them as hits would inflate the rate the recommendations key off.
        break;
    }

    if (
      typeof event.durationMs === 'number' &&
      (event.type === 'hit' || event.type === 'miss')
    ) {
      bucket.totalLookupMs += event.durationMs;
      bucket.lookupSamples += 1;
    }
  }

  statsFor(namespace: string): NamespaceStats | null {
    const bucket = this.stats.get(namespace);
    if (!bucket) return null;
    return this.project(namespace, bucket);
  }

  allStats(): NamespaceStats[] {
    return [...this.stats.entries()]
      .map(([namespace, bucket]) => this.project(namespace, bucket))
      .sort((a, b) => b.hits + b.misses - (a.hits + a.misses));
  }

  private project(namespace: string, bucket: MutableStats): NamespaceStats {
    const reads = bucket.hits + bucket.misses;
    return {
      namespace,
      hits: bucket.hits,
      misses: bucket.misses,
      sets: bucket.sets,
      invalidations: bucket.invalidations,
      errors: bucket.errors,
      hitRate: reads > 0 ? bucket.hits / reads : null,
      avgLookupMs:
        bucket.lookupSamples > 0 ? bucket.totalLookupMs / bucket.lookupSamples : null,
      hitsByLayer: Object.fromEntries(bucket.hitsByLayer),
    };
  }

  /**
   * Derive actionable recommendations.
   *
   * Thresholds are deliberately conservative — a recommendation engine that
   * fires constantly gets ignored, which is worse than one that says nothing.
   * Namespaces below `MIN_SAMPLE` reads are skipped entirely.
   */
  recommendations(): Recommendation[] {
    const out: Recommendation[] = [];

    for (const stat of this.allStats()) {
      const reads = stat.hits + stat.misses;
      if (reads < MIN_SAMPLE || stat.hitRate === null) continue;

      if (stat.errors > 0 && stat.errors / reads > 0.05) {
        out.push({
          namespace: stat.namespace,
          kind: 'investigate-errors',
          reason: `${stat.errors} cache errors across ${reads} reads (${(
            (stat.errors / reads) * 100
          ).toFixed(1)}%) — a layer is probably unhealthy.`,
          impact: 90,
        });
      }

      // Churn: written about as often as read, so entries rarely survive to be
      // reused. Caching is costing writes without buying reads.
      if (stat.hitRate < 0.2 && stat.sets > stat.hits) {
        out.push({
          namespace: stat.namespace,
          kind: 'reconsider-caching',
          reason: `Hit rate ${(stat.hitRate * 100).toFixed(1)}% with more writes (${
            stat.sets
          }) than hits (${stat.hits}) — this namespace may not be worth caching.`,
          impact: 70,
        });
      } else if (stat.hitRate < 0.5) {
        // Misses dominate but the data is reused — usually a TTL that expires
        // before the next read arrives.
        out.push({
          namespace: stat.namespace,
          kind: 'increase-ttl',
          reason: `Hit rate ${(stat.hitRate * 100).toFixed(
            1,
          )}% over ${reads} reads — entries are likely expiring before reuse.`,
          impact: 60,
        });
      }

      // High traffic and a healthy rate, but the first read still misses:
      // worth preloading so the cold path is never on the request path.
      if (stat.hitRate >= 0.5 && stat.misses > MIN_SAMPLE && reads > 100) {
        out.push({
          namespace: stat.namespace,
          kind: 'add-warming',
          reason: `${stat.misses} misses on a high-traffic namespace (${reads} reads) — a warmer would absorb the cold path.`,
          impact: 50,
        });
      }

      // Served almost entirely from the slow tier: the fast tier is either too
      // small or the promotion TTL is too short.
      const l1 = stat.hitsByLayer.L1 ?? 0;
      const l2 = stat.hitsByLayer.L2 ?? 0;
      if (stat.hits > MIN_SAMPLE && l2 > 0 && l1 / stat.hits < 0.2) {
        out.push({
          namespace: stat.namespace,
          kind: 'promote-to-l1',
          reason: `Only ${l1} of ${stat.hits} hits came from L1 — raise the L1 size or promotion TTL.`,
          impact: 40,
        });
      }
    }

    return out.sort((a, b) => b.impact - a.impact);
  }

  reset(): void {
    this.stats.clear();
  }
}
