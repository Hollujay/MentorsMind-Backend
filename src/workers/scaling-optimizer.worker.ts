/**
 * Scaling optimiser worker (issue #862).
 *
 * Runs the observe → forecast → decide → apply loop on an interval. The
 * decision logic lives in `AutoScalerService` and the forecasting in
 * `LoadPredictorService`; this file is only the loop and the plumbing to a
 * provider.
 *
 * ─── Verification status ────────────────────────────────────────────────────
 * The loop and the SLA/cost bookkeeping below are exercised by unit tests
 * through injected fakes. The *provider adapter* is an interface with no
 * concrete implementation in this PR: applying a scaling decision requires a
 * real cloud account, and shipping an untested ECS/Kubernetes client would be
 * guessing at an API I cannot run. Implementing `ScalingProvider` against the
 * platform this actually deploys to is the remaining work.
 */

import {
  AutoScalerService,
  DEFAULT_POLICY,
  type ScalerState,
  type ScalingDecision,
  type ScalingPolicy,
} from '../services/auto-scaler.service';
import { LoadPredictorService } from '../services/load-predictor.service';

/**
 * What a cloud platform must supply for the optimiser to drive it.
 *
 * Deliberately tiny: read the current count, read load, set the count. Every
 * platform can do these three things, which keeps the multi-cloud story a
 * matter of writing a small adapter rather than abstracting over whole SDKs.
 */
export interface ScalingProvider {
  readonly name: string;
  /** Instances currently running. */
  getCurrentInstances(): Promise<number>;
  /** Current load in the same unit as `capacityPerInstance`. */
  getCurrentLoad(): Promise<number>;
  /** Request `count` instances. Should be idempotent. */
  setInstances(count: number): Promise<void>;
}

export interface SlaSnapshot {
  /** Ticks where capacity met or exceeded demand. */
  satisfied: number;
  /** Ticks where demand exceeded capacity — the SLA-breaching ones. */
  breached: number;
  /** satisfied / (satisfied + breached), or null before any tick. */
  attainment: number | null;
}

export interface OptimizerTickResult {
  decision: ScalingDecision;
  state: ScalerState;
  /** True when capacity was below demand at this tick. */
  slaBreach: boolean;
  /** Instance-ticks accumulated, a proxy for spend. */
  instanceTicks: number;
}

export interface OptimizerOptions {
  provider: ScalingProvider;
  policy?: ScalingPolicy;
  predictor?: LoadPredictorService;
  scaler?: AutoScalerService;
  /** How far ahead to forecast. Should exceed instance start-up time. */
  forecastHorizonMs?: number;
  /** Loop interval. */
  intervalMs?: number;
  now?: () => number;
  onTick?: (result: OptimizerTickResult) => void;
  onError?: (error: Error) => void;
}

export class ScalingOptimizerWorker {
  private readonly provider: ScalingProvider;
  private readonly policy: ScalingPolicy;
  private readonly predictor: LoadPredictorService;
  private readonly scaler: AutoScalerService;
  private readonly forecastHorizonMs: number;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly onTick?: (result: OptimizerTickResult) => void;
  private readonly onError?: (error: Error) => void;

  private state: ScalerState = {
    currentInstances: 0,
    lastScaledAt: null,
    lastAction: null,
  };

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private sla: SlaSnapshot = { satisfied: 0, breached: 0, attainment: null };
  private instanceTicks = 0;

  constructor({
    provider,
    policy = DEFAULT_POLICY,
    predictor = new LoadPredictorService(),
    scaler = new AutoScalerService(),
    // Default horizon exceeds typical container start-up, which is the whole
    // point: a forecast that lands inside the boot time arrives too late.
    forecastHorizonMs = 5 * 60_000,
    intervalMs = 30_000,
    now = Date.now,
    onTick,
    onError,
  }: OptimizerOptions) {
    this.provider = provider;
    this.policy = policy;
    this.predictor = predictor;
    this.scaler = scaler;
    this.forecastHorizonMs = forecastHorizonMs;
    this.intervalMs = intervalMs;
    this.now = now;
    this.onTick = onTick;
    this.onError = onError;
  }

  /**
   * One observe → decide → apply cycle.
   *
   * Returns `null` when the tick could not complete. Errors are reported and
   * swallowed rather than thrown: a metrics endpoint being briefly unreachable
   * must not kill the worker and leave the cluster frozen at its current size.
   */
  async tick(): Promise<OptimizerTickResult | null> {
    try {
      const [currentInstances, observedLoad] = await Promise.all([
        this.provider.getCurrentInstances(),
        this.provider.getCurrentLoad(),
      ]);

      const at = this.now();
      this.predictor.record({ timestamp: at, value: observedLoad });
      this.state = { ...this.state, currentInstances };

      const forecast = this.predictor.predict(this.forecastHorizonMs, at);

      const decision = this.scaler.decide({
        state: this.state,
        observedLoad,
        forecast,
        policy: this.policy,
        now: at,
      });

      if (decision.action !== 'hold') {
        await this.provider.setInstances(decision.targetInstances);
        this.state = this.scaler.applyDecision(this.state, decision, at);
      }

      // SLA is judged against the capacity that was in place *during* the
      // tick, not the capacity the decision just requested — new instances
      // are not serving traffic yet.
      const capacity = currentInstances * this.policy.capacityPerInstance;
      const slaBreach = observedLoad > capacity;
      if (slaBreach) this.sla.breached += 1;
      else this.sla.satisfied += 1;
      const total = this.sla.satisfied + this.sla.breached;
      this.sla.attainment = total > 0 ? this.sla.satisfied / total : null;

      this.instanceTicks += currentInstances;

      const result: OptimizerTickResult = {
        decision,
        state: this.state,
        slaBreach,
        instanceTicks: this.instanceTicks,
      };
      this.onTick?.(result);
      return result;
    } catch (error) {
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Do not hold the process open purely for the scaling loop.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  slaSnapshot(): SlaSnapshot {
    return { ...this.sla };
  }

  /** Instance-ticks so far — multiply by instance cost per tick for spend. */
  costUnits(): number {
    return this.instanceTicks;
  }

  currentState(): ScalerState {
    return { ...this.state };
  }
}
