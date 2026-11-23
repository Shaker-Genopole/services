import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { jwtVerify, SignJWT } from 'jose';
import { ZodError, type ZodType } from 'zod';
import type { Role } from '@zk-sla/shared-entities';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`);
export const forbidden = () => new HttpError(403, 'forbidden');

export interface Principal {
  id: string;
  role: Role;
  email: string;
}

type AuthedRequest = Request & { user?: Principal };

/** Wraps an async handler so rejections reach the error middleware. */
export const handle =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export const parse = <T>(schema: ZodType<T>, value: unknown): T => schema.parse(value);

export function errorHandler(logger: { error: (o: object, m: string) => void }) {
  return (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: 'validation failed', issues: err.issues });
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    logger.error({ err }, 'unhandled error');
    res.status(500).json({ error: 'internal error' });
  };
}

export class Tokens {
  private readonly key: Uint8Array;
  constructor(
    secret: string,
    private readonly ttl: string,
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  sign(p: Principal) {
    return new SignJWT({ role: p.role, email: p.email })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(p.id)
      .setIssuedAt()
      .setExpirationTime(this.ttl)
      .sign(this.key);
  }

  async verify(token: string): Promise<Principal> {
    const { payload } = await jwtVerify(token, this.key, { algorithms: ['HS256'] });
    return { id: payload.sub!, role: payload['role'] as Role, email: payload['email'] as string };
  }

  middleware(): RequestHandler {
    return (req, _res, next) => {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ')) return next(new HttpError(401, 'missing bearer token'));
      this.verify(header.slice(7))
        .then((user) => {
          (req as AuthedRequest).user = user;
          next();
        })
        .catch(() => next(new HttpError(401, 'invalid token')));
    };
  }
}

export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    const user = (req as AuthedRequest).user;
    if (!user || !roles.includes(user.role)) return next(forbidden());
    next();
  };

export const principal = (req: Request): Principal => {
  const user = (req as AuthedRequest).user;
  if (!user) throw new HttpError(401, 'unauthenticated');
  return user;
};
