import { z } from 'zod';
import { CollectionName, loadConfig, suiShape } from '@zk-sla/shared-configs';
import { connectMongo } from '@zk-sla/shared-connections';
import type { Agreement, PeriodRecord } from '@zk-sla/shared-entities';
import { createLogger, onShutdown, sleep } from '@zk-sla/shared-utils';
import { SuiSlaClient, type ChainEvent } from '@zk-sla/sui-client';

const cfg = loadConfig({
  ...suiShape,
  SERVICE_NAME: z.string().default('chain-indexer'),
  INDEXER_POLL_MS: z.coerce.number().int().positive().default(3_000),
});
const logger = createLogger(cfg.SERVICE_NAME, cfg.LOG_LEVEL);

const sui = SuiSlaClient.fromEnv(cfg);
if (!sui) {
  logger.warn('SUI_PACKAGE_ID / SUI_VERIFIER_REGISTRY_ID not set; indexer idle');
  await new Promise(() => undefined);
}

const { client, db } = await connectMongo(cfg.MONGODB_URI, cfg.DATABASE_NAME, logger);
const events = db.collection<ChainEvent & { _id: string; indexedAt: Date }>(CollectionName.CHAIN_EVENTS);
const cursors = db.collection<{ _id: string; cursor: string | null }>(CollectionName.CURSORS);
const agreements = db.collection<Agreement>(CollectionName.AGREEMENTS);
const periods = db.collection<PeriodRecord>(CollectionName.PERIODS);

const name = (type: string) => type.split('::').at(-1)!;
const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));

/** Projects on-chain events onto the off-chain mirror used by the gateway and console. */
async function project(e: ChainEvent) {
  const j = e.json ?? {};
  const onChainId = str(j['agreement_id']);
  switch (name(e.type)) {
    case 'AgreementActivated':
      await agreements.updateOne(
        { onChainId },
        { $set: { status: 'active', startMs: Number(j['start_ms']), updatedAt: new Date() } },
      );
      break;
    case 'AgreementCancelled':
      await agreements.updateOne({ onChainId }, { $set: { status: 'cancelled', updatedAt: new Date() } });
      break;
    case 'AgreementClosed':
      await agreements.updateOne({ onChainId }, { $set: { status: 'closed', updatedAt: new Date() } });
      break;
    case 'ComplianceProven':
    case 'ViolationClaimed': {
      const a = await agreements.findOne({ onChainId });
      if (!a) break;
      const period = Number(j['period']);
      await periods.updateOne(
        { _id: `${a._id}:${period}` },
        {
          $set: {
            agreementId: a._id,
            period,
            status: name(e.type) === 'ComplianceProven' ? 'submitted' : 'violated',
            txDigest: e.digest,
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      );
      break;
    }
  }
}

let running = true;
async function follow(module: 'sla' | 'negotiation' | 'verifier') {
  const key = `sui:${module}`;
  let cursor = (await cursors.findOne({ _id: key }))?.cursor ?? null;
  while (running) {
    try {
      const page = await sui!.listEvents(module, cursor);
      for (const e of page.events) {
        const res = await events.updateOne(
          { _id: `${e.digest}:${e.eventIndex}` },
          { $setOnInsert: { ...e, indexedAt: new Date() } },
          { upsert: true },
        );
        if (res.upsertedCount) await project(e);
      }
      cursor = page.cursor;
      await cursors.updateOne({ _id: key }, { $set: { cursor } }, { upsert: true });
      if (!page.hasNextPage) await sleep(cfg.INDEXER_POLL_MS);
    } catch (err) {
      logger.warn({ module, err: String(err) }, 'event poll failed');
      await sleep(cfg.INDEXER_POLL_MS * 3);
    }
  }
}

for (const m of ['sla', 'negotiation', 'verifier'] as const) void follow(m);
logger.info(
  { network: cfg.SUI_NETWORK, packageId: cfg.SUI_PACKAGE_ID },
  'chain indexer following zk_sla events',
);

onShutdown(logger, async () => {
  running = false;
  await client.close();
});
