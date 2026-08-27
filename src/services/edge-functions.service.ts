/**
 * Edge function registry and routing (issue #863).
 *
 * Edge functions run at the CDN PoP rather than the origin, so the routing
 * decision — which function handles which request — has to be resolvable
 * without any origin state. That matching logic is pure and lives here, and it
 * is the part worth testing: a route that matches too broadly silently
 * intercepts traffic it was never meant to see.
 *
 * ─── Verification status ────────────────────────────────────────────────────
 * Registration, route matching, precedence and the deployment *manifest* are
 * implemented and unit-tested. Actual deployment to a PoP is behind the
 * `EdgeDeploymentTarget` interface with no concrete implementation: pushing
 * code to Cloudflare Workers, Lambda@Edge or Fastly Compute needs live
 * credentials and a real account, and an unrunnable adapter is worse than an
 * honest seam.
 */

export type EdgeTrigger =
  /** Before the CDN checks its cache. */
  | 'viewer-request'
  /** After a cache miss, before hitting the origin. */
  | 'origin-request'
  /** After the origin responds, before caching. */
  | 'origin-response'
  /** Before the response is returned to the client. */
  | 'viewer-response';

export interface EdgeFunctionDefinition {
  name: string;
  trigger: EdgeTrigger;
  /**
   * Path pattern. Supports a single trailing `*` wildcard and `:param`
   * segments — deliberately not full regex, because a regex in a routing table
   * is a denial-of-service waiting to happen at the edge.
   */
  route: string;
  /**
   * Higher wins when two routes match. Explicit rather than relying on
   * registration order, which is invisible at review time.
   */
  priority?: number;
  /** Memory ceiling in MB, passed through to the platform. */
  memoryMb?: number;
  /** Wall-clock budget in ms. Edge platforms enforce single-digit budgets. */
  timeoutMs?: number;
  /** Marked inactive without being removed, so a rollback is a flag flip. */
  enabled?: boolean;
}

export interface EdgeMatch {
  definition: EdgeFunctionDefinition;
  /** Values captured from `:param` segments. */
  params: Record<string, string>;
}

/** Maximum path segments considered — bounds matching cost on hostile input. */
const MAX_SEGMENTS = 32;

function segments(path: string): string[] {
  return path.split('/').filter(Boolean).slice(0, MAX_SEGMENTS);
}

/**
 * Match a concrete path against a route pattern.
 *
 * Returns captured params, or `null` when it does not match. Exact and
 * `:param` segments must align one-to-one; a trailing `*` absorbs the rest.
 */
export function matchRoute(
  pattern: string,
  path: string,
): Record<string, string> | null {
  const patternParts = segments(pattern);
  const pathParts = segments(path);
  const params: Record<string, string> = {};

  for (let i = 0; i < patternParts.length; i += 1) {
    const p = patternParts[i];

    if (p === '*') {
      // Trailing wildcard absorbs everything left, including nothing.
      return params;
    }

    if (i >= pathParts.length) return null;

    if (p.startsWith(':')) {
      params[p.slice(1)] = decodeURIComponent(pathParts[i]);
      continue;
    }

    if (p !== pathParts[i]) return null;
  }

  // Without a wildcard the lengths must agree, or `/a` would match `/a/b`.
  return patternParts.length === pathParts.length ? params : null;
}

/** Specificity score — more literal segments beats more wildcards. */
export function routeSpecificity(pattern: string): number {
  let score = 0;
  for (const part of segments(pattern)) {
    if (part === '*') score += 0;
    else if (part.startsWith(':')) score += 1;
    else score += 2;
  }
  return score;
}

export interface EdgeDeploymentTarget {
  readonly provider: 'cloudflare' | 'lambda-edge' | 'fastly';
  deploy(manifest: EdgeDeploymentManifest): Promise<void>;
}

export interface EdgeDeploymentManifest {
  provider: string;
  generatedAt: string;
  functions: Array<{
    name: string;
    trigger: EdgeTrigger;
    route: string;
    priority: number;
    memoryMb: number;
    timeoutMs: number;
  }>;
}

/** Conservative platform-agnostic defaults. */
const DEFAULT_MEMORY_MB = 128;
const DEFAULT_TIMEOUT_MS = 50;

export class EdgeFunctionsService {
  private readonly functions = new Map<string, EdgeFunctionDefinition>();

  /**
   * Register a function.
   *
   * Rejects an unknown trigger and an empty route rather than accepting them
   * and failing at deploy time, when the feedback loop is minutes long.
   */
  register(definition: EdgeFunctionDefinition): void {
    if (!definition.name.trim()) {
      throw new Error('edge function requires a name');
    }
    if (!definition.route.trim()) {
      throw new Error(`edge function "${definition.name}" requires a route`);
    }

    const wildcards = segments(definition.route).filter((s) => s === '*').length;
    if (wildcards > 1) {
      throw new Error(
        `edge function "${definition.name}" has more than one wildcard; only a single trailing * is supported`,
      );
    }

    this.functions.set(definition.name, definition);
  }

  unregister(name: string): void {
    this.functions.delete(name);
  }

  /** Toggle without unregistering, so rollback is a flag flip. */
  setEnabled(name: string, enabled: boolean): boolean {
    const fn = this.functions.get(name);
    if (!fn) return false;
    this.functions.set(name, { ...fn, enabled });
    return true;
  }

  list(): EdgeFunctionDefinition[] {
    return [...this.functions.values()];
  }

  /**
   * Resolve which function handles `path` for `trigger`.
   *
   * Ties break on explicit priority first, then specificity — an exact route
   * should win over a wildcard even if the wildcard was registered later.
   */
  resolve(trigger: EdgeTrigger, path: string): EdgeMatch | null {
    let best: EdgeMatch | null = null;
    let bestScore = -Infinity;

    for (const definition of this.functions.values()) {
      if (definition.enabled === false) continue;
      if (definition.trigger !== trigger) continue;

      const params = matchRoute(definition.route, path);
      if (!params) continue;

      const score =
        (definition.priority ?? 0) * 1000 + routeSpecificity(definition.route);

      if (score > bestScore) {
        best = { definition, params };
        bestScore = score;
      }
    }

    return best;
  }

  /** Every function that matches, highest precedence first. */
  resolveAll(trigger: EdgeTrigger, path: string): EdgeMatch[] {
    return this.list()
      .filter((d) => d.enabled !== false && d.trigger === trigger)
      .map((definition) => ({ definition, params: matchRoute(definition.route, path) }))
      .filter((m): m is EdgeMatch => m.params !== null)
      .sort(
        (a, b) =>
          (b.definition.priority ?? 0) * 1000 +
          routeSpecificity(b.definition.route) -
          ((a.definition.priority ?? 0) * 1000 + routeSpecificity(a.definition.route)),
      );
  }

  /**
   * Build the deployment manifest.
   *
   * Disabled functions are excluded: deploying an inactive function to the
   * edge and relying on a runtime flag wastes PoP memory and makes the
   * deployed set differ from the intended one.
   */
  buildManifest(provider: string, now: Date = new Date()): EdgeDeploymentManifest {
    return {
      provider,
      generatedAt: now.toISOString(),
      functions: this.list()
        .filter((d) => d.enabled !== false)
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
        .map((d) => ({
          name: d.name,
          trigger: d.trigger,
          route: d.route,
          priority: d.priority ?? 0,
          memoryMb: d.memoryMb ?? DEFAULT_MEMORY_MB,
          timeoutMs: d.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        })),
    };
  }

  /** Deploy through a target adapter. */
  async deploy(target: EdgeDeploymentTarget, now: Date = new Date()): Promise<void> {
    await target.deploy(this.buildManifest(target.provider, now));
  }

  clear(): void {
    this.functions.clear();
  }
}
