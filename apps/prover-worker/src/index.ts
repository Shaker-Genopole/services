import { hostname } from 'node:os';
import { z } from 'zod';
import { Prover } from '@zk-sla/circuits';
import { CollectionName, QueueName, loadConfig, secretsShape, suiShape } from '@zk-sla/shared-configs';
import { Broker, connectMongo } from '@zk-sla/shared-connections';
import type {
  Agreement,
  DeploymentRecord,
  OfferRecord,
  PeriodRecord,
  ProveNegotiationJob,
  ProveResult,
  ProveSlaJob,
  RequestRecord,
  TelemetryDocument,
  WorkerHeartbeat,
} from '@zk-sla/shared-entities';
import { createLogger, onShutdown, randomHex } from '@zk-sla/shared-utils';
import { SuiSlaClient } from '@zk-sla/sui-client';
import { runNegotiationJob, runSlaJob, type JobContext, type Store } from './jobs.js';

const cfg = loadConfig({
  ...suiShape,
  ...secretsShape,
  SERVICE_NAME: z.string().default('prover-worker'),
  ZK_ARTIFACTS_DIR: z.string().optional(),
  /** Concurrent proofs per worker; scale horizontally with replicas instead of raising this. */
  PROVER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  HEARTBEAT_MS: z.coerce.number().int().positive().default(10_000),
});
const workerId = `${hostname()}-${randomHex(3)}`;
const logger = createLogger(cfg.SERVICE_NAME, cfg.LOG_LEVEL).child({ workerId });

const { client, db } = await connectMongo(cfg.MONGODB_URI, cfg.DATABASE_NAME, logger);
const broker = await Broker.connect(cfg.RABBITMQ_URL, logger);
for (const q of [QueueName.PROVE_SLA, QueueName.PROVE_NEGOTIATION]) {
  await broker.assertQueue(q, { deadLetterQueue: QueueName.PROVE_DEAD_LETTER });
}
await broker.assertQueue(QueueName.PROVE_RESULT);
await broker.assertQueue(QueueName.WORKER_HEARTBEAT);

const sui = SuiSlaClient.fromEnv(cfg);
const chain = sui?.canWrite ? sui : null;
logger.info(
  { onChain: Boolean(chain), provider: sui?.address },
  chain ? 'on-chain submission enabled' : 'off-chain mode',
);

const store: Store = {
  agreement: (id) => db.collection<Agreement>(CollectionName.AGREEMENTS).findOne({ _id: id }),
  sealedDeployment: async (id) =>
    (await db.collection<DeploymentRecord>(CollectionName.DEPLOYMENTS).findOne({ _id: id }))?.sealed ?? null,
  samples: async (agreementId, from, to) =>
    (
      await db
        .collection<TelemetryDocument>(CollectionName.TELEMETRY)
        .find(
          { 'meta.agreementId': agreementId, ts: { $gte: new Date(from), $lt: new Date(to) } },
          { projection: { ts: 1, latencyMs: 1, 'meta.deviceRef': 1 } },
        )
        .toArray()
    ).map((d) => ({ deviceRef: d.meta.deviceRef, ts: d.ts.getTime(), latencyMs: d.latencyMs })),
  request: (id) => db.collection<RequestRecord>(CollectionName.REQUESTS).findOne({ _id: id }),
  offer: (id) => db.collection<OfferRecord>(CollectionName.OFFERS).findOne({ _id: id }),
  markProving: async (agreementId, period, jobId) => {
    await db
      .collection<PeriodRecord>(CollectionName.PERIODS)
      .updateOne(
        { _id: `${agreementId}:${period}` },
        { $set: { status: 'proving', jobId, updatedAt: new Date() } },
      );
  },
};

const ctx: JobContext = {
  workerId,
  prover: new Prover(cfg.ZK_ARTIFACTS_DIR ? { artifactsDir: cfg.ZK_ARTIFACTS_DIR } : {}),
  store,
  sealKey: cfg.SEAL_KEY,
  chain,
  logger,
};

let busy = 0;
let processed = 0;
let failed = 0;

async function track(
  kind: ProveResult['kind'],
  job: { jobId: string; enqueuedAt: number },
  run: () => Promise<ProveResult>,
) {
  busy++;
  try {
    const result = await run().catch((err: unknown): ProveResult => ({
      jobId: job.jobId,
      kind,
      status: 'failed',
      workerId,
      error: err instanceof Error ? err.message : String(err),
      enqueuedAt: job.enqueuedAt,
      completedAt: Date.now(),
    }));
    if (result.status === 'failed') failed++;
    processed++;
    broker.publish(QueueName.PROVE_RESULT, result);
    logger.info(
      { jobId: job.jobId, status: result.status, provingMs: result.provingMs, tx: result.txDigest },
      'job done',
    );
  } finally {
    busy--;
  }
}

await broker.consume<ProveSlaJob>(
  QueueName.PROVE_SLA,
  (job) => track('sla', job, () => runSlaJob(ctx, job)),
  cfg.PROVER_CONCURRENCY,
);
await broker.consume<ProveNegotiationJob>(
  QueueName.PROVE_NEGOTIATION,
  (job) => track('negotiation', job, () => runNegotiationJob(ctx, job)),
  cfg.PROVER_CONCURRENCY,
);

const heartbeat = setInterval(() => {
  const hb: WorkerHeartbeat = {
    workerId,
    kind: 'prover',
    busy: busy > 0,
    processed,
    failed,
    sentAt: Date.now(),
  };
  broker.publish(QueueName.WORKER_HEARTBEAT, hb);
}, cfg.HEARTBEAT_MS);

logger.info('prover worker ready');

onShutdown(logger, async () => {
  clearInterval(heartbeat);
  await broker.close();
  await client.close();
  await Prover.shutdown();
});
