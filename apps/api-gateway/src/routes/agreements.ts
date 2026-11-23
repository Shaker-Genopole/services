import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import {
  deploymentCommitment,
  deploymentSecrets,
  objectIdToTag,
  randomScalar,
  toField,
} from '@zk-sla/circuits';
import { CollectionName, QueueName } from '@zk-sla/shared-configs';
import type {
  Account,
  Agreement,
  DeploymentDescription,
  DeploymentRecord,
  DeviceRecord,
  PeriodRecord,
  ProveSlaJob,
} from '@zk-sla/shared-entities';
import { pseudonymize, seal } from '@zk-sla/shared-utils';
import {
  HttpError,
  forbidden,
  handle,
  notFound,
  parse,
  principal,
  requireRole,
  type Principal,
} from '../http.js';
import type { Deps } from '../app.js';

const suiId = z.string().regex(/^0x[0-9a-f]{64}$/i);

export const termsSchema = z
  .object({
    maxLatencyMs: z.number().int().positive().max(0xffffffff),
    latencyQuorumBp: z.number().int().min(0).max(10_000),
    minAvailabilityBp: z.number().int().min(0).max(10_000),
    maxIntervalSec: z.number().int().positive().max(0xffffffff),
    periodMs: z.number().int().min(60_000),
    totalPeriods: z.number().int().positive().max(10_000),
    graceMs: z.number().int().min(0),
    rewardPerPeriod: z.number().int().min(0),
    penaltyPerPeriod: z.number().int().min(0),
  })
  .strict();

const createSchema = z.object({
  title: z.string().min(3).max(160),
  providerId: z.string().min(1),
  terms: termsSchema,
  onChainId: suiId.optional(),
});

const deploymentSchema = z.object({
  locations: z.array(z.string().min(1)).min(1),
  sensorConfig: z.record(z.string(), z.unknown()),
  devices: z
    .array(
      z.object({
        deviceId: z.string().min(1),
        kind: z.enum(['ecg', 'cgm', 'temperature', 'spo2', 'blood_pressure', 'camera']),
        expectedIntervalSec: z.number().positive(),
        edgeNodeId: z.string().min(1),
      }),
    )
    .min(1),
});

const activateSchema = z.object({
  startMs: z.number().int().positive().optional(),
  onChainId: suiId.optional(),
});

export const tagFor = (agreementId: string, onChainId?: string) =>
  (onChainId ? objectIdToTag(onChainId) : toField(`agreement:${agreementId}`) >> 2n).toString();

const canSee = (user: Principal, a: Agreement) =>
  user.role === 'admin' || a.consumerId === user.id || a.providerId === user.id;

export function agreementRoutes({ db, broker, cfg }: Deps): Router {
  const agreements = db.collection<Agreement>(CollectionName.AGREEMENTS);
  const accounts = db.collection<Account>(CollectionName.ACCOUNTS);
  const periods = db.collection<PeriodRecord>(CollectionName.PERIODS);
  const deployments = db.collection<DeploymentRecord>(CollectionName.DEPLOYMENTS);
  const devices = db.collection<DeviceRecord>(CollectionName.DEVICES);
  const r = Router();

  const load = async (id: string, user: Principal) => {
    const a = await agreements.findOne({ _id: id });
    if (!a) throw notFound('agreement');
    if (!canSee(user, a)) throw forbidden();
    return a;
  };

  r.get(
    '/',
    handle(async (req, res) => {
      const user = principal(req);
      const filter = user.role === 'admin' ? {} : { $or: [{ consumerId: user.id }, { providerId: user.id }] };
      res.json(await agreements.find(filter).sort({ createdAt: -1 }).limit(200).toArray());
    }),
  );

  r.post(
    '/',
    requireRole('consumer'),
    handle(async (req, res) => {
      const body = parse(createSchema, req.body);
      const provider = await accounts.findOne({ _id: body.providerId, role: 'provider' });
      if (!provider) throw new HttpError(400, 'providerId is not a provider account');
      const id = randomUUID();
      const now = new Date();
      const agreement: Agreement = {
        _id: id,
        onChainId: body.onChainId,
        title: body.title,
        consumerId: principal(req).id,
        providerId: body.providerId,
        terms: body.terms,
        status: 'proposed',
        tag: tagFor(id, body.onChainId),
        createdAt: now,
        updatedAt: now,
      };
      await agreements.insertOne(agreement);
      res.status(201).json(agreement);
    }),
  );

  r.get(
    '/:id',
    handle(async (req, res) => {
      const a = await load(String(req.params['id']), principal(req));
      const [periodList, deviceCount] = await Promise.all([
        periods.find({ agreementId: a._id }).sort({ period: 1 }).toArray(),
        devices.countDocuments({ agreementId: a._id }),
      ]);
      res.json({ ...a, periods: periodList, deviceCount });
    }),
  );

  /**
   * Provider registers the hidden deployment. Raw device IDs and locations are
   * sealed at rest; only the Poseidon commitment and device pseudonyms leave.
   */
  r.post(
    '/:id/deployment',
    requireRole('provider'),
    handle(async (req, res) => {
      const user = principal(req);
      const a = await load(String(req.params['id']), user);
      if (a.providerId !== user.id) throw forbidden();
      if (a.status !== 'proposed') throw new HttpError(409, 'deployment can only be set before activation');
      const body = parse(deploymentSchema, req.body);

      const salt = randomScalar();
      const refs = body.devices.map((d) => ({
        ...d,
        deviceRef: pseudonymize(d.deviceId, cfg.PSEUDONYM_KEY),
      }));
      const description: DeploymentDescription = {
        deviceIds: refs.map((d) => d.deviceId),
        locations: body.locations,
        sensorConfig: body.sensorConfig,
        devices: refs.map(({ deviceRef, kind, expectedIntervalSec }) => ({
          deviceRef,
          kind,
          expectedIntervalSec,
        })),
        salt: salt.toString(),
      };
      const commitment = deploymentCommitment(
        deploymentSecrets({
          deviceIds: description.deviceIds,
          locations: body.locations,
          sensorConfig: body.sensorConfig,
          salt,
        }),
      ).toString();

      const now = new Date();
      await deployments.updateOne(
        { _id: a._id },
        {
          $set: {
            sealed: seal(description, cfg.SEAL_KEY),
            commitment,
            deviceCount: refs.length,
            createdAt: now,
          },
        },
        { upsert: true },
      );
      await devices.deleteMany({ agreementId: a._id });
      await devices.insertMany(
        refs.map((d) => ({
          _id: d.deviceRef,
          agreementId: a._id,
          kind: d.kind,
          edgeNodeId: d.edgeNodeId,
          expectedIntervalSec: d.expectedIntervalSec,
          registeredAt: now,
        })),
      );
      await agreements.updateOne(
        { _id: a._id },
        { $set: { deploymentCommitment: commitment, updatedAt: now } },
      );
      res.json({
        deploymentCommitment: commitment,
        devices: refs.map(({ deviceId, deviceRef, kind }) => ({ deviceId, deviceRef, kind })),
      });
    }),
  );

  r.post(
    '/:id/activate',
    requireRole('provider'),
    handle(async (req, res) => {
      const user = principal(req);
      const a = await load(String(req.params['id']), user);
      if (a.providerId !== user.id) throw forbidden();
      if (a.status !== 'proposed') throw new HttpError(409, `agreement is ${a.status}`);
      if (!a.deploymentCommitment) throw new HttpError(409, 'register the deployment first');
      const body = parse(activateSchema, req.body ?? {});
      const onChainId = body.onChainId ?? a.onChainId;
      const update = {
        status: 'active' as const,
        startMs: body.startMs ?? Date.now(),
        onChainId,
        tag: tagFor(a._id, onChainId),
        updatedAt: new Date(),
      };
      await agreements.updateOne({ _id: a._id }, { $set: update });
      res.json({ ...a, ...update });
    }),
  );

  /** Manually (re)queue a proof for a finished period; the scheduler does this automatically. */
  r.post(
    '/:id/periods/:period/prove',
    handle(async (req, res) => {
      const user = principal(req);
      const a = await load(String(req.params['id']), user);
      const period = Number(req.params['period']);
      if (a.status !== 'active' || a.startMs === undefined)
        throw new HttpError(409, 'agreement is not active');
      if (!Number.isInteger(period) || period < 0 || period >= a.terms.totalPeriods) {
        throw new HttpError(400, 'period out of range');
      }
      if (Date.now() < a.startMs + (period + 1) * a.terms.periodMs)
        throw new HttpError(409, 'period has not ended');

      const job: ProveSlaJob = { jobId: randomUUID(), agreementId: a._id, period, enqueuedAt: Date.now() };
      const claimed = await periods
        .findOneAndUpdate(
          { _id: `${a._id}:${period}`, status: { $nin: ['proving', 'proven', 'submitted'] } },
          {
            $set: {
              agreementId: a._id,
              period,
              status: 'queued',
              jobId: job.jobId,
              queuedAt: new Date(),
              updatedAt: new Date(),
            },
          },
          { upsert: true, returnDocument: 'after' },
        )
        .catch((err: { code?: number }) => {
          if (err.code === 11000) return null; // concurrent claim or already settled
          throw err;
        });
      if (!claimed) throw new HttpError(409, 'period already proven or in progress');
      broker.publish(QueueName.PROVE_SLA, job);
      res.status(202).json(job);
    }),
  );

  return r;
}
