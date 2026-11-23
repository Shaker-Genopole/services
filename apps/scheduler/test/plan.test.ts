import { describe, expect, test } from 'vitest';
import type { Agreement } from '@zk-sla/shared-entities';
import { planPeriods } from '../src/plan.js';

const HOUR = 3_600_000;
const agreement = (over: Partial<Agreement> = {}): Agreement => ({
  _id: 'a1',
  title: 'ICU ECG monitoring',
  consumerId: 'c',
  providerId: 'p',
  status: 'active',
  startMs: 0,
  tag: '1',
  terms: {
    maxLatencyMs: 2000,
    latencyQuorumBp: 9500,
    minAvailabilityBp: 9900,
    maxIntervalSec: 300,
    periodMs: HOUR,
    totalPeriods: 4,
    graceMs: 10 * 60_000,
    rewardPerPeriod: 1,
    penaltyPerPeriod: 3,
  },
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

describe('planPeriods', () => {
  test('nothing is due before the first period ends', () => {
    expect(planPeriods(agreement(), new Set(), HOUR - 1)).toEqual({ due: [], expired: [], finished: false });
  });

  test('ended periods are due within the grace window and expired after it', () => {
    const plan = planPeriods(agreement(), new Set(), 2 * HOUR + 5 * 60_000);
    expect(plan).toEqual({ due: [1], expired: [0], finished: false });
  });

  test('skips settled periods and stops at totalPeriods', () => {
    const plan = planPeriods(agreement(), new Set([0, 1, 2]), 100 * HOUR);
    expect(plan).toEqual({ due: [], expired: [3], finished: true });
  });

  test('ignores inactive agreements', () => {
    expect(planPeriods(agreement({ status: 'proposed' }), new Set(), 10 * HOUR).due).toEqual([]);
  });
});
