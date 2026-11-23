import type { PeriodTelemetry } from '@zk-sla/circuits';
import type { DeploymentDescription } from '@zk-sla/shared-entities';

export interface Sample {
  deviceRef: string;
  ts: number;
  latencyMs: number;
}

/**
 * Reduces one period of raw telemetry to the private SLA witness figures:
 *  - latenciesMs: every sample's sensor-to-cloud latency, time ordered
 *  - intervalsSec: per-device update gaps, including the gap from the period
 *    start to the first sample and from the last sample to the period end, so
 *    a device that goes silent is never hidden; silent devices count as one
 *    full-period gap
 *  - expected: samples the deployment should have produced
 *  - received: samples actually received, capped per device at its expectation
 */
export function summarisePeriod(
  samples: Sample[],
  deployment: Pick<DeploymentDescription, 'devices'>,
  windowStart: number,
  windowEnd: number,
): PeriodTelemetry {
  const periodSec = (windowEnd - windowStart) / 1000;
  const inWindow = samples.filter((s) => s.ts >= windowStart && s.ts < windowEnd).sort((a, b) => a.ts - b.ts);
  const byDevice = new Map<string, number[]>();
  for (const s of inWindow) byDevice.set(s.deviceRef, [...(byDevice.get(s.deviceRef) ?? []), s.ts]);

  let expected = 0;
  let received = 0;
  const intervalsSec: number[] = [];
  for (const device of deployment.devices) {
    const ts = byDevice.get(device.deviceRef) ?? [];
    const want = Math.floor(periodSec / device.expectedIntervalSec);
    expected += want;
    received += Math.min(ts.length, want);
    if (!ts.length) {
      intervalsSec.push(Math.ceil(periodSec));
      continue;
    }
    const edges = [windowStart, ...ts, windowEnd];
    for (let i = 1; i < edges.length; i++) intervalsSec.push(Math.ceil((edges[i]! - edges[i - 1]!) / 1000));
  }

  const known = new Set(deployment.devices.map((d) => d.deviceRef));
  return {
    latenciesMs: inWindow.filter((s) => known.has(s.deviceRef)).map((s) => Math.round(s.latencyMs)),
    intervalsSec,
    received,
    expected,
  };
}
