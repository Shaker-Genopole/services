// Integration: gateway API on a real MongoDB, then the prover job reads what the
// gateway wrote (sealed deployment, pseudonymised devices, time-series telemetry).
import type { AddressInfo } from 'node:net';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Prover } from '@zk-sla/circuits';
import { CollectionName } from '@zk-sla/shared-configs';
import { ensureSchema } from '@zk-sla/shared-connections';
import type { Agreement, ProveSlaJob, TelemetryDocument } from '@zk-sla/shared-entities';
import { createLogger, pseudonymize } from '@zk-sla/shared-utils';
import { runSlaJob, type Store } from '../../prover-worker/src/jobs.js';
import { createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { Tokens } from '../src/http.js';

const cfg = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  SERVICE_NAME: 'api-gateway',
  MONGODB_URI: '',
  DATABASE_NAME: 'zk_sla_test',
  RABBITMQ_URL: '',
  BIND: '127.0.0.1',
  PORT: 0,
  CORS_ORIGINS: [],
  SEAL_KEY: 'd'.repeat(64),
  JWT_SECRET: 'x'.repeat(40),
  JWT_TTL: '1h',
  PSEUDONYM_KEY: 'test-pseudonym-key',
} as unknown as Config;

let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let url = '';
let server: { close: () => void };
const published: Array<{ queue: string; payload: unknown }> = [];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongo.getUri());
  db = client.db(cfg.DATABASE_NAME);
  await ensureSchema(db);
  const app = createApp({
    db,
    cfg,
    logger: createLogger('test', 'silent'),
    tokens: new Tokens(cfg.JWT_SECRET, cfg.JWT_TTL),
    broker: { publish: (queue, payload) => published.push({ queue, payload }) > 0 },
    ready: () => true,
  });
  const s = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
  url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  server = s;
}, 300_000);

afterAll(async () => {
  server?.close();
  await client?.close();
  await mongo?.stop();
  await Prover.shutdown();
});

async function api<T = any>(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

const TERMS = {
  maxLatencyMs: 2000,
  latencyQuorumBp: 9500,
  minAvailabilityBp: 9500,
  maxIntervalSec: 300,
  periodMs: 120_000,
  totalPeriods: 5,
  graceMs: 60_000,
  rewardPerPeriod: 1000,
  penaltyPerPeriod: 3000,
};
const DEVICES = [
  { deviceId: 'ecg-icu-bed-03', kind: 'ecg', expectedIntervalSec: 2, edgeNodeId: 'edge-icu' },
  { deviceId: 'cgm-ward-b-07', kind: 'cgm', expectedIntervalSec: 60, edgeNodeId: 'edge-ward' },
];

describe('SLA flow through the gateway', () => {
  let consumer: string;
  let provider: { token: string; id: string };
  let agreementId: string;

  test('accounts, auth and role checks', async () => {
    const c = await api('POST', '/api/auth/signup', {
      email: 'ops@hospital.test',
      password: 'pw-12345678',
      role: 'consumer',
      organisation: 'Hospital',
    });
    const p = await api('POST', '/api/auth/signup', {
      email: 'noc@edge.test',
      password: 'pw-12345678',
      role: 'provider',
      organisation: 'Edge Co',
    });
    expect(c.status).toBe(201);
    consumer = c.body.token;
    provider = { token: p.body.token, id: p.body.account._id };
    expect(c.body.account.passwordHash).toBeUndefined();
    expect(
      (await api('POST', '/api/auth/login', { email: 'ops@hospital.test', password: 'wrong-password' }))
        .status,
    ).toBe(401);
    expect((await api('GET', '/api/agreements')).status).toBe(401);
    const asProvider = await api(
      'POST',
      '/api/agreements',
      { title: 'x', providerId: provider.id, terms: TERMS },
      provider.token,
    );
    expect(asProvider.status).toBe(403);
  });

  test('consumer proposes, provider commits to a hidden deployment and activates', async () => {
    const created = await api(
      'POST',
      '/api/agreements',
      { title: 'ICU monitoring', providerId: provider.id, terms: TERMS },
      consumer,
    );
    expect(created.status).toBe(201);
    agreementId = created.body._id;

    expect((await api('POST', `/api/agreements/${agreementId}/activate`, {}, provider.token)).status).toBe(
      409,
    );
    const dep = await api(
      'POST',
      `/api/agreements/${agreementId}/deployment`,
      { locations: ['building-2/icu/bed-03'], sensorConfig: { ecgHz: 125 }, devices: DEVICES },
      provider.token,
    );
    expect(dep.status).toBe(200);
    expect(dep.body.deploymentCommitment).toMatch(/^\d+$/);
    expect(dep.body.devices[0].deviceRef).toBe(pseudonymize('ecg-icu-bed-03', cfg.PSEUDONYM_KEY));

    const stored = await db.collection(CollectionName.DEPLOYMENTS).findOne({ _id: agreementId as never });
    expect(JSON.stringify(stored)).not.toContain('ecg-icu-bed-03');
    expect(JSON.stringify(stored)).not.toContain('building-2');

    const startMs = Date.now() - 3 * TERMS.periodMs;
    const act = await api('POST', `/api/agreements/${agreementId}/activate`, { startMs }, provider.token);
    expect(act.status).toBe(200);
    expect(act.body.status).toBe('active');
  });

  test('manual prove request is queued once and rejected for unfinished periods', async () => {
    const ok = await api('POST', `/api/agreements/${agreementId}/periods/0/prove`, {}, consumer);
    expect(ok.status).toBe(202);
    expect(published.at(-1)).toMatchObject({ queue: 'prove.sla', payload: { agreementId, period: 0 } });
    expect((await api('POST', `/api/agreements/${agreementId}/periods/4/prove`, {}, consumer)).status).toBe(
      409,
    );
  });

  test('prover worker proves the period from what the gateway and ingest stored', async () => {
    const a = (await db.collection<Agreement>(CollectionName.AGREEMENTS).findOne({ _id: agreementId }))!;
    const from = a.startMs!;
    const docs: TelemetryDocument[] = [];
    for (const d of DEVICES) {
      const ref = pseudonymize(d.deviceId, cfg.PSEUDONYM_KEY);
      for (let t = 0; t < TERMS.periodMs / 1000; t += d.expectedIntervalSec) {
        docs.push({
          ts: new Date(from + t * 1000 + 250),
          meta: { agreementId, deviceRef: ref, kind: d.kind as 'ecg', edgeNodeId: d.edgeNodeId },
          value: 0,
          latencyMs: 300 + (t % 9) * 70,
        });
      }
    }
    await db.collection<TelemetryDocument>(CollectionName.TELEMETRY).insertMany(docs);

    const store: Store = {
      agreement: (id) => db.collection<Agreement>(CollectionName.AGREEMENTS).findOne({ _id: id }),
      sealedDeployment: async (id) =>
        (
          await db
            .collection<{ _id: string; sealed: string }>(CollectionName.DEPLOYMENTS)
            .findOne({ _id: id })
        )?.sealed ?? null,
      samples: async (id, f, t) =>
        (
          await db
            .collection<TelemetryDocument>(CollectionName.TELEMETRY)
            .find({ 'meta.agreementId': id, ts: { $gte: new Date(f), $lt: new Date(t) } })
            .toArray()
        ).map((d) => ({ deviceRef: d.meta.deviceRef, ts: d.ts.getTime(), latencyMs: d.latencyMs })),
      request: async () => null,
      offer: async () => null,
      markProving: async () => undefined,
    };
    const job = published.at(-1)!.payload as ProveSlaJob;
    const result = await runSlaJob(
      {
        workerId: 'it',
        prover: new Prover(),
        store,
        sealKey: cfg.SEAL_KEY,
        chain: null,
        logger: createLogger('it', 'silent'),
      },
      job,
    );
    expect(result.status).toBe('proven');
    expect(result.publicSignals![1]).toBe(a.tag);
    expect(result.publicSignals![7]).toBe(a.deploymentCommitment);
  });

  test('KPIs and telemetry summary are scoped to the caller', async () => {
    const kpis = await api('GET', '/api/kpis', undefined, consumer);
    expect(kpis.status).toBe(200);
    expect(kpis.body).toHaveProperty('slaComplianceRate');
    const summary = await api(
      'GET',
      `/api/telemetry/summary?agreementId=${agreementId}&from=0`,
      undefined,
      consumer,
    );
    expect(summary.body.samples).toBeGreaterThan(60);
    const stranger = await api('POST', '/api/auth/signup', {
      email: 'x@y.test',
      password: 'pw-12345678',
      role: 'consumer',
      organisation: 'Other',
    });
    expect((await api('GET', `/api/agreements/${agreementId}`, undefined, stranger.body.token)).status).toBe(
      403,
    );
  });
});

describe('negotiation', () => {
  test('offers expose only the commitment', async () => {
    const p = await api('POST', '/api/auth/login', { email: 'noc@edge.test', password: 'pw-12345678' });
    const offer = await api(
      'POST',
      '/api/negotiation/offers',
      { label: 'EN03', storageGb: 1200, latencyMs: 18, costMicroUsd: 950_000, cpuMillicores: 8000 },
      p.body.token,
    );
    expect(offer.status).toBe(201);
    expect(offer.body.sealed).toBeUndefined();
    expect(JSON.stringify(offer.body)).not.toContain('950000');
  });
});
