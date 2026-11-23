import { Router } from 'express';
import { z } from 'zod';
import { CollectionName } from '@zk-sla/shared-configs';
import type {
  Agreement,
  DeviceRecord,
  PeriodRecord,
  ProofRecord,
  TelemetryAlert,
  TelemetryDocument,
  WorkerHeartbeat,
} from '@zk-sla/shared-entities';
import { mean, median, percentile } from '@zk-sla/shared-utils';
import { forbidden, handle, notFound, parse, principal, type Principal } from '../http.js';
import type { Deps } from '../app.js';

const listQuery = z.object({
  agreementId: z.string().optional(),
  kind: z.enum(['sla', 'negotiation']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const windowQuery = z.object({
  agreementId: z.string(),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
});

const round = (v: number | null, d = 0) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

/** Proofs, telemetry, devices, alerts and the evaluation KPIs of the research proposal. */
export function observabilityRoutes({ db }: Deps): Router {
  const agreements = db.collection<Agreement>(CollectionName.AGREEMENTS);
  const proofs = db.collection<ProofRecord>(CollectionName.PROOFS);
  const periods = db.collection<PeriodRecord>(CollectionName.PERIODS);
  const telemetry = db.collection<TelemetryDocument>(CollectionName.TELEMETRY);
  const devices = db.collection<DeviceRecord>(CollectionName.DEVICES);
  const alerts = db.collection<TelemetryAlert & { _id: string; receivedAt: Date }>(CollectionName.ALERTS);
  const workers = db.collection<WorkerHeartbeat & { _id: string; lastSeen: Date }>(CollectionName.WORKERS);
  const r = Router();

  const visibleAgreementIds = async (user: Principal) =>
    user.role === 'admin'
      ? null
      : (
          await agreements
            .find({ $or: [{ consumerId: user.id }, { providerId: user.id }] }, { projection: { _id: 1 } })
            .toArray()
        ).map((a) => a._id);

  const assertVisible = async (user: Principal, agreementId: string) => {
    const a = await agreements.findOne({ _id: agreementId });
    if (!a) throw notFound('agreement');
    if (user.role !== 'admin' && a.consumerId !== user.id && a.providerId !== user.id) throw forbidden();
  };

  r.get(
    '/proofs',
    handle(async (req, res) => {
      const q = parse(listQuery, req.query);
      const ids = await visibleAgreementIds(principal(req));
      const filter: Record<string, unknown> = {};
      if (q.kind) filter['kind'] = q.kind;
      if (q.agreementId) filter['agreementId'] = q.agreementId;
      if (ids && q.kind !== 'negotiation')
        filter['$or'] = [{ agreementId: { $in: ids } }, { kind: 'negotiation' }];
      res.json(
        await proofs
          .find(filter, { projection: { proofHex: 0 } })
          .sort({ completedAt: -1 })
          .limit(q.limit)
          .toArray(),
      );
    }),
  );

  r.get(
    '/proofs/:id',
    handle(async (req, res) => {
      const proof = await proofs.findOne({ _id: String(req.params['id']) });
      if (!proof) throw notFound('proof');
      if (proof.agreementId) await assertVisible(principal(req), proof.agreementId);
      res.json(proof);
    }),
  );

  r.get(
    '/devices',
    handle(async (req, res) => {
      const { agreementId } = parse(windowQuery.pick({ agreementId: true }), req.query);
      await assertVisible(principal(req), agreementId);
      res.json(await devices.find({ agreementId }).toArray());
    }),
  );

  r.get(
    '/alerts',
    handle(async (req, res) => {
      const { agreementId } = parse(windowQuery.pick({ agreementId: true }), req.query);
      await assertVisible(principal(req), agreementId);
      res.json(await alerts.find({ agreementId }).sort({ sampledAt: -1 }).limit(200).toArray());
    }),
  );

  r.get(
    '/telemetry/summary',
    handle(async (req, res) => {
      const q = parse(windowQuery, req.query);
      await assertVisible(principal(req), q.agreementId);
      const to = q.to ?? Date.now();
      const from = q.from ?? to - 3_600_000;
      const docs = await telemetry
        .find(
          { 'meta.agreementId': q.agreementId, ts: { $gte: new Date(from), $lt: new Date(to) } },
          { projection: { latencyMs: 1, 'meta.kind': 1, anomaly: 1 } },
        )
        .toArray();
      const byKind: Record<string, number> = {};
      for (const d of docs) byKind[d.meta.kind] = (byKind[d.meta.kind] ?? 0) + 1;
      const latencies = docs.map((d) => d.latencyMs);
      res.json({
        from,
        to,
        samples: docs.length,
        byKind,
        anomalies: docs.filter((d) => d.anomaly).length,
        latencyMs: {
          p50: round(median(latencies)),
          p95: round(percentile(latencies, 95)),
          max: latencies.length ? Math.max(...latencies) : null,
        },
      });
    }),
  );

  /** Evaluation KPIs (proposal table): proof generation / verification time, proof size, SLA compliance, latency, gas. */
  r.get(
    '/kpis',
    handle(async (req, res) => {
      const ids = await visibleAgreementIds(principal(req));
      const scope = ids ? { agreementId: { $in: ids } } : {};
      const since = new Date(Date.now() - 24 * 3_600_000);
      const [proofDocs, periodDocs, latencyDocs, liveWorkers, alertCount] = await Promise.all([
        proofs
          .find({ ...scope, kind: 'sla' }, { projection: { proofHex: 0, publicSignals: 0 } })
          .sort({ completedAt: -1 })
          .limit(1000)
          .toArray(),
        periods.find(scope).toArray(),
        telemetry
          .find(
            { ...(ids ? { 'meta.agreementId': { $in: ids } } : {}), ts: { $gte: since } },
            { projection: { latencyMs: 1 } },
          )
          .limit(50_000)
          .toArray(),
        workers.countDocuments({ lastSeen: { $gte: new Date(Date.now() - 60_000) } }),
        alerts.countDocuments({ ...(ids ? { agreementId: { $in: ids } } : {}), receivedAt: { $gte: since } }),
      ]);
      const ok = proofDocs.filter((p) => p.status === 'proven' || p.status === 'submitted');
      const settled = periodDocs.filter((p) =>
        ['proven', 'submitted', 'non_compliant', 'violated'].includes(p.status),
      );
      const compliant = settled.filter((p) => p.status === 'proven' || p.status === 'submitted');
      const gas = ok.map((p) => p.gasUsedMist).filter((g): g is number => typeof g === 'number' && g > 0);
      const nums = (f: (p: ProofRecord) => number | undefined) =>
        ok.map(f).filter((v): v is number => typeof v === 'number');
      res.json({
        zkProofGenerationMs: {
          median: round(median(nums((p) => p.provingMs))),
          p95: round(
            percentile(
              nums((p) => p.provingMs),
              95,
            ),
          ),
        },
        zkVerificationMs: { median: round(median(nums((p) => p.verifyMs)), 1) },
        proofSizeBytes: ok[0]?.proofSizeBytes ?? null,
        slaComplianceRate: settled.length ? round(compliant.length / settled.length, 4) : null,
        settledPeriods: settled.length,
        endToEndProofLatencyMs: { median: round(median(nums((p) => p.endToEndMs))) },
        telemetryLatencyMs: {
          median: round(median(latencyDocs.map((d) => d.latencyMs))),
          p95: round(
            percentile(
              latencyDocs.map((d) => d.latencyMs),
              95,
            ),
          ),
        },
        gasPerProofSui: gas.length ? round(mean(gas)! / 1e9, 6) : null,
        failedJobs: proofDocs.filter((p) => p.status === 'failed').length,
        activeProverWorkers: liveWorkers,
        alertsLast24h: alertCount,
      });
    }),
  );

  return r;
}
