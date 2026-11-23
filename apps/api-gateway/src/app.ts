import express, { type Express } from 'express';
import client from '@prometheus-io/client';
import type { Db } from 'mongodb';
import type { Logger } from '@zk-sla/shared-utils';
import type { Config } from './config.js';
import { HttpError, Tokens, errorHandler } from './http.js';
import { agreementRoutes } from './routes/agreements.js';
import { authRoutes } from './routes/auth.js';
import { negotiationRoutes } from './routes/negotiation.js';
import { observabilityRoutes } from './routes/observability.js';

export interface Deps {
  db: Db;
  broker: { publish(queue: string, payload: unknown): boolean };
  cfg: Config;
  logger: Logger;
  tokens: Tokens;
  ready: () => boolean;
}

export function createApp(deps: Deps): Express {
  const app = express();
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });
  const latency = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  });

  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (deps.cfg.CORS_ORIGINS.includes('*') || deps.cfg.CORS_ORIGINS.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') return void res.sendStatus(204);
    const end = latency.startTimer({ method: req.method });
    res.on('finish', () =>
      end({ route: req.route?.path ?? req.baseUrl ?? 'unmatched', status: res.statusCode }),
    );
    next();
  });

  app.get('/healthz', (_req, res) => void res.json({ status: 'ok' }));
  app.get('/readyz', (_req, res) => void res.status(deps.ready() ? 200 : 503).json({ ready: deps.ready() }));
  app.get('/metrics', async (_req, res) => {
    res.setHeader('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  });

  const auth = deps.tokens.middleware();
  app.use('/api/auth', authRoutes(deps));
  app.use('/api/agreements', auth, agreementRoutes(deps));
  app.use('/api/negotiation', auth, negotiationRoutes(deps));
  app.use('/api', auth, observabilityRoutes(deps));

  app.use((_req, _res, next) => next(new HttpError(404, 'route not found')));
  app.use(errorHandler(deps.logger));
  return app;
}
