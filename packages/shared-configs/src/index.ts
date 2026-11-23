import { existsSync } from 'node:fs';
import { z } from 'zod';

if (existsSync('.env')) process.loadEnvFile('.env');

/** Parses `process.env` with a service-specific schema and fails fast on misconfiguration. */
export function loadConfig<T extends z.ZodRawShape>(shape: T, env: NodeJS.ProcessEnv = process.env) {
  const schema = z.object({ ...baseShape, ...shape });
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`invalid configuration:\n${issues}`);
  }
  return parsed.data;
}

const csv = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  );

export const baseShape = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SERVICE_NAME: z.string().default('zk-sla'),
  MONGODB_URI: z.string().default('mongodb://localhost:27017'),
  DATABASE_NAME: z.string().default('zk_sla'),
  RABBITMQ_URL: z.string().default('amqp://localhost:5672'),
};

export const httpShape = {
  BIND: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8080),
  CORS_ORIGINS: csv,
};

export const suiShape = {
  SUI_NETWORK: z.string().default('localnet'),
  SUI_GRPC_URL: z.string().default('http://127.0.0.1:9000'),
  SUI_PACKAGE_ID: z.string().optional(),
  SUI_VERIFIER_REGISTRY_ID: z.string().optional(),
  /** bech32 `suiprivkey…` of the provider account that submits proofs. */
  SUI_PRIVATE_KEY: z.string().optional(),
};

export const secretsShape = {
  /** 32-byte hex key sealing deployment and offer secrets at rest (AES-256-GCM). */
  SEAL_KEY: z.string().regex(/^[0-9a-f]{64}$/i, 'SEAL_KEY must be 32 bytes hex'),
};

export const csvList = csv;

export const QueueName = {
  PROVE_SLA: 'prove.sla',
  PROVE_NEGOTIATION: 'prove.negotiation',
  PROVE_RESULT: 'prove.result',
  PROVE_DEAD_LETTER: 'prove.dead-letter',
  TELEMETRY_ALERT: 'telemetry.alert',
  WORKER_HEARTBEAT: 'worker.heartbeat',
} as const;

export const CollectionName = {
  ACCOUNTS: 'accounts',
  AGREEMENTS: 'agreements',
  PERIODS: 'periods',
  DEPLOYMENTS: 'deployments',
  DEVICES: 'devices',
  TELEMETRY: 'telemetry',
  ALERTS: 'alerts',
  PROOFS: 'proofs',
  OFFERS: 'offers',
  REQUESTS: 'requests',
  WORKERS: 'workers',
  CHAIN_EVENTS: 'chain_events',
  CURSORS: 'cursors',
} as const;
