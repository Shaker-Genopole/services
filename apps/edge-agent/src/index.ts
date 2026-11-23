import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { loadDatasets } from '@zk-sla/datasets';
import { loadConfig } from '@zk-sla/shared-configs';
import type { TelemetryBatch, TelemetryReading } from '@zk-sla/shared-entities';
import { createLogger, onShutdown, sleep } from '@zk-sla/shared-utils';
import { EcgBeatClassifier, samplingIntervalSec } from './inference.js';
import { SimulatedDevice, type DeviceSpec } from './sensors.js';

const deviceSpecs = z.array(
  z.object({
    deviceId: z.string().min(1),
    kind: z.enum(['ecg', 'cgm', 'temperature', 'spo2', 'blood_pressure', 'camera']),
    intervalSec: z.number().positive(),
  }),
);

const cfg = loadConfig({
  SERVICE_NAME: z.string().default('edge-agent'),
  INGEST_URL: z.string().url().default('http://localhost:8081'),
  EDGE_NODE_ID: z.string().min(1),
  EDGE_API_KEY: z.string().min(8),
  PSEUDONYM_KEY: z.string().min(16),
  AGREEMENT_ID: z.string().min(1).optional(),
  /** Alternative to AGREEMENT_ID: file written by the demo seed job; the agent waits for it. */
  AGREEMENT_ID_FILE: z.string().optional(),
  DEVICES: z.string().transform((s, ctx) => {
    const parsed = deviceSpecs.safeParse(JSON.parse(s));
    if (!parsed.success) {
      ctx.addIssue({
        code: 'custom',
        message: 'DEVICES must be a JSON array of {deviceId, kind, intervalSec}',
      });
      return z.NEVER;
    }
    return parsed.data as DeviceSpec[];
  }),
  DATASET_DIR: z.string().optional(),
  BATCH_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  LOW_BATTERY_PERCENT: z.coerce.number().min(0).max(100).default(20),
  /** Artificial uplink delay to emulate constrained links (ms). */
  SIMULATED_UPLINK_MS: z.coerce.number().int().min(0).default(0),
  MAX_BUFFER: z.coerce.number().int().positive().default(50_000),
});
const logger = createLogger(`${cfg.SERVICE_NAME}:${cfg.EDGE_NODE_ID}`, cfg.LOG_LEVEL);

const data = loadDatasets(cfg.DATASET_DIR);
const split = Math.floor(data.heartbeats.records.length * 0.8);
const classifier = EcgBeatClassifier.train(data.heartbeats.records.slice(0, split));
logger.info(
  {
    sources: {
      vitals: data.vitals.source,
      heartbeats: data.heartbeats.source,
      edgeTasks: data.edgeTasks.source,
    },
    ecgModelBytes: classifier.sizeBytes,
    ecgHoldoutAccuracy: Math.round(classifier.accuracy(data.heartbeats.records.slice(split)) * 1000) / 1000,
  },
  'edge models ready',
);

async function resolveAgreementId(): Promise<string> {
  if (cfg.AGREEMENT_ID) return cfg.AGREEMENT_ID;
  if (!cfg.AGREEMENT_ID_FILE) throw new Error('set AGREEMENT_ID or AGREEMENT_ID_FILE');
  while (!existsSync(cfg.AGREEMENT_ID_FILE)) {
    logger.info({ file: cfg.AGREEMENT_ID_FILE }, 'waiting for agreement id');
    await sleep(3_000);
  }
  return readFileSync(cfg.AGREEMENT_ID_FILE, 'utf8').trim();
}
const agreementId = await resolveAgreementId();

const devices = cfg.DEVICES.map(
  (spec, i) => new SimulatedDevice(spec, data, classifier, cfg.PSEUDONYM_KEY, i + 1),
);
let buffer: TelemetryReading[] = [];
let running = true;

async function runDevice(device: SimulatedDevice) {
  // Stagger start-up so devices do not sample in lockstep.
  await sleep(Math.random() * device.spec.intervalSec * 1000);
  while (running) {
    buffer.push(device.sample(agreementId, Date.now()));
    if (buffer.length > cfg.MAX_BUFFER) buffer.splice(0, buffer.length - cfg.MAX_BUFFER);
    await sleep(samplingIntervalSec(device.spec.intervalSec, device.battery, cfg.LOW_BATTERY_PERCENT) * 1000);
  }
}

/** Store-and-forward uplink: readings stay buffered until the cloud acknowledges them. */
async function flushLoop() {
  while (running) {
    await sleep(cfg.BATCH_INTERVAL_MS);
    if (!buffer.length) continue;
    const readings = buffer;
    buffer = [];
    const batch: TelemetryBatch = { edgeNodeId: cfg.EDGE_NODE_ID, sentAt: Date.now(), readings };
    try {
      if (cfg.SIMULATED_UPLINK_MS) await sleep(cfg.SIMULATED_UPLINK_MS);
      const res = await fetch(`${cfg.INGEST_URL}/ingest/batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.EDGE_API_KEY}` },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status >= 500 || res.status === 429) throw new Error(`ingest returned ${res.status}`);
      if (!res.ok) logger.error({ status: res.status, body: await res.text() }, 'batch rejected');
      else logger.debug({ readings: readings.length }, 'batch delivered');
    } catch (err) {
      logger.warn({ err: String(err), buffered: readings.length }, 'uplink failed, retrying later');
      buffer = readings.concat(buffer);
    }
  }
}

logger.info(
  { agreementId, devices: devices.map((d) => ({ kind: d.spec.kind, deviceRef: d.deviceRef })) },
  'edge agent started',
);
void flushLoop();
devices.forEach((d) => void runDevice(d));

onShutdown(logger, async () => {
  running = false;
});
