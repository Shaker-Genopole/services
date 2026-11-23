import { afterAll, describe, expect, test } from 'vitest';
import { CIRCUITS, Prover, deploymentCommitment, deploymentSecrets, offerCommitment } from '@zk-sla/circuits';
import type { Agreement, DeploymentDescription, OfferRecord, RequestRecord } from '@zk-sla/shared-entities';
import { createLogger, pseudonymize, seal } from '@zk-sla/shared-utils';
import { runNegotiationJob, runSlaJob, type Chain, type JobContext, type Store } from '../src/jobs.js';
import { summarisePeriod, type Sample } from '../src/telemetry.js';

const SEAL_KEY = 'c'.repeat(64);
const PEPPER = 'pseudonym-pepper';
const START = 1_700_000_000_000;
const PERIOD_MS = 10 * 60_000;

const devices = [
  { deviceId: 'ecg-ward-a-01', kind: 'ecg' as const, expectedIntervalSec: 2 },
  { deviceId: 'cgm-ward-b-07', kind: 'cgm' as const, expectedIntervalSec: 60 },
];
const description: DeploymentDescription = {
  deviceIds: devices.map((d) => d.deviceId),
  locations: ['building-2/floor-3/ward-a'],
  sensorConfig: { ecgHz: 125, gateway: 'edge-gw-02' },
  devices: devices.map((d) => ({
    deviceRef: pseudonymize(d.deviceId, PEPPER),
    kind: d.kind,
    expectedIntervalSec: d.expectedIntervalSec,
  })),
  salt: '123456789',
};
const commitment = deploymentCommitment(
  deploymentSecrets({ ...description, salt: BigInt(description.salt) }),
).toString();

const agreement: Agreement = {
  _id: 'sla-icu-1',
  title: 'ICU ECG + CGM',
  consumerId: 'hospital',
  providerId: 'edge-provider',
  status: 'active',
  startMs: START,
  tag: '987654321',
  deploymentCommitment: commitment,
  terms: {
    maxLatencyMs: 2000,
    latencyQuorumBp: 9500,
    minAvailabilityBp: 9900,
    maxIntervalSec: 300,
    periodMs: PERIOD_MS,
    totalPeriods: 6,
    graceMs: 60_000,
    rewardPerPeriod: 1_000,
    penaltyPerPeriod: 3_000,
  },
  createdAt: new Date(START),
  updatedAt: new Date(START),
};

/** One period of telemetry; `latencyMs` can be degraded to model an SLA breach. */
function telemetry(latency: (i: number) => number, dropEvery = 0): Sample[] {
  const out: Sample[] = [];
  for (const d of description.devices) {
    const n = PERIOD_MS / 1000 / d.expectedIntervalSec;
    for (let i = 0; i < n; i++) {
      if (dropEvery && i % dropEvery === 0) continue;
      out.push({
        deviceRef: d.deviceRef,
        ts: START + i * d.expectedIntervalSec * 1000 + 500,
        latencyMs: latency(i),
      });
    }
  }
  return out;
}

function context(samples: Sample[], chain: Chain | null = null, extra: Partial<Store> = {}): JobContext {
  const store: Store = {
    agreement: async () => agreement,
    sealedDeployment: async () => seal(description, SEAL_KEY),
    samples: async (_id, from, to) => samples.filter((s) => s.ts >= from && s.ts < to),
    request: async () => null,
    offer: async () => null,
    markProving: async () => undefined,
    ...extra,
  };
  return {
    workerId: 'test',
    prover: new Prover(),
    store,
    sealKey: SEAL_KEY,
    chain,
    logger: createLogger('test', 'silent'),
  };
}

const job = { jobId: 'job-1', agreementId: agreement._id, period: 0, enqueuedAt: START };

afterAll(() => Prover.shutdown());

describe('summarisePeriod', () => {
  test('counts expected samples per device and exposes silent devices as full-period gaps', () => {
    const samples = telemetry(() => 300).filter((s) => s.deviceRef === description.devices[0]!.deviceRef);
    const t = summarisePeriod(samples, description, START, START + PERIOD_MS);
    expect(t.expected).toBe(300 + 10);
    expect(t.received).toBe(300);
    expect(Math.max(...t.intervalsSec)).toBe(600);
  });
});

describe('runSlaJob', () => {
  test('compliant period produces a verifying Groth16 proof bound to the agreement', async () => {
    const ctx = context(telemetry((i) => 250 + (i % 7) * 120));
    const result = await runSlaJob(ctx, job);
    expect(result.status).toBe('proven');
    expect(result.proofSizeBytes).toBe(192);
    expect(result.publicSignals![1]).toBe(agreement.tag);
    expect(result.publicSignals![7]).toBe(commitment);
    const vk = ctx.prover.verificationKey(CIRCUITS.SLA_COMPLIANCE);
    expect(vk).toBeTruthy();
  });

  test('latency breach is reported as non-compliant without a proof', async () => {
    const result = await runSlaJob(context(telemetry((i) => (i % 5 === 0 ? 2600 : 400))), job);
    expect(result.status).toBe('non_compliant');
    expect(result.verdict!.checks.latencyQuorum).toBe(false);
    expect(result.proofHex).toBeUndefined();
  });

  test('availability breach (dropped samples) is non-compliant', async () => {
    const result = await runSlaJob(context(telemetry(() => 300, 20)), job);
    expect(result.status).toBe('non_compliant');
    expect(result.verdict!.checks.availability).toBe(false);
  });

  test('too little telemetry is reported, not proven', async () => {
    const result = await runSlaJob(context([]), job);
    expect(result.status).toBe('insufficient_data');
  });

  test('submits on chain when a chain client is configured', async () => {
    const submitted: unknown[] = [];
    const chain: Chain = {
      submitSlaProof: async (p) => {
        submitted.push(p);
        return { digest: 'D1g3st', success: true, gasUsedMist: 2_345_000 };
      },
      proveOffer: async () => ({ digest: '', success: true, gasUsedMist: 0 }),
    };
    const ctx = context(
      telemetry(() => 400),
      chain,
      {
        agreement: async () => ({ ...agreement, onChainId: `0x${'1'.repeat(64)}` }),
      },
    );
    const result = await runSlaJob(ctx, job);
    expect(result).toMatchObject({ status: 'submitted', txDigest: 'D1g3st', gasUsedMist: 2_345_000 });
    expect(submitted[0]).toMatchObject({ agreementId: `0x${'1'.repeat(64)}`, period: 0 });
  });
});

describe('runNegotiationJob', () => {
  const figures = { storageGb: 1200, latencyMs: 15, costMicroUsd: 900_000, cpuMillicores: 8000 };
  const offer: OfferRecord = {
    _id: 'offer-1',
    providerId: 'edge-provider',
    label: 'EN03 eu-west',
    commitment: offerCommitment({ ...figures, salt: 42n }).toString(),
    sealed: seal({ ...figures, salt: '42' }, SEAL_KEY),
    active: true,
    createdAt: new Date(),
  };
  const request = (minStorageGb: number): RequestRecord => ({
    _id: 'req-1',
    consumerId: 'hospital',
    constraints: { minStorageGb, maxLatencyMs: 50, maxCostMicroUsd: 1_000_000, minCpuMillicores: 4000 },
    tag: '5555',
    status: 'open',
    candidates: [],
    createdAt: new Date(),
  });
  const negJob = { jobId: 'neg-1', requestId: 'req-1', offerId: 'offer-1', enqueuedAt: Date.now() };

  test('qualifies a hidden offer that meets the constraints', async () => {
    const ctx = context([], null, { request: async () => request(500), offer: async () => offer });
    const result = await runNegotiationJob(ctx, negJob);
    expect(result.status).toBe('proven');
    expect(result.publicSignals![5]).toBe(offer.commitment);
  });

  test('does not qualify an offer below the storage floor', async () => {
    const ctx = context([], null, { request: async () => request(2000), offer: async () => offer });
    expect((await runNegotiationJob(ctx, negJob)).status).toBe('non_compliant');
  });
});
