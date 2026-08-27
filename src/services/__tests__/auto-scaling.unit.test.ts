/**
 * Predictive auto-scaling tests (issue #862).
 *
 * The decision engine is where the expensive mistakes live — flapping,
 * runaway scale-up, scaling down through a spike — so it is tested
 * exhaustively here without any cloud API.
 */

import {
  LoadPredictorService,
  hourOfWeek,
} from '../load-predictor.service';
import {
  AutoScalerService,
  DEFAULT_POLICY,
  instancesFor,
  type ScalerState,
  type ScalingPolicy,
} from '../auto-scaler.service';

// A fixed Sunday 00:00 UTC so hour-of-week maths is readable.
const SUNDAY_MIDNIGHT_UTC = Date.UTC(2026, 0, 4, 0, 0, 0);
const MINUTE = 60_000;

describe('hourOfWeek', () => {
  it('treats Sunday 00:00 UTC as hour 0', () => {
    expect(hourOfWeek(SUNDAY_MIDNIGHT_UTC)).toBe(0);
  });

  it('advances by one per hour', () => {
    expect(hourOfWeek(SUNDAY_MIDNIGHT_UTC + 3 * 3_600_000)).toBe(3);
  });

  it('rolls into the next day', () => {
    // Monday 00:00 = day 1 * 24
    expect(hourOfWeek(SUNDAY_MIDNIGHT_UTC + 24 * 3_600_000)).toBe(24);
  });
});

describe('LoadPredictorService', () => {
  let predictor: LoadPredictorService;

  beforeEach(() => {
    predictor = new LoadPredictorService();
  });

  const feedFlat = (count: number, value: number, start = SUNDAY_MIDNIGHT_UTC) => {
    for (let i = 0; i < count; i += 1) {
      predictor.record({ timestamp: start + i * 5 * MINUTE, value });
    }
  };

  describe('recording', () => {
    it('ignores non-finite values', () => {
      predictor.record({ timestamp: SUNDAY_MIDNIGHT_UTC, value: Number.NaN });
      predictor.record({ timestamp: SUNDAY_MIDNIGHT_UTC, value: Infinity });
      // A single NaN from a failed scrape would otherwise poison the EWMA.
      expect(predictor.sampleCount()).toBe(0);
    });

    it('ignores negative load', () => {
      predictor.record({ timestamp: SUNDAY_MIDNIGHT_UTC, value: -5 });
      expect(predictor.sampleCount()).toBe(0);
    });

    it('ignores a non-finite timestamp', () => {
      predictor.record({ timestamp: Number.NaN, value: 10 });
      expect(predictor.sampleCount()).toBe(0);
    });

    it('evicts oldest samples past the cap', () => {
      const small = new LoadPredictorService({ maxSamples: 10 });
      for (let i = 0; i < 25; i += 1) {
        small.record({ timestamp: SUNDAY_MIDNIGHT_UTC + i * MINUTE, value: i });
      }
      expect(small.sampleCount()).toBe(10);
    });
  });

  describe('predict', () => {
    it('returns a zero forecast at zero confidence with no history', () => {
      const f = predictor.predict(10 * MINUTE);
      // The caller must not scale on this, and confidence says so explicitly.
      expect(f.value).toBe(0);
      expect(f.confidence).toBe(0);
    });

    it('predicts near the recent level for a flat series', () => {
      feedFlat(50, 100);
      const f = predictor.predict(10 * MINUTE, SUNDAY_MIDNIGHT_UTC + 50 * 5 * MINUTE);
      expect(f.value).toBeGreaterThan(80);
      expect(f.value).toBeLessThan(130);
    });

    it('extrapolates an upward trend', () => {
      for (let i = 0; i < 30; i += 1) {
        predictor.record({
          timestamp: SUNDAY_MIDNIGHT_UTC + i * 5 * MINUTE,
          value: 50 + i * 5,
        });
      }
      const last = SUNDAY_MIDNIGHT_UTC + 29 * 5 * MINUTE;
      const f = predictor.predict(15 * MINUTE, last);

      // Rising series: the forecast must exceed the smoothed level, or
      // predictive scaling is pointless.
      expect(f.baseline).toBeGreaterThan(f.value / (f.seasonalFactor || 1) - 1);
      expect(f.value).toBeGreaterThan(100);
    });

    it('never predicts negative load from a falling trend', () => {
      for (let i = 0; i < 30; i += 1) {
        predictor.record({
          timestamp: SUNDAY_MIDNIGHT_UTC + i * 5 * MINUTE,
          value: Math.max(0, 200 - i * 20),
        });
      }
      const f = predictor.predict(60 * MINUTE, SUNDAY_MIDNIGHT_UTC + 29 * 5 * MINUTE);
      expect(f.value).toBeGreaterThanOrEqual(0);
    });

    it('reports the horizon it was asked for', () => {
      feedFlat(10, 50);
      expect(predictor.predict(7 * MINUTE).horizonMs).toBe(7 * MINUTE);
    });
  });

  describe('seasonality', () => {
    it('is neutral without enough evidence for the bucket', () => {
      feedFlat(5, 100);
      // A thin history degrades to "no adjustment", not a wild guess.
      expect(predictor.seasonalFactor(99)).toBe(1);
    });

    it('detects a recurring busy hour', () => {
      // Three weeks: hour 19 on Sunday runs hot, everything else is quiet.
      for (let week = 0; week < 3; week += 1) {
        for (let hour = 0; hour < 24; hour += 1) {
          const ts =
            SUNDAY_MIDNIGHT_UTC + week * 7 * 24 * 3_600_000 + hour * 3_600_000;
          predictor.record({ timestamp: ts, value: hour === 19 ? 300 : 50 });
        }
      }

      expect(predictor.seasonalFactor(19)).toBeGreaterThan(1.5);
      expect(predictor.seasonalFactor(3)).toBeLessThan(1.2);
    });

    it('clamps an extreme bucket', () => {
      for (let week = 0; week < 3; week += 1) {
        for (let hour = 0; hour < 24; hour += 1) {
          const ts =
            SUNDAY_MIDNIGHT_UTC + week * 7 * 24 * 3_600_000 + hour * 3_600_000;
          predictor.record({ timestamp: ts, value: hour === 12 ? 100_000 : 1 });
        }
      }
      // One freak bucket must not authorise a 10x scale-up a week later.
      expect(predictor.seasonalFactor(12)).toBeLessThanOrEqual(3);
    });

    it('handles an all-zero series without dividing by zero', () => {
      feedFlat(30, 0);
      expect(predictor.seasonalFactor(0)).toBe(1);
      expect(Number.isFinite(predictor.predict(MINUTE).value)).toBe(true);
    });
  });

  describe('confidence', () => {
    it('is zero with fewer than two samples', () => {
      predictor.record({ timestamp: SUNDAY_MIDNIGHT_UTC, value: 10 });
      expect(predictor.confidence()).toBe(0);
    });

    it('rises with more samples', () => {
      feedFlat(10, 100);
      const few = predictor.confidence();

      predictor.reset();
      feedFlat(100, 100);
      expect(predictor.confidence()).toBeGreaterThan(few);
    });

    it('is lower for an erratic series than a stable one', () => {
      feedFlat(100, 100);
      const stable = predictor.confidence();

      predictor.reset();
      for (let i = 0; i < 100; i += 1) {
        predictor.record({
          timestamp: SUNDAY_MIDNIGHT_UTC + i * 5 * MINUTE,
          value: i % 2 === 0 ? 5 : 400,
        });
      }
      expect(predictor.confidence()).toBeLessThan(stable);
    });

    it('stays within 0 and 1', () => {
      feedFlat(500, 42);
      const c = predictor.confidence();
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    });
  });

  it('computes a median sample interval robust to gaps', () => {
    predictor.record({ timestamp: 0, value: 1 });
    predictor.record({ timestamp: 5 * MINUTE, value: 1 });
    predictor.record({ timestamp: 10 * MINUTE, value: 1 });
    predictor.record({ timestamp: 120 * MINUTE, value: 1 }); // scrape gap

    expect(predictor.medianIntervalMs()).toBe(5 * MINUTE);
  });
});

describe('instancesFor', () => {
  it('accounts for target utilisation headroom', () => {
    // 100 capacity at 70% target = 70 usable per instance.
    expect(instancesFor(140, DEFAULT_POLICY)).toBe(2);
    expect(instancesFor(141, DEFAULT_POLICY)).toBe(3);
  });

  it('returns zero for no load', () => {
    expect(instancesFor(0, DEFAULT_POLICY)).toBe(0);
  });
});

describe('AutoScalerService', () => {
  let scaler: AutoScalerService;
  const now = SUNDAY_MIDNIGHT_UTC;

  const state = (over: Partial<ScalerState> = {}): ScalerState => ({
    currentInstances: 4,
    lastScaledAt: null,
    lastAction: null,
    ...over,
  });

  const policy = (over: Partial<ScalingPolicy> = {}): ScalingPolicy => ({
    ...DEFAULT_POLICY,
    ...over,
  });

  beforeEach(() => {
    scaler = new AutoScalerService();
  });

  describe('reactive scaling', () => {
    it('scales up when observed load exceeds capacity', () => {
      const d = scaler.decide({ state: state(), observedLoad: 500, now });
      expect(d.action).toBe('scale-up');
      expect(d.targetInstances).toBeGreaterThan(4);
    });

    it('holds when load matches current capacity', () => {
      // 4 instances × 70 usable = 280
      const d = scaler.decide({ state: state(), observedLoad: 280, now });
      expect(d.action).toBe('hold');
    });

    it('scales down when load drops', () => {
      const d = scaler.decide({ state: state({ currentInstances: 8 }), observedLoad: 70, now });
      expect(d.action).toBe('scale-down');
    });

    it('treats a non-finite observed load as zero', () => {
      const d = scaler.decide({
        state: state({ currentInstances: 2 }),
        observedLoad: Number.NaN,
        now,
      });
      expect(d.action).toBe('hold');
      expect(d.effectiveLoad).toBe(0);
    });
  });

  describe('predictive scaling', () => {
    const forecast = (value: number, confidence: number) => ({
      value,
      confidence,
      horizonMs: 10 * MINUTE,
      baseline: value,
      seasonalFactor: 1,
    });

    it('provisions early for a trusted forecast above observed load', () => {
      const d = scaler.decide({
        state: state(),
        observedLoad: 100,
        forecast: forecast(600, 0.9),
        now,
      });

      expect(d.action).toBe('scale-up');
      expect(d.predictive).toBe(true);
      expect(d.reason).toMatch(/forecast/i);
    });

    it('ignores a forecast below the confidence threshold', () => {
      // Observed load exactly fills the current 4 instances (4 x 70 = 280), so
      // the only thing that could move the needle is the forecast.
      const d = scaler.decide({
        state: state(),
        observedLoad: 280,
        forecast: forecast(600, 0.1),
        now,
      });
      // Acting on a low-confidence spike prediction is how a scaler burns money.
      expect(d.action).toBe('hold');
      expect(d.predictive).toBe(false);
    });

    it('never scales down on a forecast alone', () => {
      const d = scaler.decide({
        state: state({ currentInstances: 8 }),
        observedLoad: 500,
        forecast: forecast(10, 0.95),
        now,
      });
      // Observed load still needs the capacity; the forecast must not remove it.
      expect(d.action).not.toBe('scale-down');
    });

    it('blocks a scale-down while the forecast still needs the capacity', () => {
      const d = scaler.decide({
        state: state({ currentInstances: 8 }),
        observedLoad: 70,
        forecast: forecast(560, 0.9),
        now,
      });

      expect(d.action).toBe('hold');
      expect(d.reason).toMatch(/forecast still requires/i);
    });
  });

  describe('cooldowns', () => {
    it('blocks a second scale-up inside the cooldown', () => {
      const d = scaler.decide({
        state: state({ lastScaledAt: now - 10_000, lastAction: 'scale-up' }),
        observedLoad: 900,
        now,
      });

      expect(d.action).toBe('hold');
      expect(d.reason).toMatch(/cooling down/i);
    });

    it('allows a scale-up after the cooldown lapses', () => {
      const d = scaler.decide({
        state: state({ lastScaledAt: now - 120_000, lastAction: 'scale-up' }),
        observedLoad: 900,
        now,
      });
      expect(d.action).toBe('scale-up');
    });

    it('allows an immediate scale-up after a scale-down', () => {
      const d = scaler.decide({
        state: state({ lastScaledAt: now - 5_000, lastAction: 'scale-down' }),
        observedLoad: 900,
        now,
      });
      // Otherwise the scaler sits under-provisioned through its own cooldown.
      expect(d.action).toBe('scale-up');
    });

    it('blocks a scale-down inside the longer down cooldown', () => {
      const d = scaler.decide({
        state: state({ currentInstances: 8, lastScaledAt: now - 60_000, lastAction: 'scale-up' }),
        observedLoad: 70,
        now,
      });

      expect(d.action).toBe('hold');
      expect(d.reason).toMatch(/cooldown/i);
    });

    it('has no cooldown before the first action', () => {
      const d = scaler.decide({ state: state({ lastScaledAt: null }), observedLoad: 900, now });
      expect(d.action).toBe('scale-up');
    });
  });

  describe('limits', () => {
    it('clamps to maxInstances', () => {
      const d = scaler.decide({
        state: state(),
        observedLoad: 999_999,
        policy: policy({ maxInstances: 6 }),
        now,
      });

      expect(d.targetInstances).toBe(6);
      expect(d.constrainedBy).toBe('max');
    });

    it('never drops below minInstances', () => {
      const d = scaler.decide({
        state: state({ currentInstances: 3, lastScaledAt: null }),
        observedLoad: 0,
        policy: policy({ minInstances: 2, maxScaleDownStep: 10 }),
        now,
      });

      expect(d.targetInstances).toBeGreaterThanOrEqual(2);
    });

    it('reports the cost ceiling as the binding constraint', () => {
      const d = scaler.decide({
        state: state(),
        observedLoad: 999_999,
        policy: policy({ maxInstances: 50, costCeilingInstances: 8 }),
        now,
      });

      // An operator debugging "why am I stuck at 8?" needs the real reason.
      expect(d.targetInstances).toBe(8);
      expect(d.constrainedBy).toBe('cost-ceiling');
    });

    it('steps down gradually rather than in one cut', () => {
      const d = scaler.decide({
        state: state({ currentInstances: 12, lastScaledAt: null }),
        observedLoad: 0,
        policy: policy({ maxScaleDownStep: 2, minInstances: 1 }),
        now,
      });

      // A single large cut turns a lull into an outage when traffic returns.
      expect(d.targetInstances).toBe(10);
      expect(d.constrainedBy).toBe('scale-down-step');
    });
  });

  describe('applyDecision', () => {
    it('records the new instance count and timestamp', () => {
      const before = state();
      const decision = scaler.decide({ state: before, observedLoad: 900, now });
      const after = scaler.applyDecision(before, decision, now);

      expect(after.currentInstances).toBe(decision.targetInstances);
      expect(after.lastScaledAt).toBe(now);
      expect(after.lastAction).toBe('scale-up');
    });

    it('leaves state untouched on a hold', () => {
      const before = state();
      const decision = scaler.decide({ state: before, observedLoad: 280, now });
      expect(scaler.applyDecision(before, decision, now)).toBe(before);
    });
  });

  it('does not flap between up and down on steady load', () => {
    let current = state({ currentInstances: 4 });
    let clock = now;
    const actions: string[] = [];

    for (let i = 0; i < 10; i += 1) {
      const decision = scaler.decide({ state: current, observedLoad: 280, now: clock });
      actions.push(decision.action);
      current = scaler.applyDecision(current, decision, clock);
      clock += 30_000;
    }

    expect(actions.every((a) => a === 'hold')).toBe(true);
  });
});
