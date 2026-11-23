import amqp, { type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib';
import { MongoClient, type Db } from 'mongodb';
import { retry, type Logger } from '@zk-sla/shared-utils';

// ---- MongoDB -------------------------------------------------------------------

export async function connectMongo(
  uri: string,
  database: string,
  logger: Logger,
): Promise<{ client: MongoClient; db: Db }> {
  const client = new MongoClient(uri, { maxPoolSize: 20 });
  await retry(() => client.connect(), {
    onError: (err, attempt) => logger.warn({ attempt, err: String(err) }, 'mongodb not ready'),
  });
  logger.info({ database }, 'mongodb connected');
  return { client, db: client.db(database) };
}

// ---- RabbitMQ ------------------------------------------------------------------

export interface QueueOptions {
  /** Messages rejected without requeue are routed to this queue. */
  deadLetterQueue?: string;
}

export class Broker {
  private constructor(
    private readonly connection: ChannelModel,
    readonly channel: Channel,
    private readonly logger: Logger,
  ) {}

  static async connect(url: string, logger: Logger): Promise<Broker> {
    const connection = await retry(() => amqp.connect(url), {
      onError: (err, attempt) => logger.warn({ attempt, err: String(err) }, 'rabbitmq not ready'),
    });
    connection.on('error', (err) => logger.error({ err }, 'rabbitmq connection error'));
    connection.on('close', () => {
      logger.error('rabbitmq connection closed');
      process.exit(1); // let the orchestrator restart the container
    });
    const channel = await connection.createChannel();
    logger.info('rabbitmq connected');
    return new Broker(connection, channel, logger);
  }

  async assertQueue(name: string, { deadLetterQueue }: QueueOptions = {}) {
    if (deadLetterQueue) await this.channel.assertQueue(deadLetterQueue, { durable: true });
    await this.channel.assertQueue(name, {
      durable: true,
      ...(deadLetterQueue ? { deadLetterExchange: '', deadLetterRoutingKey: deadLetterQueue } : {}),
    });
  }

  publish(queue: string, payload: unknown): boolean {
    return this.channel.sendToQueue(queue, Buffer.from(JSON.stringify(payload)), {
      persistent: true,
      contentType: 'application/json',
    });
  }

  /**
   * Consumes JSON messages one at a time per prefetch slot. A handler that
   * throws causes the message to be dead-lettered (no requeue loop).
   */
  async consume<T>(queue: string, handler: (payload: T, raw: ConsumeMessage) => Promise<void>, prefetch = 1) {
    await this.channel.prefetch(prefetch);
    await this.channel.consume(queue, (msg) => {
      if (!msg) return;
      let payload: T;
      try {
        payload = JSON.parse(msg.content.toString()) as T;
      } catch {
        this.logger.error({ queue }, 'dropping malformed message');
        this.channel.nack(msg, false, false);
        return;
      }
      handler(payload, msg)
        .then(() => this.channel.ack(msg))
        .catch((err) => {
          this.logger.error({ queue, err }, 'handler failed, dead-lettering message');
          this.channel.nack(msg, false, false);
        });
    });
  }

  async close() {
    this.connection.removeAllListeners('close');
    await this.channel.close().catch(() => undefined);
    await this.connection.close().catch(() => undefined);
  }
}

// ---- schema ---------------------------------------------------------------------

/**
 * Idempotently creates the telemetry time-series collection and the indexes
 * every service relies on. Safe to call from several services at start-up.
 */
export async function ensureSchema(db: Db, { telemetryRetentionDays = 30 } = {}) {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  if (!existing.has('telemetry')) {
    await db
      .createCollection('telemetry', {
        timeseries: { timeField: 'ts', metaField: 'meta', granularity: 'seconds' },
        expireAfterSeconds: telemetryRetentionDays * 86_400,
      })
      .catch((err: { codeName?: string }) => {
        if (err.codeName !== 'NamespaceExists') throw err;
      });
  }
  await Promise.all([
    db.collection('accounts').createIndex({ email: 1 }, { unique: true }),
    db.collection('agreements').createIndex({ status: 1 }),
    db.collection('agreements').createIndex({ onChainId: 1 }, { sparse: true }),
    db.collection('periods').createIndex({ agreementId: 1, period: 1 }),
    db.collection('devices').createIndex({ agreementId: 1 }),
    db.collection('proofs').createIndex({ agreementId: 1, completedAt: -1 }),
    db.collection('alerts').createIndex({ agreementId: 1, sampledAt: -1 }),
    db.collection('telemetry').createIndex({ 'meta.agreementId': 1, ts: 1 }),
    db.collection('chain_events').createIndex({ digest: 1, eventIndex: 1 }, { unique: true }),
  ]);
}
