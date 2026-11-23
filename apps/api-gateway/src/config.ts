import { z } from 'zod';
import { httpShape, loadConfig, secretsShape } from '@zk-sla/shared-configs';

export const config = () =>
  loadConfig({
    ...httpShape,
    ...secretsShape,
    SERVICE_NAME: z.string().default('api-gateway'),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    JWT_TTL: z.string().default('12h'),
    /** HMAC key turning raw device identifiers into pseudonyms (shared with edge agents). */
    PSEUDONYM_KEY: z.string().min(16),
    INIT_ADMIN_EMAIL: z.string().email().optional(),
    INIT_ADMIN_PASSWORD: z.string().min(8).optional(),
  });

export type Config = ReturnType<typeof config>;
