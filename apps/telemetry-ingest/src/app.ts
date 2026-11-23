import express, { type Express } from 'express';
import client from '@prometheus-io/client';
import { z } from 'zod';
import type { TelemetryAlert, TelemetryBatch, TelemetryDocument } from '@zk-sla/shared-entities';
import { safeEqual, type Logger } from '@zk-sla/shared-utils';

const readingSchema = z.object({
  agreementId: z.string().min(1),
  deviceRef: z.string().regex(/^[0-9a-f]{32}$/, 'deviceRef must be a pseudonym, not a raw identifier'),
  kind: z.enum(['ecg', 'cgm', 'temperature', 'spo2', 'blood_pressure', 'camera']),
  sampledAt: z.number().int().positive(),
  value: z.number().finite(),
  anomaly: z.string().max(64).optional(),
  battery: z.number().min(0).max(100).optional(),
});

export const batchSchema = z.object({
  edgeNodeId: z.string().min(1).max(64),
  sentAt: z.number().int().positive(),
  readings: z.array(readingSchema).min(1).max(5_000),
});

export interface IngestDeps {
  /** edgeNodeId -> API key */
  edgeKeys: Map<string, string>;
  insert: (docs: TelemetryDocument[]) => Promise<void>;
  alert: (alert: TelemetryAlert) => void;
  logger: Logger;
  now?: () => number;
  /** Readings sampled further in the future than this are rejected (clock skew guard). */
  maxFutureSkewMs?: number;
}

/** Converts an edge batch to time-series documents, measuring sensor-to-cloud latency at receipt. */
export function toDocuments(batch: TelemetryBatch, receivedAt: number, maxFutureSkewMs: number) {
  const docs: TelemetryDocument[] = [];
  let rejected = 0;
  for (const r of batch.readings) {
    if (r.sampledAt > receivedAt + maxFutureSkewMs) {
      rejected++;
      continue;
    }
    docs.push({
      ts: new Date(r.sampledAt),
      meta: {
        agreementId: r.agreementId,
        deviceRef: r.deviceRef,
        kind: r.kind,
        edgeNodeId: batch.edgeNodeId,
      },
      value: r.value,
      latencyMs: Math.max(0, receivedAt - r.sampledAt),
      ...(r.anomaly ? { anomaly: r.anomaly } : {}),
      ...(r.battery !== undefined ? { battery: r.battery } : {}),
    });
  }
  return { docs, rejected };
}

export function createIngestApp(deps: IngestDeps): Express {
  const now = deps.now ?? Date.now;
  const skew = deps.maxFutureSkewMs ?? 5_000;
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });
  const ingested = new client.Counter({
    name: 'telemetry_readings_total',
    help: 'Telemetry readings accepted',
    labelNames: ['kind'],
    registers: [registry],
  });
  const latency = new client.Histogram({
    name: 'telemetry_end_to_end_latency_ms',
    help: 'Sensor-to-cloud latency measured at ingest',
    buckets: [50, 100, 250, 500, 1000, 2000, 5000, 10000],
    registers: [registry],
  });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.get('/healthz', (_req, res) => void res.json({ status: 'ok' }));
  app.get('/metrics', async (_req, res) => {
    res.setHeader('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  });

  app.post('/ingest/batch', async (req, res) => {
    const receivedAt = now();
    const parsed = batchSchema.safeParse(req.body);
    if (!parsed.success)
      return void res.status(400).json({ error: 'invalid batch', issues: parsed.error.issues });
    const batch = parsed.data;

    const key = deps.edgeKeys.get(batch.edgeNodeId);
    const presented = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    if (!key || !safeEqual(key, presented))
      return void res.status(401).json({ error: 'unknown edge node or key' });

    const { docs, rejected } = toDocuments(batch, receivedAt, skew);
    try {
      if (docs.length) await deps.insert(docs);
    } catch (err) {
      deps.logger.error({ err }, 'telemetry insert failed');
      return void res.status(503).json({ error: 'storage unavailable' });
    }
    for (const d of docs) {
      ingested.inc({ kind: d.meta.kind });
      latency.observe(d.latencyMs);
    }
    for (const r of batch.readings) {
      if (r.anomaly) deps.alert({ ...r, anomaly: r.anomaly, edgeNodeId: batch.edgeNodeId });
    }
    res.status(202).json({ accepted: docs.length, rejected });
  });

  return app;
}
