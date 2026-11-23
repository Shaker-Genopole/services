import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { objectIdToTag, offerCommitment, randomScalar, toField } from '@zk-sla/circuits';
import { CollectionName, QueueName } from '@zk-sla/shared-configs';
import type { OfferRecord, ProveNegotiationJob, RequestRecord } from '@zk-sla/shared-entities';
import { seal } from '@zk-sla/shared-utils';
import { HttpError, forbidden, handle, notFound, parse, principal, requireRole } from '../http.js';
import type { Deps } from '../app.js';

const suiId = z.string().regex(/^0x[0-9a-f]{64}$/i);
const figure = z
  .number()
  .int()
  .min(0)
  .max(2 ** 48 - 1);

const offerSchema = z.object({
  label: z.string().min(2).max(120),
  storageGb: figure,
  latencyMs: figure,
  costMicroUsd: figure,
  cpuMillicores: figure,
  onChainId: suiId.optional(),
});

const constraintsSchema = z.object({
  minStorageGb: figure,
  maxLatencyMs: figure,
  maxCostMicroUsd: figure,
  minCpuMillicores: figure,
});

const requestSchema = z.object({ constraints: constraintsSchema, onChainId: suiId.optional() });

const publicOffer = ({ sealed: _, ...o }: OfferRecord) => o;

export function negotiationRoutes({ db, broker, cfg }: Deps): Router {
  const offers = db.collection<OfferRecord>(CollectionName.OFFERS);
  const requests = db.collection<RequestRecord>(CollectionName.REQUESTS);
  const r = Router();

  r.get(
    '/offers',
    handle(async (_req, res) => {
      res.json((await offers.find({ active: true }).sort({ createdAt: -1 }).toArray()).map(publicOffer));
    }),
  );

  /** Provider publishes an offer; the figures are sealed, only the commitment is public. */
  r.post(
    '/offers',
    requireRole('provider'),
    handle(async (req, res) => {
      const { label, onChainId, ...figures } = parse(offerSchema, req.body);
      const salt = randomScalar();
      const offer: OfferRecord = {
        _id: randomUUID(),
        onChainId,
        providerId: principal(req).id,
        label,
        commitment: offerCommitment({ ...figures, salt }).toString(),
        sealed: seal({ ...figures, salt: salt.toString() }, cfg.SEAL_KEY),
        active: true,
        createdAt: new Date(),
      };
      await offers.insertOne(offer);
      res.status(201).json(publicOffer(offer));
    }),
  );

  r.get(
    '/requests',
    handle(async (_req, res) => {
      res.json(await requests.find().sort({ createdAt: -1 }).limit(200).toArray());
    }),
  );

  r.post(
    '/requests',
    requireRole('consumer'),
    handle(async (req, res) => {
      const body = parse(requestSchema, req.body);
      const id = randomUUID();
      const request: RequestRecord = {
        _id: id,
        onChainId: body.onChainId,
        consumerId: principal(req).id,
        constraints: body.constraints,
        tag: (body.onChainId ? objectIdToTag(body.onChainId) : toField(`request:${id}`) >> 2n).toString(),
        status: 'open',
        candidates: [],
        createdAt: new Date(),
      };
      await requests.insertOne(request);
      res.status(201).json(request);
    }),
  );

  /** Provider asks its prover to qualify one of its offers for a request. */
  r.post(
    '/requests/:id/qualify',
    requireRole('provider'),
    handle(async (req, res) => {
      const { offerId } = parse(z.object({ offerId: z.string() }), req.body);
      const [request, offer] = await Promise.all([
        requests.findOne({ _id: String(req.params['id']) }),
        offers.findOne({ _id: offerId }),
      ]);
      if (!request) throw notFound('request');
      if (!offer || !offer.active) throw notFound('offer');
      if (offer.providerId !== principal(req).id) throw forbidden();
      if (request.status !== 'open') throw new HttpError(409, 'request is not open');
      if (request.candidates.some((c) => c.offerId === offerId))
        throw new HttpError(409, 'offer already qualified');
      const job: ProveNegotiationJob = {
        jobId: randomUUID(),
        requestId: request._id,
        offerId,
        enqueuedAt: Date.now(),
      };
      broker.publish(QueueName.PROVE_NEGOTIATION, job);
      res.status(202).json(job);
    }),
  );

  r.post(
    '/requests/:id/select',
    requireRole('consumer'),
    handle(async (req, res) => {
      const { offerId } = parse(z.object({ offerId: z.string() }), req.body);
      const request = await requests.findOne({ _id: String(req.params['id']) });
      if (!request) throw notFound('request');
      if (request.consumerId !== principal(req).id) throw forbidden();
      if (request.status !== 'open') throw new HttpError(409, 'request is not open');
      const candidate = request.candidates.find((c) => c.offerId === offerId);
      if (!candidate) throw new HttpError(409, 'offer is not a qualified candidate');
      await requests.updateOne(
        { _id: request._id },
        { $set: { status: 'matched', selectedOfferId: offerId } },
      );
      res.json({ requestId: request._id, offerId, providerId: candidate.providerId });
    }),
  );

  return r;
}
