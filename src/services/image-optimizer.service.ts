/**
 * Image optimisation and format negotiation (issue #863).
 *
 * `cdn.service.ts` already knows how to re-encode a buffer with sharp. What was
 * missing is the decision layer around it: *which* format to serve to *this*
 * client, and which variants are worth generating at all.
 *
 * Those decisions are pure functions here, separate from any pixel work, so
 * the negotiation and planning logic is unit-testable without sharp, a network
 * or an image. Getting them wrong is silent — a browser that cannot decode
 * AVIF gets a broken image, and nobody sees it in a test that only checks
 * "did sharp run".
 */

export type ImageFormat = 'avif' | 'webp' | 'jpeg' | 'png';

export interface NegotiationResult {
  format: ImageFormat;
  /** Why this format was chosen — surfaced in logs and `Vary` debugging. */
  reason: string;
}

/**
 * Preference order when a client supports several.
 *
 * AVIF first: typically 20–30% smaller than WebP at equivalent quality. WebP
 * next, then JPEG as the universal fallback.
 */
const PREFERENCE: ImageFormat[] = ['avif', 'webp', 'jpeg'];

const ACCEPT_TOKENS: Record<string, ImageFormat> = {
  'image/avif': 'avif',
  'image/webp': 'webp',
  'image/jpeg': 'jpeg',
  'image/png': 'png',
};

/**
 * Parse an `Accept` header into the formats a client will take.
 *
 * `image/*` is treated as "modern formats are fine" — a client claiming a
 * wildcard is asserting it can decode whatever the server picks, and every
 * browser that sends a bare `image/*` today handles WebP.
 *
 * A `q=0` entry is an explicit refusal and is honoured; a malformed q value is
 * ignored rather than treated as a refusal, since dropping a format because of
 * a typo'd header degrades quality for no reason.
 */
export function parseAcceptHeader(header: string | undefined | null): Set<ImageFormat> {
  const accepted = new Set<ImageFormat>();
  if (!header) return accepted;

  for (const rawPart of header.split(',')) {
    const part = rawPart.trim().toLowerCase();
    if (!part) continue;

    const [type, ...params] = part.split(';').map((p) => p.trim());

    // Honour an explicit q=0 refusal.
    const qParam = params.find((p) => p.startsWith('q='));
    if (qParam) {
      const q = Number(qParam.slice(2));
      if (Number.isFinite(q) && q === 0) continue;
    }

    if (type === '*/*' || type === 'image/*') {
      accepted.add('webp');
      accepted.add('jpeg');
      accepted.add('png');
      continue;
    }

    const format = ACCEPT_TOKENS[type];
    if (format) accepted.add(format);
  }

  return accepted;
}

/**
 * Pick the best format this client will accept.
 *
 * Falls back to JPEG when the header says nothing useful — serving a format
 * the client never claimed is how you get a broken image in an old browser,
 * and JPEG is decodable everywhere.
 *
 * PNG sources with transparency are never downgraded to JPEG, which has no
 * alpha channel: a logo would silently gain a black background.
 */
export function negotiateFormat(
  acceptHeader: string | undefined | null,
  options: { sourceHasAlpha?: boolean } = {},
): NegotiationResult {
  const accepted = parseAcceptHeader(acceptHeader);

  if (accepted.size === 0) {
    return {
      format: options.sourceHasAlpha ? 'png' : 'jpeg',
      reason: 'no usable Accept header; using the universally decodable fallback',
    };
  }

  for (const candidate of PREFERENCE) {
    if (!accepted.has(candidate)) continue;

    // JPEG cannot carry alpha — fall through to PNG instead of flattening.
    if (candidate === 'jpeg' && options.sourceHasAlpha) {
      return {
        format: 'png',
        reason: 'source has transparency; JPEG would flatten the alpha channel',
      };
    }

    return { format: candidate, reason: `client accepts ${candidate}` };
  }

  if (accepted.has('png')) {
    return { format: 'png', reason: 'client accepts png only' };
  }

  return {
    format: options.sourceHasAlpha ? 'png' : 'jpeg',
    reason: 'no preferred format accepted; using the fallback',
  };
}

export interface VariantSpec {
  width: number;
  /** Suffix for the generated asset, e.g. `-640w`. */
  suffix: string;
}

/**
 * Default responsive breakpoints.
 *
 * Chosen to cover phone → desktop without generating a variant per device:
 * each roughly doubles, so the browser never downloads more than ~40% extra
 * pixels for its viewport.
 */
export const DEFAULT_BREAKPOINTS = [320, 640, 1024, 1600] as const;

/**
 * Plan which variants to generate for a source image.
 *
 * Never upscales: generating a 1600px variant from a 400px source produces a
 * blurry file that is *larger* than the original, which is the opposite of the
 * point. The source width is always included so there is an exact-fit variant.
 */
export function planVariants(
  sourceWidth: number,
  breakpoints: readonly number[] = DEFAULT_BREAKPOINTS,
): VariantSpec[] {
  if (!Number.isFinite(sourceWidth) || sourceWidth <= 0) return [];

  const widths = new Set<number>();
  for (const bp of breakpoints) {
    if (bp < sourceWidth) widths.add(bp);
  }
  widths.add(Math.floor(sourceWidth));

  return [...widths]
    .sort((a, b) => a - b)
    .map((width) => ({ width, suffix: `-${width}w` }));
}

/**
 * Build a `srcset` value from generated variants.
 *
 * Returns an empty string for no variants, so a caller can omit the attribute
 * entirely rather than emitting `srcset=""`, which some browsers treat as a
 * broken candidate list.
 */
export function buildSrcSet(
  baseUrl: string,
  variants: VariantSpec[],
  extension: string,
): string {
  if (variants.length === 0) return '';

  return variants
    .map((v) => `${baseUrl}${v.suffix}.${extension} ${v.width}w`)
    .join(', ');
}

export interface OptimizationPlan {
  format: ImageFormat;
  formatReason: string;
  variants: VariantSpec[];
  /** Encoder quality, 1–100. */
  quality: number;
  /** True when the source is already smaller than any breakpoint. */
  singleVariant: boolean;
}

/**
 * Quality per format.
 *
 * AVIF and WebP hold up at lower numbers than JPEG for the same perceived
 * quality, so using one number for all three either bloats the modern formats
 * or degrades the fallback.
 */
const QUALITY: Record<ImageFormat, number> = {
  avif: 50,
  webp: 75,
  jpeg: 82,
  png: 90,
};

/** Compose the full plan for one request. */
export function planOptimization(params: {
  sourceWidth: number;
  acceptHeader?: string | null;
  sourceHasAlpha?: boolean;
  breakpoints?: readonly number[];
  qualityOverride?: number;
}): OptimizationPlan {
  const negotiation = negotiateFormat(params.acceptHeader, {
    sourceHasAlpha: params.sourceHasAlpha,
  });
  const variants = planVariants(params.sourceWidth, params.breakpoints);

  const quality =
    params.qualityOverride !== undefined && Number.isFinite(params.qualityOverride)
      ? Math.min(100, Math.max(1, params.qualityOverride))
      : QUALITY[negotiation.format];

  return {
    format: negotiation.format,
    formatReason: negotiation.reason,
    variants,
    quality,
    singleVariant: variants.length <= 1,
  };
}

/**
 * `Vary` value for an optimised image response.
 *
 * Without `Vary: Accept`, a shared cache will happily serve the AVIF it stored
 * for a modern browser to a client that cannot decode it — a cache poisoning
 * bug that only shows up for a subset of users.
 */
export const IMAGE_VARY_HEADER = 'Accept';
