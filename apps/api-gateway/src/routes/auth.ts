import { randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';
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

const publicAccount = ({ passwordHash: _, walletChallenge: __, ...a }: Account) => a;

const CHALLENGE_TTL_MS = 5 * 60_000;
const suiAddress = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/i)
  .toLowerCase();
const walletLink = z.object({ address: suiAddress, signature: z.string().min(16) });
const profileUpdate = z.object({ organisation: z.string().min(2).max(120) }).strict();

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

  /** Provider directory used by consumers when proposing an agreement. */
  r.get(
    '/providers',
    tokens.middleware(),
    handle(async (_req, res) => {
      const providers = await accounts
        .find({ role: 'provider' }, { projection: { organisation: 1, suiAddress: 1 } })
        .sort({ organisation: 1 })
        .toArray();
      res.json(providers);
    }),
  );

  /** Issues a one-time message the connected wallet signs to prove address ownership. */
  r.post(
    '/wallet/challenge',
    tokens.middleware(),
    handle(async (req, res) => {
      const user = principal(req);
      const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
      const message = [
        'ZK-SLA console: link this wallet to your account.',
        `Account: ${user.email}`,
        `Nonce: ${randomBytes(16).toString('hex')}`,
        `Expires: ${expiresAt.toISOString()}`,
      ].join('\n');
      await accounts.updateOne({ _id: user.id }, { $set: { walletChallenge: { message, expiresAt } } });
      res.json({ message, expiresAt });
    }),
  );

  /** Verifies the signed challenge and records the wallet address on the account. */
  r.post(
    '/wallet',
    tokens.middleware(),
    handle(async (req, res) => {
      const user = principal(req);
      const body = parse(walletLink, req.body);
      const account = await accounts.findOne({ _id: user.id });
      const challenge = account?.walletChallenge;
      if (!account || !challenge) throw new HttpError(409, 'request a wallet challenge first');
      if (challenge.expiresAt.getTime() < Date.now()) throw new HttpError(409, 'wallet challenge expired');
      try {
        await verifyPersonalMessageSignature(new TextEncoder().encode(challenge.message), body.signature, {
          offline: true,
          address: body.address,
        });
      } catch {
        throw new HttpError(401, 'signature does not match the wallet address');
      }
      const owner = await accounts.findOne({ suiAddress: body.address, _id: { $ne: user.id } });
      if (owner) throw new HttpError(409, 'wallet already linked to another account');
      await accounts.updateOne(
        { _id: user.id },
        { $set: { suiAddress: body.address }, $unset: { walletChallenge: '' } },
      );
      res.json(publicAccount({ ...account, suiAddress: body.address }));
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

  r.patch(
    '/me',
    tokens.middleware(),
    handle(async (req, res) => {
      const body = parse(profileUpdate, req.body);
      const id = principal(req).id;
      await accounts.updateOne({ _id: id }, { $set: body });
      const account = await accounts.findOne({ _id: id });
      if (!account) throw new HttpError(404, 'account not found');
      res.json(publicAccount(account));
    }),
  );

  /** Removes the linked wallet; a new one can be linked with a fresh challenge. */
  r.delete(
    '/wallet',
    tokens.middleware(),
    handle(async (req, res) => {
      await accounts.updateOne(
        { _id: principal(req).id },
        { $unset: { suiAddress: '', walletChallenge: '' } },
      );
      res.status(204).end();
    }),
  );

  /**
   * Tokens are stateless JWTs with a short lifetime; the client discards its token.
   * The endpoint exists so clients have one explicit sign-out call to make.
   */
  r.post(
    '/logout',
    tokens.middleware(),
    handle(async (_req, res) => {
      res.status(204).end();
    }),
  );

  return r;
}
