/**
 * CDN cache-policy configuration (issue #863).
 *
 * Provider credentials and toggles already live in `src/config/env.ts`, and
 * `cdn-geo.config.ts` covers geographic routing. What was missing is the
 * *cache policy* layer: how long each class of asset should live at the edge
 * and in the browser, and which must never be cached at all.
 *
 * Written as pure data plus pure functions so the header the CDN will actually
 * see is testable, which matters because a wrong `Cache-Control` is invisible
 * until content is stale for hours with no way to pull it back.
 */

export type AssetClass =
  /** Fingerprinted bundles — the filename changes when the content does. */
  | 'immutable'
  /** Images, fonts, other media served under a stable path. */
  | 'media'
  /** Rendered pages that tolerate brief staleness. */
  | 'page'
  /** JSON responses that are safe to cache for a short window. */
  | 'api-cacheable'
  /** Anything user-specific or authenticated. */
  | 'private'
  /** Auth, payments, anything that must never be stored. */
  | 'no-store';

export interface CachePolicy {
  /** Browser lifetime, seconds. */
  maxAge: number;
  /** Edge/shared-cache lifetime, seconds. */
  sharedMaxAge: number;
  /** How long a stale copy may be served while revalidating behind it. */
  staleWhileRevalidate: number;
  /** How long a stale copy may be served when the origin is failing. */
  staleIfError: number;
  /** `public` allows shared caches to store it; `private` does not. */
  visibility: 'public' | 'private';
  immutable?: boolean;
  noStore?: boolean;
}

const YEAR = 31_536_000;
const DAY = 86_400;
const HOUR = 3_600;
const MINUTE = 60;

/**
 * Default policy per asset class.
 *
 * `staleIfError` is generous almost everywhere on purpose: serving slightly
 * stale content during an origin incident is nearly always better than serving
 * an error page, and it is the cheapest availability win a CDN offers.
 */
export const CACHE_POLICIES: Record<AssetClass, CachePolicy> = {
  immutable: {
    // Safe only because the filename is content-addressed: a change ships a
    // new URL, so nothing has to expire.
    maxAge: YEAR,
    sharedMaxAge: YEAR,
    staleWhileRevalidate: 0,
    staleIfError: 0,
    visibility: 'public',
    immutable: true,
  },
  media: {
    maxAge: DAY,
    sharedMaxAge: 30 * DAY,
    staleWhileRevalidate: DAY,
    staleIfError: 7 * DAY,
    visibility: 'public',
  },
  page: {
    // Short browser TTL, long edge TTL: a purge reaches the edge, but nothing
    // can reach a copy already sitting in someone's browser.
    maxAge: 0,
    sharedMaxAge: 5 * MINUTE,
    staleWhileRevalidate: HOUR,
    staleIfError: DAY,
    visibility: 'public',
  },
  'api-cacheable': {
    maxAge: 0,
    sharedMaxAge: 30,
    staleWhileRevalidate: 2 * MINUTE,
    staleIfError: 10 * MINUTE,
    visibility: 'public',
  },
  private: {
    maxAge: 0,
    sharedMaxAge: 0,
    staleWhileRevalidate: 0,
    staleIfError: 0,
    visibility: 'private',
  },
  'no-store': {
    maxAge: 0,
    sharedMaxAge: 0,
    staleWhileRevalidate: 0,
    staleIfError: 0,
    visibility: 'private',
    noStore: true,
  },
};

/**
 * Render a policy as a `Cache-Control` value.
 *
 * `no-store` short-circuits everything: emitting it alongside `max-age` is a
 * contradiction that different caches resolve differently, which is the worst
 * possible outcome for something protecting authenticated content.
 */
export function toCacheControl(policy: CachePolicy): string {
  if (policy.noStore) return 'no-store, no-cache, must-revalidate';

  const parts: string[] = [policy.visibility];
  parts.push(`max-age=${Math.max(0, policy.maxAge)}`);

  if (policy.visibility === 'public' && policy.sharedMaxAge > 0) {
    parts.push(`s-maxage=${policy.sharedMaxAge}`);
  }
  if (policy.staleWhileRevalidate > 0) {
    parts.push(`stale-while-revalidate=${policy.staleWhileRevalidate}`);
  }
  if (policy.staleIfError > 0) {
    parts.push(`stale-if-error=${policy.staleIfError}`);
  }
  if (policy.immutable) parts.push('immutable');
  if (policy.visibility === 'private' && policy.maxAge === 0) {
    parts.push('no-cache');
  }

  return parts.join(', ');
}

/** Extensions treated as long-lived media. */
const MEDIA_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico',
  'woff', 'woff2', 'ttf', 'otf', 'mp4', 'webm', 'pdf',
]);

/** Path prefixes that must never be cached, regardless of extension. */
const NEVER_CACHE_PREFIXES = ['/auth', '/api/auth', '/payments', '/api/payments', '/admin'];

/**
 * A content hash in the filename, e.g. `app.4f3a91c2.js`.
 *
 * At least 8 hex characters between dots — short enough to catch real build
 * fingerprints, long enough not to match `v2` or a date.
 */
const FINGERPRINTED = /\.[0-9a-f]{8,}\.[a-z0-9]+$/i;

/**
 * Classify a request path.
 *
 * Order matters: the never-cache prefixes are checked before anything else, so
 * a path like `/auth/logo.png` is not classified as cacheable media just
 * because of its extension.
 */
export function classifyAsset(path: string, isAuthenticated = false): AssetClass {
  const clean = path.split('?')[0].toLowerCase();

  if (NEVER_CACHE_PREFIXES.some((p) => clean === p || clean.startsWith(`${p}/`))) {
    return 'no-store';
  }

  if (isAuthenticated) return 'private';

  if (FINGERPRINTED.test(clean)) return 'immutable';

  const ext = clean.includes('.') ? clean.slice(clean.lastIndexOf('.') + 1) : '';
  if (MEDIA_EXTENSIONS.has(ext)) return 'media';

  if (clean.startsWith('/api/')) return 'api-cacheable';

  return 'page';
}

/** Convenience: classify a path and render its header in one step. */
export function cacheControlFor(path: string, isAuthenticated = false): string {
  return toCacheControl(CACHE_POLICIES[classifyAsset(path, isAuthenticated)]);
}

export interface CdnProviderCapabilities {
  /** Supports purging by wildcard rather than exact path only. */
  wildcardPurge: boolean;
  /** Supports tag/surrogate-key based purging. */
  tagPurge: boolean;
  /** Can run edge functions. */
  edgeFunctions: boolean;
  /** Maximum paths accepted in a single purge request. */
  maxPurgePaths: number;
}

/**
 * Per-provider capabilities.
 *
 * Purge batching in particular differs enough between providers to matter: a
 * caller that assumes CloudFront's 3,000-path batch against Cloudflare's 30
 * gets a rejected request during an incident, which is exactly when a purge
 * needs to work.
 */
export const PROVIDER_CAPABILITIES: Record<string, CdnProviderCapabilities> = {
  cloudfront: {
    wildcardPurge: true,
    tagPurge: false,
    edgeFunctions: true,
    maxPurgePaths: 3_000,
  },
  cloudflare: {
    wildcardPurge: false,
    tagPurge: true,
    edgeFunctions: true,
    maxPurgePaths: 30,
  },
  fastly: {
    wildcardPurge: false,
    tagPurge: true,
    edgeFunctions: true,
    maxPurgePaths: 256,
  },
};

/** Capabilities for a provider, or `null` if unknown. */
export function capabilitiesFor(provider: string | undefined): CdnProviderCapabilities | null {
  if (!provider) return null;
  return PROVIDER_CAPABILITIES[provider.toLowerCase()] ?? null;
}

/**
 * Split paths into provider-sized purge batches.
 *
 * Returns a single empty-free list when there is nothing to purge, so callers
 * can iterate without a length check.
 */
export function batchPurgePaths(
  paths: string[],
  provider: string | undefined,
): string[][] {
  const unique = [...new Set(paths.filter((p) => p.trim().length > 0))];
  if (unique.length === 0) return [];

  const limit = capabilitiesFor(provider)?.maxPurgePaths ?? 100;
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += limit) {
    batches.push(unique.slice(i, i + limit));
  }
  return batches;
}
