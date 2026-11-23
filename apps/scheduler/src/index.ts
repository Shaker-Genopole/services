import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CollectionName, QueueName, loadConfig } from '@zk-sla/shared-configs';
import { Broker, connectMongo } from '@zk-sla/shared-connections';
import type { Agreement, PeriodRecord, ProveSlaJob } from '@zk-sla/shared-entities';
import { createLogger, onShutdown } from '@zk-sla/shared-utils';
import { planPeriods } from './plan.js';

const cfg = loadConfig({
  SERVICE_NAME: z.string().default('scheduler'),
  SCHEDULER_TICK_MS: z.coerce.number().int().positive().default(15_000),
  /** Re-queue jobs stuck in queued/proving longer than this (worker crash). */
  STALE_JOB_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 60_000),
});
const logger = createLogger(cfg.SERVICE_NAME, cfg.LOG_LEVEL);

const { client, db } = await connectMongo(cfg.MONGODB_URI, cfg.DATABASE_NAME, logger);
const broker = await Broker.connect(cfg.RABBITMQ_URL, logger);
await broker.assertQueue(QueueName.PROVE_SLA, { deadLetterQueue: QueueName.PROVE_DEAD_LETTER });

const agreements = db.collection<Agreement>(CollectionName.AGREEMENTS);
const periods = db.collection<PeriodRecord>(CollectionName.PERIODS);

/**
 * Claims a period atomically before publishing, so several scheduler replicas
 * never enqueue the same proof twice (duplicate-key on the deterministic _id).
 */
async function enqueue(a: Agreement, period: number, now: number) {
  const job: ProveSlaJob = { jobId: randomUUID(), agreementId: a._id, period, enqueuedAt: now };
  try {
    await periods.insertOne({
      _id: `${a._id}:${period}`,
      agreementId: a._id,
      period,
      status: 'queued',
      jobId: job.jobId,
      queuedAt: new Date(now),
      updatedAt: new Date(now),
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return false;
    throw err;
  }
  broker.publish(QueueName.PROVE_SLA, job);
  return true;
}

async function requeueStale(now: number) {
  const stale = await periods
    .find({ status: { $in: ['queued', 'proving'] }, updatedAt: { $lt: new Date(now - cfg.STALE_JOB_MS) } })
    .toArray();
  for (const p of stale) {
    const job: ProveSlaJob = {
      jobId: randomUUID(),
      agreementId: p.agreementId,
      period: p.period,
      enqueuedAt: now,
    };
    const res = await periods.updateOne(
      { _id: p._id, updatedAt: p.updatedAt },
      { $set: { status: 'queued', jobId: job.jobId, updatedAt: new Date(now) } },
    );
    if (res.modifiedCount) {
      broker.publish(QueueName.PROVE_SLA, job);
      logger.warn({ period: p._id }, 're-queued stale proof job');
    }
  }
}

async function tick() {
  const now = Date.now();
  const active = await agreements.find({ status: 'active' }).toArray();
  let queued = 0;
  let lapsed = 0;
  for (const a of active) {
    const known = new Set(
      (await periods.find({ agreementId: a._id }, { projection: { period: 1, status: 1 } }).toArray())
        .filter((p) => !['failed', 'insufficient_data', 'non_compliant'].includes(p.status))
        .map((p) => p.period),
    );
    const plan = planPeriods(a, known, now);
    for (const p of plan.due) if (await enqueue(a, p, now)) queued++;
    for (const p of plan.expired) {
      // Lapsed without a valid proof: the consumer can claim the penalty on chain.
      await periods.updateOne(
        { _id: `${a._id}:${p}`, status: { $nin: ['proven', 'submitted', 'queued', 'proving'] } },
        { $set: { agreementId: a._id, period: p, status: 'violated', updatedAt: new Date(now) } },
        { upsert: true },
      );
      lapsed++;
    }
  }
  await requeueStale(now);
  if (queued || lapsed) logger.info({ queued, lapsed, agreements: active.length }, 'scheduler tick');
}

let running = true;
(async () => {
  while (running) {
    await tick().catch((err) => logger.error({ err }, 'tick failed'));
    await new Promise((r) => setTimeout(r, cfg.SCHEDULER_TICK_MS));
  }
})();
logger.info({ tickMs: cfg.SCHEDULER_TICK_MS }, 'scheduler started');

onShutdown(logger, async () => {
  running = false;
  await broker.close();
  await client.close();
});
