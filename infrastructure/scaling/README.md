# Scaling configuration (issue #862)

Policy definitions for the predictive auto-scaler. The decision engine lives in
`src/services/auto-scaler.service.ts`; this directory holds the tunables an
operator changes without touching code.

## What is and is not implemented

| Piece | Status |
|---|---|
| Load forecasting (`LoadPredictorService`) | Implemented, unit-tested |
| Scaling decisions (`AutoScalerService`) | Implemented, unit-tested |
| Optimiser loop (`ScalingOptimizerWorker`) | Implemented, unit-tested against a fake provider |
| SLA attainment + cost accounting | Implemented, unit-tested |
| **Cloud provider adapters** | **Not implemented — see below** |

`ScalingProvider` (in `src/workers/scaling-optimizer.worker.ts`) is the seam a
platform plugs into. It needs three operations: read the current instance
count, read current load, set the instance count.

No concrete adapter ships in this PR. Writing an ECS, Kubernetes HPA or
Cloud Run client that has never been run against a real control plane would be
guesswork, and a scaling bug that only appears in production is an expensive
way to discover an API mismatch. The adapter should be written against
whichever platform this service actually deploys to, with integration tests
that can talk to it.

## Policy tunables

`ScalingPolicy` fields, and why each exists:

| Field | Purpose |
|---|---|
| `minInstances` / `maxInstances` | Hard floor and ceiling. |
| `capacityPerInstance` | Load units one instance serves while meeting SLA. Measure it; do not guess. |
| `targetUtilisation` | Fraction of capacity to aim for. The remainder is headroom that absorbs forecast error. |
| `scaleUpCooldownSeconds` | Blocks a second scale-up while the first is still booting. |
| `scaleDownCooldownSeconds` | Longer than the up cooldown on purpose — brief over-provisioning is far cheaper than dropping traffic. |
| `maxScaleDownStep` | Caps how much capacity a single decision can remove. |
| `minForecastConfidence` | Below this, the forecast is ignored and scaling is purely reactive. |
| `costCeilingInstances` | Optional spend cap that binds before `maxInstances`, so the reported constraint names the real limit. |

## Example profiles

`policies.example.json` holds three starting points — conservative, balanced
and aggressive. They are illustrative: `capacityPerInstance` in particular must
come from load-testing this service, since it is the number every other
calculation is derived from.

## Tuning notes

- **Start conservative.** An over-eager scaler costs money continuously; an
  under-eager one costs money once, during an incident you will notice.
- **Set the forecast horizon above instance start-up time.** A prediction that
  lands inside the boot window arrives too late to help.
- **Watch `slaSnapshot().attainment` alongside `costUnits()`.** Either alone is
  misleading — perfect attainment at triple the cost is not a win, and neither
  is a cheap month with breaches in it.
