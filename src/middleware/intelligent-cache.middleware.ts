/**
 * Intelligent response cache middleware (issue #864).
 *
 * Sits in front of a handler and serves a cached response when one is
 * available, using the multi-layer `CacheOrchestrator` underneath.
 *
 * The existing `cache.middleware.ts` caches by URL. The decisions that make a
 * response cache *correct* rather than merely fast are the ones extracted here
 * as pure functions: whether a request is even eligible, what the key varies
 * on, and whether a response is safe to store. Each of those, done wrong, is a
 * data-leak or a stale-forever bug rather than a slow page.
 */

import type { Request, Response, NextFunction } from 'express';
import type { CacheOrchestrator } from '../services/cache-orchestrator.service';

export interface CachedResponse {
  status: number;
  body: unknown;
  /** Only the headers worth replaying — not the whole set. */
  headers: Record<string, string>;
  /** Epoch ms the entry was stored, used for an Age header. */
  storedAt: number;
}

export interface IntelligentCacheOptions {
  orchestrator: CacheOrchestrator;
  ttlSeconds?: number;
  /** Namespace prefix for keys. */
  namespace?: string;
  /** Extra request headers the key should vary on, e.g. `accept-language`. */
  varyHeaders?: string[];
  /**
   * Entities this route's response derives from, for dependency-tracked
   * invalidation. Receives the request so it can include path params.
   */
  dependsOn?: (req: Request) => string[];
  /** Override eligibility, e.g. to cache a specific authenticated route. */
  isEligible?: (req: Request) => boolean;
}

/** Headers replayed from a cached response. */
const REPLAYABLE_HEADERS = ['content-type', 'content-language', 'etag'];

/**
 * Whether a request may be served from cache.
 *
 * Authenticated requests are excluded by default. Caching a response produced
 * for one user and serving it to another is the single worst bug a response
 * cache can have, so it is opt-in per route rather than something a
 * `varyHeaders` misconfiguration can switch on by accident.
 */
export function isCacheableRequest(req: Request): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  // An explicit no-cache from the client is a request to revalidate.
  const cacheControl = String(req.headers['cache-control'] ?? '');
  if (/no-cache|no-store/i.test(cacheControl)) return false;

  if (req.headers.authorization) return false;
  if (req.headers.cookie) return false;

  return true;
}

/**
 * Whether a response may be stored.
 *
 * Only 200 and 204: a 404 or 500 cached for even a minute turns a transient
 * fault into a sticky one, and a 3xx cached against the wrong key sends users
 * somewhere they did not ask to go.
 */
export function isCacheableResponse(
  status: number,
  headers: Record<string, unknown>,
): boolean {
  if (status !== 200 && status !== 204) return false;

  const cacheControl = String(headers['cache-control'] ?? '');
  if (/no-store|private/i.test(cacheControl)) return false;

  // A response that set a cookie is user-specific almost by definition.
  if (headers['set-cookie']) return false;

  return true;
}

/**
 * Build the cache key.
 *
 * Query parameters are sorted so `?a=1&b=2` and `?b=2&a=1` share an entry —
 * otherwise the cache fragments into near-duplicates and the hit rate quietly
 * collapses.
 *
 * Every header named in `varyHeaders` is folded in. Omitting one that changes
 * the response is how a cache serves German content to an English speaker.
 */
export function buildCacheKey(
  req: Request,
  namespace: string,
  varyHeaders: string[] = [],
): string {
  const url = new URL(req.originalUrl ?? req.url ?? '/', 'http://internal');
  const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  const query = params.map(([k, v]) => `${k}=${v}`).join('&');

  const vary = varyHeaders
    .map((h) => `${h}=${String(req.headers[h.toLowerCase()] ?? '')}`)
    .join('|');

  return [namespace, req.method, url.pathname, query, vary]
    .filter((part) => part !== '')
    .join(':');
}

/**
 * Express middleware factory.
 *
 * On a hit the cached body is sent directly. On a miss `res.json` is wrapped
 * so the response is captured on its way out, then stored — without requiring
 * every handler to know it is being cached.
 */
export function intelligentCache({
  orchestrator,
  ttlSeconds = 60,
  namespace = 'http',
  varyHeaders = [],
  dependsOn,
  isEligible = isCacheableRequest,
}: IntelligentCacheOptions) {
  return async function intelligentCacheMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!isEligible(req)) {
      next();
      return;
    }

    const key = buildCacheKey(req, namespace, varyHeaders);

    try {
      const hit = await orchestrator.get<CachedResponse>(key);
      if (hit) {
        for (const [name, value] of Object.entries(hit.headers)) {
          res.setHeader(name, value);
        }
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('Age', String(Math.floor((Date.now() - hit.storedAt) / 1000)));
        res.status(hit.status).json(hit.body);
        return;
      }
    } catch {
      // A cache read failure must never fail the request — fall through to the
      // handler, which is the whole point of a cache being an optimisation.
    }

    res.setHeader('X-Cache', 'MISS');

    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      const headers: Record<string, string> = {};
      for (const name of REPLAYABLE_HEADERS) {
        const value = res.getHeader(name);
        if (typeof value === 'string') headers[name] = value;
      }

      if (isCacheableResponse(res.statusCode, res.getHeaders())) {
        const entry: CachedResponse = {
          status: res.statusCode,
          body,
          headers,
          storedAt: Date.now(),
        };

        // Fire-and-forget: the client should not wait on the cache write, and
        // a failed write is not a failed request.
        void orchestrator
          .set(key, entry, {
            ttlSeconds,
            dependsOn: dependsOn?.(req),
          })
          .catch(() => undefined);
      }

      return originalJson(body);
    }) as Response['json'];

    next();
  };
}
