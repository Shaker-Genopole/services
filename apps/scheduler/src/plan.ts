import type { Agreement } from '@zk-sla/shared-entities';

export interface PeriodPlan {
  /** Ended periods that still need a proof. */
  due: number[];
  /** Ended periods whose grace window expired without a proof. */
  expired: number[];
  /** True once every period has ended. */
  finished: boolean;
}

/**
 * Works out which periods of an active agreement are due for proving and which
 * have lapsed, given the periods that already have a terminal or in-flight state.
 */
export function planPeriods(a: Agreement, settledOrInFlight: ReadonlySet<number>, now: number): PeriodPlan {
  const due: number[] = [];
  const expired: number[] = [];
  if (a.status !== 'active' || a.startMs === undefined) return { due, expired, finished: false };
  const { periodMs, totalPeriods, graceMs } = a.terms;
  const ended = Math.min(totalPeriods, Math.max(0, Math.floor((now - a.startMs) / periodMs)));
  for (let p = 0; p < ended; p++) {
    if (settledOrInFlight.has(p)) continue;
    const end = a.startMs + (p + 1) * periodMs;
    if (now > end + graceMs) expired.push(p);
    else due.push(p);
  }
  return { due, expired, finished: ended === totalPeriods };
}
