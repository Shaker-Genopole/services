import { z } from 'zod';
import { CollectionName, QueueName, httpShape, loadConfig } from '@zk-sla/shared-configs';
import { Broker, connectMongo, ensureSchema } from '@zk-sla/shared-connections';
import type { TelemetryDocument } from '@zk-sla/shared-entities';
import { createLogger, onShutdown } from '@zk-sla/shared-utils';
import { createIngestApp } from './app.js';

const cfg = loadConfig({
  ...httpShape,
  SERVICE_NAME: z.string().default('telemetry-ingest'),
  PORT: z.coerce.number().int().positive().default(8081),
  /** Comma-separated `edgeNodeId:apiKey` pairs. */
  EDGE_API_KEYS: z.string().min(1),
});
const logger = createLogger(cfg.SERVICE_NAME, cfg.LOG_LEVEL);

const edgeKeys = new Map(
  cfg.EDGE_API_KEYS.split(',').map((pair) => {
    const [node, key] = pair.trim().split(':');
    if (!node || !key) throw new Error('EDGE_API_KEYS entries must be edgeNodeId:apiKey');
    return [node, key] as const;
  }),
);

const { client, db } = await connectMongo(cfg.MONGODB_URI, cfg.DATABASE_NAME, logger);
await ensureSchema(db);
const broker = await Broker.connect(cfg.RABBITMQ_URL, logger);
await broker.assertQueue(QueueName.TELEMETRY_ALERT);
const telemetry = db.collection<TelemetryDocument>(CollectionName.TELEMETRY);

const app = createIngestApp({
  edgeKeys,
  logger,
  insert: async (docs) => {
    await telemetry.insertMany(docs, { ordered: false });
  },
  alert: (alert) => broker.publish(QueueName.TELEMETRY_ALERT, alert),
});
const server = app.listen(cfg.PORT, cfg.BIND, () =>
  logger.info({ port: cfg.PORT, edgeNodes: edgeKeys.size }, 'telemetry-ingest listening'),
);

onShutdown(logger, async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await broker.close();
  await client.close();
});
