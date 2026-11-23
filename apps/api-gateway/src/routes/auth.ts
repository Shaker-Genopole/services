import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { CollectionName } from '@zk-sla/shared-configs';
import type { Account } from '@zk-sla/shared-entities';
import { HttpError, handle, parse, principal } from '../http.js';
import type { Deps } from '../app.js';

const credentials = z.object({ email: z.string().email().toLowerCase(), password: z.string().min(8) });
const signup = credentials.extend({
  role: z.enum(['consumer', 'provider']),
  organisation: z.string().min(2).max(120),
  suiAddress: z
    .string()
    .regex(/^0x[0-9a-f]{64}$/i)
    .optional(),
});

const publicAccount = ({ passwordHash: _, ...a }: Account) => a;

export function authRoutes({ db, tokens }: Deps): Router {
  const accounts = db.collection<Account>(CollectionName.ACCOUNTS);
  const r = Router();

  r.post(
    '/signup',
    handle(async (req, res) => {
      const body = parse(signup, req.body);
      if (await accounts.findOne({ email: body.email })) throw new HttpError(409, 'email already registered');
      const account: Account = {
        _id: randomUUID(),
        email: body.email,
        passwordHash: await bcrypt.hash(body.password, 12),
        role: body.role,
        organisation: body.organisation,
        suiAddress: body.suiAddress,
        createdAt: new Date(),
      };
      await accounts.insertOne(account);
      const token = await tokens.sign({ id: account._id, role: account.role, email: account.email });
      res.status(201).json({ token, account: publicAccount(account) });
    }),
  );

  r.post(
    '/login',
    handle(async (req, res) => {
      const body = parse(credentials, req.body);
      const account = await accounts.findOne({ email: body.email });
      if (!account || !(await bcrypt.compare(body.password, account.passwordHash))) {
        throw new HttpError(401, 'invalid credentials');
      }
      const token = await tokens.sign({ id: account._id, role: account.role, email: account.email });
      res.json({ token, account: publicAccount(account) });
    }),
  );

  r.get(
    '/me',
    tokens.middleware(),
    handle(async (req, res) => {
      const account = await accounts.findOne({ _id: principal(req).id });
      if (!account) throw new HttpError(404, 'account not found');
      res.json(publicAccount(account));
    }),
  );

  return r;
}
