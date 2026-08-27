/**
 * Intelligent cache middleware tests (issue #864).
 *
 * The eligibility and key-building rules get the most attention: caching an
 * authenticated response, or keying without a Vary header that matters, are
 * data-leak bugs rather than performance ones.
 */

import type { Request } from 'express';
import {
  buildCacheKey,
  isCacheableRequest,
  isCacheableResponse,
} from '../intelligent-cache.middleware';

const req = (over: Partial<Request> = {}): Request =>
  ({
    method: 'GET',
    url: '/api/mentors',
    originalUrl: '/api/mentors',
    headers: {},
    ...over,
  }) as Request;

describe('isCacheableRequest', () => {
  it('accepts a plain GET', () => {
    expect(isCacheableRequest(req())).toBe(true);
  });

  it('accepts HEAD', () => {
    expect(isCacheableRequest(req({ method: 'HEAD' }))).toBe(true);
  });

  it('rejects mutating methods', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(isCacheableRequest(req({ method }))).toBe(false);
    }
  });

  it('rejects an authenticated request', () => {
    // Serving one user's response to another is the worst bug a response
    // cache can have — this stays opt-in per route.
    expect(
      isCacheableRequest(req({ headers: { authorization: 'Bearer x' } })),
    ).toBe(false);
  });

  it('rejects a request carrying cookies', () => {
    expect(isCacheableRequest(req({ headers: { cookie: 'session=abc' } }))).toBe(false);
  });

  it('honours a client no-cache directive', () => {
    expect(
      isCacheableRequest(req({ headers: { 'cache-control': 'no-cache' } })),
    ).toBe(false);
  });

  it('honours no-store', () => {
    expect(
      isCacheableRequest(req({ headers: { 'cache-control': 'no-store' } })),
    ).toBe(false);
  });
});

describe('isCacheableResponse', () => {
  it('accepts 200 and 204', () => {
    expect(isCacheableResponse(200, {})).toBe(true);
    expect(isCacheableResponse(204, {})).toBe(true);
  });

  it('rejects errors', () => {
    // A cached 500 turns a transient fault into a sticky one.
    expect(isCacheableResponse(500, {})).toBe(false);
    expect(isCacheableResponse(404, {})).toBe(false);
  });

  it('rejects redirects', () => {
    expect(isCacheableResponse(302, {})).toBe(false);
  });

  it('rejects a response marked private or no-store', () => {
    expect(isCacheableResponse(200, { 'cache-control': 'private' })).toBe(false);
    expect(isCacheableResponse(200, { 'cache-control': 'no-store' })).toBe(false);
  });

  it('rejects a response that sets a cookie', () => {
    // Setting a cookie makes it user-specific almost by definition.
    expect(isCacheableResponse(200, { 'set-cookie': ['a=b'] })).toBe(false);
  });
});

describe('buildCacheKey', () => {
  it('includes method and path', () => {
    const key = buildCacheKey(req(), 'http');
    expect(key).toContain('GET');
    expect(key).toContain('/api/mentors');
  });

  it('sorts query parameters so equivalent URLs share an entry', () => {
    const a = buildCacheKey(req({ originalUrl: '/api/m?b=2&a=1' }), 'http');
    const b = buildCacheKey(req({ originalUrl: '/api/m?a=1&b=2' }), 'http');

    // Otherwise the cache fragments into near-duplicates and the hit rate
    // quietly collapses.
    expect(a).toBe(b);
  });

  it('distinguishes different query values', () => {
    const a = buildCacheKey(req({ originalUrl: '/api/m?page=1' }), 'http');
    const b = buildCacheKey(req({ originalUrl: '/api/m?page=2' }), 'http');
    expect(a).not.toBe(b);
  });

  it('varies on the configured headers', () => {
    const en = buildCacheKey(
      req({ headers: { 'accept-language': 'en' } }),
      'http',
      ['accept-language'],
    );
    const de = buildCacheKey(
      req({ headers: { 'accept-language': 'de' } }),
      'http',
      ['accept-language'],
    );

    // Omitting a header that changes the response is how a cache serves
    // German content to an English speaker.
    expect(en).not.toBe(de);
  });

  it('ignores headers not listed in vary', () => {
    const a = buildCacheKey(req({ headers: { 'x-trace': '1' } }), 'http');
    const b = buildCacheKey(req({ headers: { 'x-trace': '2' } }), 'http');
    expect(a).toBe(b);
  });

  it('treats a missing vary header as empty rather than throwing', () => {
    expect(() => buildCacheKey(req(), 'http', ['accept-language'])).not.toThrow();
  });

  it('namespaces the key', () => {
    expect(buildCacheKey(req(), 'mentors').startsWith('mentors:')).toBe(true);
  });

  it('separates methods', () => {
    expect(buildCacheKey(req({ method: 'GET' }), 'http')).not.toBe(
      buildCacheKey(req({ method: 'HEAD' }), 'http'),
    );
  });
});
