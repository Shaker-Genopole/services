import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { TelemetryAlert, TelemetryDocument } from '@zk-sla/shared-entities';
import { createLogger } from '@zk-sla/shared-utils';
import { createIngestApp } from '../src/app.js';

const NOW = 1_700_000_000_000;
const stored: TelemetryDocument[] = [];
const alerts: TelemetryAlert[] = [];
let url = '';
let close: () => void;

beforeAll(async () => {
  const app = createIngestApp({
    edgeKeys: new Map([['edge-gw-02', 'secret-key-123']]),
    insert: async (docs) => void stored.push(...docs),
    alert: (a) => void alerts.push(a),
    logger: createLogger('test', 'silent'),
    now: () => NOW,
  });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());

const reading = (over: Record<string, unknown> = {}) => ({
  agreementId: 'sla-1',
  deviceRef: 'ab'.repeat(16),
  kind: 'ecg',
  sampledAt: NOW - 640,
  value: 0,
  ...over,
});

const post = (body: unknown, key = 'secret-key-123') =>
  fetch(`${url}/ingest/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });

describe('POST /ingest/batch', () => {
  test('stores readings with sensor-to-cloud latency and forwards anomalies', async () => {
    const res = await post({
      edgeNodeId: 'edge-gw-02',
      sentAt: NOW - 10,
      readings: [
        reading(),
        reading({ anomaly: 'arrhythmia:V', value: 2 }),
        reading({ sampledAt: NOW + 60_000 }),
      ],
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 2, rejected: 1 });
    expect(stored[0]).toMatchObject({ latencyMs: 640, meta: { edgeNodeId: 'edge-gw-02', kind: 'ecg' } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.anomaly).toBe('arrhythmia:V');
  });

  test('rejects unknown edge keys', async () => {
    const res = await post({ edgeNodeId: 'edge-gw-02', sentAt: NOW, readings: [reading()] }, 'wrong-key-000');
    expect(res.status).toBe(401);
  });

  test('rejects raw device identifiers', async () => {
    const res = await post({
      edgeNodeId: 'edge-gw-02',
      sentAt: NOW,
      readings: [reading({ deviceRef: 'ecg-ward-a-01' })],
    });
    expect(res.status).toBe(400);
  });
});
