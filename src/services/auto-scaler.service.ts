/**
 * Auto-scaling decision engine (issue #862).
 *
 * Turns a load forecast plus observed metrics into a concrete "run N
 * instances" decision, subject to cooldowns, SLA headroom and cost limits.
 *
 * The engine is pure — it takes state in and returns a decision out, touching
 * no cloud API. Provider adapters apply the decision. That split matters
 * because the decision logic is where the expensive mistakes live (flapping,
 * runaway scale-up, scaling down through a spike), and it is exactly the part
 * that can be tested exhaustively without an AWS account.
 */

import type { Forecast } from './load-predictor.service';

export interface ScalingPolicy {
  minInstances: number;
  maxInstances: number;
  /** Load units one instance can serve while meeting SLA. */
  capacityPerInstance: number;
  /**
   * Fraction of capacity to aim for, e.g. 0.7 to run at 70%.
   * The remaining headroom absorbs error between forecast and reality.
   */
  targetUtilisation: number;
  /** Seconds after a scale-up before another scale-up is allowed. */
  scaleUpCooldownSeconds: number;
  /**
   * Seconds after any change before a scale-down is allowed.
   *
   * Longer than the up cooldown on purpose: scaling down too eagerly is how
   * you end up flapping, and being briefly over-provisioned is far cheaper
   * than dropping traffic.
   */
  scaleDownCooldownSeconds: number;
  /** Never remove more than this many instances at once. */
  maxScaleDownStep: number;
  /** Minimum forecast confidence before predictive scale-up is allowed. */
  minForecastConfidence: number;
  /** Optional ceiling on simultaneous instances for cost control. */
  costCeilingInstances?: number;
}

export const DEFAULT_POLICY: ScalingPolicy = {
  minInstances: 2,
  maxInstances: 20,
  capacityPerInstance: 100,
  targetUtilisation: 0.7,
  scaleUpCooldownSeconds: 60,
  scaleDownCooldownSeconds: 300,
  maxScaleDownStep: 1,
  minForecastConfidence: 0.4,
};

export interface ScalerState {
  currentInstances: number;
  /** Epoch ms of the last scaling action, or null if never. */
  lastScaledAt: number | null;
  lastAction: ScalingAction | null;
}

export type ScalingAction = 'scale-up' | 'scale-down' | 'hold';

export interface ScalingDecision {
  action: ScalingAction;
  /** Instances to run after applying this decision. */
  targetInstances: number;
  currentInstances: number;
  /** Plain-language justification, surfaced in logs and the dashboard. */
  reason: string;
  /** Load the decision was based on. */
  effectiveLoad: number;
  /** True when the forecast (not observed load) drove the decision. */
  predictive: boolean;
  /** Set when a limit clamped the target. */
  constrainedBy?: 'min' | 'max' | 'cost-ceiling' | 'scale-down-step';
}

export interface DecisionInput {
  state: ScalerState;
  /** Current observed load, same unit as `capacityPerInstance`. */
  observedLoad: number;
  forecast?: Forecast;
  policy?: ScalingPolicy;
  now?: number;
}

/** Instances needed to serve `load` at the target utilisation. */
export function instancesFor(load: number, policy: ScalingPolicy): number {
  const perInstance = policy.capacityPerInstance * policy.targetUtilisation;
  if (perInstance <= 0) return policy.minInstances;
  return Math.ceil(load / perInstance);
}

export class AutoScalerService {
  /**
   * Decide what to do next.
   *
   * Scale-up uses `max(observed, forecast)` when the forecast is trustworthy,
   * so a predicted spike provisions early — that is the whole point of
   * predictive scaling. Scale-down uses observed load *only*: acting on a
   * forecast of quieter traffic risks removing capacity that is still in use,
   * and the downside is asymmetric.
   */
  decide({
    state,
    observedLoad,
    forecast,
    policy = DEFAULT_POLICY,
    now = Date.now(),
  }: DecisionInput): ScalingDecision {
    const current = state.currentInstances;
    const safeObserved = Number.isFinite(observedLoad) && observedLoad > 0 ? observedLoad : 0;

    const forecastTrusted =
      !!forecast &&
      Number.isFinite(forecast.value) &&
      forecast.confidence >= policy.minForecastConfidence;

    const predictiveLoad = forecastTrusted ? forecast!.value : 0;
    const upLoad = Math.max(safeObserved, predictiveLoad);
    const predictive = forecastTrusted && predictiveLoad > safeObserved;

    const desiredUp = instancesFor(upLoad, policy);
    const desiredDown = instancesFor(safeObserved, policy);

    // ── Scale up ────────────────────────────────────────────────────────────
    if (desiredUp > current) {
      const cooling = this.inCooldown(
        state,
        now,
        policy.scaleUpCooldownSeconds,
        'scale-up',
      );
      if (cooling) {
        return this.hold(
          current,
          upLoad,
          predictive,
          `Scale-up needed (${desiredUp} instances) but cooling down since last action.`,
        );
      }

      const { target, constrainedBy } = this.clamp(desiredUp, policy);
      return {
        action: target > current ? 'scale-up' : 'hold',
        targetInstances: Math.max(target, current),
        currentInstances: current,
        effectiveLoad: upLoad,
        predictive,
        constrainedBy,
        reason: predictive
          ? `Forecast ${upLoad.toFixed(1)} (confidence ${(forecast!.confidence * 100).toFixed(0)}%) needs ${desiredUp} instances.`
          : `Observed load ${upLoad.toFixed(1)} needs ${desiredUp} instances.`,
      };
    }

    // ── Scale down ──────────────────────────────────────────────────────────
    if (desiredDown < current) {
      // Never scale down while the forecast says load is coming.
      if (forecastTrusted && instancesFor(forecast!.value, policy) >= current) {
        return this.hold(
          current,
          safeObserved,
          false,
          `Observed load allows ${desiredDown} instances but the forecast still requires ${current}.`,
        );
      }

      const cooling = this.inCooldown(
        state,
        now,
        policy.scaleDownCooldownSeconds,
        'scale-down',
      );
      if (cooling) {
        return this.hold(
          current,
          safeObserved,
          false,
          `Scale-down possible (${desiredDown} instances) but within the scale-down cooldown.`,
        );
      }

      // Step down gradually — a single large cut is how a scaler turns a lull
      // into an outage when traffic returns.
      const stepped = Math.max(desiredDown, current - policy.maxScaleDownStep);
      const { target, constrainedBy } = this.clamp(stepped, policy);
      const limited = stepped > desiredDown ? 'scale-down-step' : constrainedBy;

      return {
        action: target < current ? 'scale-down' : 'hold',
        targetInstances: Math.min(target, current),
        currentInstances: current,
        effectiveLoad: safeObserved,
        predictive: false,
        constrainedBy: limited,
        reason: `Observed load ${safeObserved.toFixed(1)} needs only ${desiredDown} instances.`,
      };
    }

    return this.hold(
      current,
      safeObserved,
      false,
      `Load ${safeObserved.toFixed(1)} is served by the current ${current} instances.`,
    );
  }

  private hold(
    current: number,
    load: number,
    predictive: boolean,
    reason: string,
  ): ScalingDecision {
    return {
      action: 'hold',
      targetInstances: current,
      currentInstances: current,
      effectiveLoad: load,
      predictive,
      reason,
    };
  }

  /**
   * Whether a cooldown blocks this action.
   *
   * A scale-up cooldown only counts against a previous scale-up: after a
   * scale-down, load rising again must be actionable immediately, or the
   * scaler spends the cooldown window under-provisioned.
   */
  private inCooldown(
    state: ScalerState,
    now: number,
    cooldownSeconds: number,
    action: ScalingAction,
  ): boolean {
    if (state.lastScaledAt === null) return false;

    const elapsed = (now - state.lastScaledAt) / 1000;
    if (elapsed >= cooldownSeconds) return false;

    if (action === 'scale-up') return state.lastAction === 'scale-up';
    // Any recent change blocks a scale-down.
    return true;
  }

  private clamp(
    desired: number,
    policy: ScalingPolicy,
  ): { target: number; constrainedBy?: ScalingDecision['constrainedBy'] } {
    if (desired < policy.minInstances) {
      return { target: policy.minInstances, constrainedBy: 'min' };
    }

    const ceiling = policy.costCeilingInstances;
    if (typeof ceiling === 'number' && desired > ceiling) {
      // Cost ceiling binds before the hard max so the reason names the real
      // constraint — an operator debugging "why am I throttled at 8?" needs to
      // see "cost-ceiling", not "max".
      return { target: Math.min(ceiling, policy.maxInstances), constrainedBy: 'cost-ceiling' };
    }

    if (desired > policy.maxInstances) {
      return { target: policy.maxInstances, constrainedBy: 'max' };
    }

    return { target: desired };
  }

  /** Apply a decision to state — the caller persists the result. */
  applyDecision(
    state: ScalerState,
    decision: ScalingDecision,
    now: number = Date.now(),
  ): ScalerState {
    if (decision.action === 'hold') return state;

    return {
      currentInstances: decision.targetInstances,
      lastScaledAt: now,
      lastAction: decision.action,
    };
  }
}
