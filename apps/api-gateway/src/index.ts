import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { CollectionName, QueueName } from '@zk-sla/shared-configs';
import { Broker, connectMongo, ensureSchema } from '@zk-sla/shared-connections';
import type { Account } from '@zk-sla/shared-entities';
import { createLogger, onShutdown } from '@zk-sla/shared-utils';
import { createApp } from './app.js';
import { config } from './config.js';
import { Tokens } from './http.js';

const cfg = config();
const logger = createLogger(cfg.SERVICE_NAME, cfg.LOG_LEVEL);

const { client, db } = await connectMongo(cfg.MONGODB_URI, cfg.DATABASE_NAME, logger);
await ensureSchema(db);
const broker = await Broker.connect(cfg.RABBITMQ_URL, logger);
await broker.assertQueue(QueueName.PROVE_SLA, { deadLetterQueue: QueueName.PROVE_DEAD_LETTER });
await broker.assertQueue(QueueName.PROVE_NEGOTIATION, { deadLetterQueue: QueueName.PROVE_DEAD_LETTER });

if (cfg.INIT_ADMIN_EMAIL && cfg.INIT_ADMIN_PASSWORD) {
  const accounts = db.collection<Account>(CollectionName.ACCOUNTS);
  if (!(await accounts.findOne({ email: cfg.INIT_ADMIN_EMAIL }))) {
    await accounts.insertOne({
      _id: randomUUID(),
      email: cfg.INIT_ADMIN_EMAIL,
      passwordHash: await bcrypt.hash(cfg.INIT_ADMIN_PASSWORD, 12),
      role: 'admin',
      organisation: 'platform',
      createdAt: new Date(),
    });
    logger.info({ email: cfg.INIT_ADMIN_EMAIL }, 'admin account created');
  }
}

const app = createApp({
  db,
  broker,
  cfg,
  logger,
  tokens: new Tokens(cfg.JWT_SECRET, cfg.JWT_TTL),
  ready: () => true,
});
const server = app.listen(cfg.PORT, cfg.BIND, () => logger.info({ port: cfg.PORT }, 'api-gateway listening'));

onShutdown(logger, async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await broker.close();
  await client.close();
});
