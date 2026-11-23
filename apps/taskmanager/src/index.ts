import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CollectionName, QueueName, loadConfig } from '@zk-sla/shared-configs';
import { Broker, connectMongo } from '@zk-sla/shared-connections';
import type {
  PeriodRecord,
  PeriodStatus,
  ProofRecord,
  ProveResult,
  RequestRecord,
  TelemetryAlert,
  WorkerHeartbeat,
} from '@zk-sla/shared-entities';
import { createLogger, onShutdown } from '@zk-sla/shared-utils';

const cfg = loadConfig({ SERVICE_NAME: z.string().default('taskmanager') });
const logger = createLogger(cfg.SERVICE_NAME, cfg.LOG_LEVEL);

const { client, db } = await connectMongo(cfg.MONGODB_URI, cfg.DATABASE_NAME, logger);
const broker = await Broker.connect(cfg.RABBITMQ_URL, logger);
for (const q of [QueueName.PROVE_RESULT, QueueName.WORKER_HEARTBEAT, QueueName.TELEMETRY_ALERT]) {
  await broker.assertQueue(q);
}

const proofs = db.collection<ProofRecord>(CollectionName.PROOFS);
const periods = db.collection<PeriodRecord>(CollectionName.PERIODS);
const requests = db.collection<RequestRecord>(CollectionName.REQUESTS);
const workers = db.collection<WorkerHeartbeat & { _id: string; lastSeen: Date }>(CollectionName.WORKERS);
const alerts = db.collection<TelemetryAlert & { _id: string; receivedAt: Date }>(CollectionName.ALERTS);

const periodStatus: Record<ProveResult['status'], PeriodStatus> = {
  proven: 'proven',
  submitted: 'submitted',
  non_compliant: 'non_compliant',
  insufficient_data: 'insufficient_data',
  failed: 'failed',
};

/** Persists prover results: proof ledger, period state and negotiation candidates. */
await broker.consume<ProveResult>(
  QueueName.PROVE_RESULT,
  async (result) => {
    const { jobId, ...rest } = result;
    await proofs.updateOne(
      { _id: jobId },
      { $set: { ...rest, endToEndMs: result.completedAt - result.enqueuedAt } },
      { upsert: true },
    );

    if (result.kind === 'sla' && result.agreementId !== undefined && result.period !== undefined) {
      await periods.updateOne(
        // Only the job that currently owns the period may settle it.
        { _id: `${result.agreementId}:${result.period}`, jobId },
        {
          $set: {
            status: periodStatus[result.status],
            verdict: result.verdict,
            metricsCommitment: result.publicSignals?.[0],
            txDigest: result.txDigest,
            updatedAt: new Date(),
          },
        },
      );
    }

    if (
      result.kind === 'negotiation' &&
      result.requestId &&
      result.offerId &&
      (result.status === 'proven' || result.status === 'submitted')
    ) {
      const offer = await db
        .collection(CollectionName.OFFERS)
        .findOne<{ providerId: string }>({ _id: result.offerId as never });
      await requests.updateOne(
        { _id: result.requestId, 'candidates.offerId': { $ne: result.offerId } },
        {
          $push: {
            candidates: {
              offerId: result.offerId,
              providerId: offer?.providerId ?? 'unknown',
              qualifiedAt: new Date(),
              txDigest: result.txDigest,
            },
          },
        },
      );
    }
  },
  16,
);

await broker.consume<WorkerHeartbeat>(
  QueueName.WORKER_HEARTBEAT,
  async (hb) => {
    await workers.updateOne(
      { _id: hb.workerId },
      { $set: { ...hb, lastSeen: new Date() } },
      { upsert: true },
    );
  },
  32,
);

await broker.consume<TelemetryAlert>(
  QueueName.TELEMETRY_ALERT,
  async (alert) => {
    await alerts.insertOne({ _id: randomUUID(), ...alert, receivedAt: new Date() });
  },
  32,
);

logger.info('taskmanager consuming results, heartbeats and alerts');

onShutdown(logger, async () => {
  await broker.close();
  await client.close();
});
