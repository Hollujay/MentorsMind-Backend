/**
 * Predictive load forecasting for auto-scaling (issue #862).
 *
 * Reactive autoscaling is always late: it observes saturation, then starts
 * instances that take a minute or more to become useful, so the spike is
 * already over — or has already caused errors — by the time capacity arrives.
 * Forecasting the next few minutes lets the scaler act before the load lands.
 *
 * The model is deliberately simple and explainable rather than a black box:
 *
 *   forecast = trend(EWMA) × seasonal factor(hour-of-week)
 *
 * A mentoring platform's load is strongly weekly-seasonal — Tuesday 19:00 looks
 * like last Tuesday 19:00, not like Tuesday 03:00 — so hour-of-week is the
 * natural cycle. EWMA carries the recent level and short-term trend.
 *
 * Everything here is pure: no clock, no metrics client, no cloud SDK. That is
 * what makes the forecasting logic unit-testable, which is the part that
 * actually decides how much money the cluster costs.
 */

export interface LoadSample {
  /** Epoch milliseconds. */
  timestamp: number;
  /** Observed load — requests/sec, CPU %, queue depth; unit is caller's choice. */
  value: number;
}

export interface Forecast {
  /** Predicted load at the horizon. */
  value: number;
  /** 0–1. Low when there is little history or the signal is erratic. */
  confidence: number;
  /** How far ahead this predicts, in ms. */
  horizonMs: number;
  /** Baseline level before seasonality was applied — useful for debugging. */
  baseline: number;
  /** Multiplier applied for the target hour-of-week. */
  seasonalFactor: number;
}

export interface PredictorOptions {
  /**
   * EWMA smoothing, 0–1. Higher reacts faster but chases noise.
   * 0.3 keeps roughly the last handful of samples dominant.
   */
  alpha?: number;
  /** Samples retained. Two weeks at 5-minute resolution ≈ 4032. */
  maxSamples?: number;
  /** Minimum samples in an hour-of-week bucket before its factor is trusted. */
  minSeasonalSamples?: number;
}

/** 168 hours in a week. */
const HOURS_PER_WEEK = 168;

/**
 * Hour-of-week index, 0 = Sunday 00:00 UTC.
 *
 * UTC on purpose: a scaler that silently shifts its seasonal profile twice a
 * year at DST boundaries is a genuinely horrible thing to debug.
 */
export function hourOfWeek(timestamp: number): number {
  const d = new Date(timestamp);
  return d.getUTCDay() * 24 + d.getUTCHours();
}

export class LoadPredictorService {
  private readonly samples: LoadSample[] = [];
  private readonly alpha: number;
  private readonly maxSamples: number;
  private readonly minSeasonalSamples: number;

  constructor({
    alpha = 0.3,
    maxSamples = 4032,
    minSeasonalSamples = 3,
  }: PredictorOptions = {}) {
    this.alpha = Math.min(1, Math.max(0.01, alpha));
    this.maxSamples = Math.max(2, maxSamples);
    this.minSeasonalSamples = Math.max(1, minSeasonalSamples);
  }

  /**
   * Record an observation.
   *
   * Non-finite and negative values are dropped rather than stored: a single
   * NaN from a scrape failure would otherwise poison the EWMA permanently,
   * and negative load is never meaningful.
   */
  record(sample: LoadSample): void {
    if (!Number.isFinite(sample.value) || sample.value < 0) return;
    if (!Number.isFinite(sample.timestamp)) return;

    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) {
      this.samples.splice(0, this.samples.length - this.maxSamples);
    }
  }

  recordMany(samples: LoadSample[]): void {
    for (const s of samples) this.record(s);
  }

  sampleCount(): number {
    return this.samples.length;
  }

  /** Exponentially weighted mean of the recorded series. */
  private ewma(): number {
    if (this.samples.length === 0) return 0;

    let acc = this.samples[0].value;
    for (let i = 1; i < this.samples.length; i += 1) {
      acc = this.alpha * this.samples[i].value + (1 - this.alpha) * acc;
    }
    return acc;
  }

  /**
   * Per-sample slope over the recent window, by least squares.
   *
   * Extrapolating a trend is only safe over a short horizon; the caller's
   * horizon is capped against the sample interval before this is applied.
   */
  private trendPerSample(window = 12): number {
    const n = Math.min(window, this.samples.length);
    if (n < 2) return 0;

    const recent = this.samples.slice(-n);
    const meanX = (n - 1) / 2;
    const meanY = recent.reduce((s, r) => s + r.value, 0) / n;

    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i += 1) {
      num += (i - meanX) * (recent[i].value - meanY);
      den += (i - meanX) ** 2;
    }

    return den === 0 ? 0 : num / den;
  }

  /**
   * Multiplier for a given hour-of-week: how that hour compares to the overall
   * mean. 1.0 means average; 1.8 means that hour typically runs 80% hotter.
   *
   * Returns exactly 1 when the bucket lacks evidence, so a thin history
   * degrades to "no seasonal adjustment" rather than to a wild guess.
   */
  seasonalFactor(targetHourOfWeek: number): number {
    if (this.samples.length === 0) return 1;

    const overallMean =
      this.samples.reduce((s, r) => s + r.value, 0) / this.samples.length;
    if (overallMean === 0) return 1;

    const bucket = this.samples.filter(
      (s) => hourOfWeek(s.timestamp) === ((targetHourOfWeek % HOURS_PER_WEEK) + HOURS_PER_WEEK) % HOURS_PER_WEEK,
    );
    if (bucket.length < this.minSeasonalSamples) return 1;

    const bucketMean = bucket.reduce((s, r) => s + r.value, 0) / bucket.length;
    const factor = bucketMean / overallMean;

    // Clamp: one freak spike in a sparse bucket should not authorise a 10x
    // scale-up a week later.
    return Math.min(3, Math.max(0.33, factor));
  }

  /**
   * Confidence in a forecast, 0–1.
   *
   * Two things erode it: too little history, and a series so erratic that the
   * mean says little (high coefficient of variation). The scaler uses this to
   * decide whether to act on a prediction or wait for observed load.
   */
  confidence(): number {
    const n = this.samples.length;
    if (n < 2) return 0;

    // Saturates at ~100 samples.
    const volume = Math.min(1, n / 100);

    const mean = this.samples.reduce((s, r) => s + r.value, 0) / n;
    if (mean === 0) return volume * 0.5;

    const variance =
      this.samples.reduce((s, r) => s + (r.value - mean) ** 2, 0) / n;
    const cv = Math.sqrt(variance) / mean;

    // cv 0 → 1.0, cv 1 → 0.5, cv 2 → 0.33
    const stability = 1 / (1 + cv);

    return Math.max(0, Math.min(1, volume * stability));
  }

  /**
   * Forecast load `horizonMs` ahead of `from`.
   *
   * With no history this returns a zero forecast at zero confidence — the
   * caller must not scale on it, and `confidence` makes that explicit rather
   * than dressing up a guess as a prediction.
   */
  predict(horizonMs: number, from: number = Date.now()): Forecast {
    if (this.samples.length === 0) {
      return {
        value: 0,
        confidence: 0,
        horizonMs,
        baseline: 0,
        seasonalFactor: 1,
      };
    }

    const level = this.ewma();
    const slope = this.trendPerSample();

    // Convert the horizon into "samples ahead" using the median observed
    // interval, so the trend extrapolation matches the real scrape cadence
    // rather than assuming one.
    const interval = this.medianIntervalMs();
    const stepsAhead = interval > 0 ? horizonMs / interval : 0;

    // Cap extrapolation at 12 steps: a linear trend held further out than the
    // window it was fitted on stops being a forecast and becomes fiction.
    const cappedSteps = Math.min(12, Math.max(0, stepsAhead));
    const baseline = Math.max(0, level + slope * cappedSteps);

    const factor = this.seasonalFactor(hourOfWeek(from + horizonMs));

    return {
      value: Math.max(0, baseline * factor),
      confidence: this.confidence(),
      horizonMs,
      baseline,
      seasonalFactor: factor,
    };
  }

  /** Median gap between consecutive samples, robust to scrape gaps. */
  medianIntervalMs(): number {
    if (this.samples.length < 2) return 0;

    const gaps: number[] = [];
    for (let i = 1; i < this.samples.length; i += 1) {
      const gap = this.samples[i].timestamp - this.samples[i - 1].timestamp;
      if (gap > 0) gaps.push(gap);
    }
    if (gaps.length === 0) return 0;

    gaps.sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)];
  }

  reset(): void {
    this.samples.length = 0;
  }
}
