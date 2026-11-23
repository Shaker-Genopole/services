import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(service: string, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({ name: service, level, base: { service }, timestamp: pino.stdTimeFunctions.isoTime });
}

// ---- crypto -----------------------------------------------------------------

/** Keyed pseudonym for a raw identifier (device UUID, patient ID). Irreversible without the key. */
export function pseudonymize(raw: string, key: string): string {
  return createHmac('sha256', key).update(raw).digest('hex').slice(0, 32);
}

/** AES-256-GCM sealing of a JSON-serialisable value. Output: base64(iv | tag | ciphertext). */
export function seal(value: unknown, keyHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function unseal<T>(sealed: string, keyHex: string): T {
  const buf = Buffer.from(sealed, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  const plain = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  return JSON.parse(plain) as T;
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const randomHex = (bytes = 16) => randomBytes(bytes).toString('hex');

// ---- statistics ---------------------------------------------------------------

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
}

export const median = (values: readonly number[]) => percentile(values, 50);

export const mean = (values: readonly number[]) =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;

// ---- async helpers -------------------------------------------------------------

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Retries `fn` with exponential backoff (capped), used for broker/database start-up races. */
export async function retry<T>(
  fn: () => Promise<T>,
  {
    attempts = 30,
    baseMs = 500,
    maxMs = 10_000,
    onError,
  }: {
    attempts?: number;
    baseMs?: number;
    maxMs?: number;
    onError?: (err: unknown, attempt: number) => void;
  } = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      onError?.(err, attempt);
      await sleep(Math.min(maxMs, baseMs * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

/** Runs `stop` callbacks on SIGINT/SIGTERM so containers shut down cleanly. */
export function onShutdown(logger: Logger, stop: () => Promise<void>) {
  let stopping = false;
  const handler = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    stop()
      .catch((err) => logger.error({ err }, 'shutdown failed'))
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}
