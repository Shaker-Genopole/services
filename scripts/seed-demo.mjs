// Seeds a demo SLA through the public API: a hospital (consumer), an edge-cloud
// provider, a 2-minute-period agreement, its hidden deployment, and activation.
// Writes the agreement ID to OUT_FILE for the edge agents. Idempotent per run.
import { writeFileSync } from 'node:fs';

const API = process.env.API_URL ?? 'http://localhost:8080';
const OUT = process.env.OUT_FILE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body, token) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok)
    throw Object.assign(new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`), {
      status: res.status,
    });
  return json;
}

async function account(email, role, organisation) {
  const password = 'demo-password-123';
  try {
    return await call('POST', '/api/auth/signup', { email, password, role, organisation });
  } catch (err) {
    if (err.status !== 409) throw err;
    return call('POST', '/api/auth/login', { email, password });
  }
}

for (let i = 0; ; i++) {
  try {
    await fetch(`${API}/healthz`);
    break;
  } catch {
    if (i > 60) throw new Error('api-gateway not reachable');
    await sleep(2000);
  }
}

const hospital = await account('ops@hospital.demo', 'consumer', 'Demo University Hospital');
const provider = await account('noc@edgecloud.demo', 'provider', 'Demo Edge-Cloud Operator');

const agreement = await call(
  'POST',
  '/api/agreements',
  {
    title: 'ICU & ward remote monitoring',
    providerId: provider.account._id,
    terms: {
      maxLatencyMs: 2000, // ECG data latency <= 2 s ...
      latencyQuorumBp: 9500, // ... for 95 % of samples
      minAvailabilityBp: 9500,
      maxIntervalSec: 300, // glucose updates every <= 5 min
      periodMs: 120_000,
      totalPeriods: 30,
      graceMs: 60_000,
      rewardPerPeriod: 1_000_000,
      penaltyPerPeriod: 3_000_000,
    },
  },
  hospital.token,
);

const devices = [
  { deviceId: 'ecg-icu-bed-03', kind: 'ecg', expectedIntervalSec: 2, edgeNodeId: 'edge-icu' },
  { deviceId: 'spo2-icu-bed-03', kind: 'spo2', expectedIntervalSec: 5, edgeNodeId: 'edge-icu' },
  { deviceId: 'cam-icu-corridor', kind: 'camera', expectedIntervalSec: 10, edgeNodeId: 'edge-icu' },
  { deviceId: 'cgm-ward-b-07', kind: 'cgm', expectedIntervalSec: 60, edgeNodeId: 'edge-ward' },
  { deviceId: 'temp-ward-b-07', kind: 'temperature', expectedIntervalSec: 30, edgeNodeId: 'edge-ward' },
  { deviceId: 'bp-ward-b-07', kind: 'blood_pressure', expectedIntervalSec: 60, edgeNodeId: 'edge-ward' },
];
const deployment = await call(
  'POST',
  `/api/agreements/${agreement._id}/deployment`,
  {
    locations: ['building-2/floor-1/icu/bed-03', 'building-2/floor-3/ward-b/bed-07'],
    sensorConfig: { ecgHz: 125, cameraFps: 1, gateways: ['edge-icu', 'edge-ward'] },
    devices,
  },
  provider.token,
);
await call('POST', `/api/agreements/${agreement._id}/activate`, {}, provider.token);

const offer = await call(
  'POST',
  '/api/negotiation/offers',
  {
    label: 'edge tier EN03 (eu-west)',
    storageGb: 1200,
    latencyMs: 18,
    costMicroUsd: 950_000,
    cpuMillicores: 8000,
  },
  provider.token,
);
const request = await call(
  'POST',
  '/api/negotiation/requests',
  {
    constraints: { minStorageGb: 500, maxLatencyMs: 50, maxCostMicroUsd: 1_200_000, minCpuMillicores: 4000 },
  },
  hospital.token,
);
await call(
  'POST',
  `/api/negotiation/requests/${request._id}/qualify`,
  { offerId: offer._id },
  provider.token,
);

if (OUT) writeFileSync(OUT, agreement._id);
console.log(
  JSON.stringify(
    {
      agreementId: agreement._id,
      deploymentCommitment: deployment.deploymentCommitment,
      offerCommitment: offer.commitment,
      requestId: request._id,
      logins: {
        consumer: 'ops@hospital.demo',
        provider: 'noc@edgecloud.demo',
        password: 'demo-password-123',
      },
    },
    null,
    2,
  ),
);
