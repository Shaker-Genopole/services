import {
  CIRCUITS,
  InsufficientTelemetryError,
  buildNegotiationInput,
  buildSlaComplianceInput,
  deploymentSecrets,
  evaluateNegotiation,
  evaluateSla,
  type Offer,
  type Prover,
} from '@zk-sla/circuits';
import type {
  Agreement,
  DeploymentDescription,
  OfferRecord,
  ProveNegotiationJob,
  ProveResult,
  ProveSlaJob,
  RequestRecord,
} from '@zk-sla/shared-entities';
import { unseal, type Logger } from '@zk-sla/shared-utils';
import type { ExecutionReceipt } from '@zk-sla/sui-client';
import { summarisePeriod, type Sample } from './telemetry.js';

export interface Store {
  agreement(id: string): Promise<Agreement | null>;
  sealedDeployment(agreementId: string): Promise<string | null>;
  samples(agreementId: string, from: number, to: number): Promise<Sample[]>;
  request(id: string): Promise<RequestRecord | null>;
  offer(id: string): Promise<OfferRecord | null>;
  markProving(agreementId: string, period: number, jobId: string): Promise<void>;
}

export interface Chain {
  submitSlaProof(p: {
    agreementId: string;
    period: number;
    metricsCommitment: string;
    proofHex: string;
  }): Promise<ExecutionReceipt>;
  proveOffer(p: { requestId: string; offerId: string; proofHex: string }): Promise<ExecutionReceipt>;
}

export interface JobContext {
  workerId: string;
  prover: Prover;
  store: Store;
  sealKey: string;
  /** Present when the worker is configured with a Sui provider key and package IDs. */
  chain: Chain | null;
  logger: Logger;
}

const base = (ctx: JobContext, kind: ProveResult['kind'], enqueuedAt: number) => ({
  kind,
  workerId: ctx.workerId,
  enqueuedAt,
});

export async function runSlaJob(ctx: JobContext, job: ProveSlaJob): Promise<ProveResult> {
  const common = {
    ...base(ctx, 'sla', job.enqueuedAt),
    jobId: job.jobId,
    agreementId: job.agreementId,
    period: job.period,
  };
  const fail = (error: string, status: ProveResult['status'] = 'failed'): ProveResult => ({
    ...common,
    status,
    error,
    completedAt: Date.now(),
  });

  const agreement = await ctx.store.agreement(job.agreementId);
  if (!agreement || agreement.status !== 'active' || agreement.startMs === undefined) {
    return fail('agreement is not active');
  }
  const sealed = await ctx.store.sealedDeployment(agreement._id);
  if (!sealed) return fail('deployment not registered');
  await ctx.store.markProving(agreement._id, job.period, job.jobId);

  const deployment = unseal<DeploymentDescription>(sealed, ctx.sealKey);
  const from = agreement.startMs + job.period * agreement.terms.periodMs;
  const to = from + agreement.terms.periodMs;
  const telemetry = summarisePeriod(await ctx.store.samples(agreement._id, from, to), deployment, from, to);

  let input;
  try {
    input = buildSlaComplianceInput({
      slaTag: agreement.tag,
      periodId: job.period,
      terms: agreement.terms,
      telemetry,
      deployment: deploymentSecrets({ ...deployment, salt: BigInt(deployment.salt) }),
    });
  } catch (err) {
    if (err instanceof InsufficientTelemetryError) return fail(err.message, 'insufficient_data');
    throw err;
  }
  if (input.deploymentCommitment.toString() !== agreement.deploymentCommitment) {
    return fail('sealed deployment does not open the registered commitment');
  }

  const verdict = evaluateSla(input);
  if (!verdict.compliant) {
    // A violated SLA has no valid witness: nothing can be proven, the consumer may claim the penalty.
    ctx.logger.info({ agreementId: agreement._id, period: job.period, verdict }, 'period not compliant');
    return { ...common, status: 'non_compliant', verdict, completedAt: Date.now() };
  }

  const proof = await ctx.prover.prove(CIRCUITS.SLA_COMPLIANCE, input);
  const { valid, verifyMs } = await ctx.prover.verify(
    CIRCUITS.SLA_COMPLIANCE,
    proof.proof,
    proof.publicSignals,
  );
  if (!valid) return fail('locally generated proof failed verification');

  const result: ProveResult = {
    ...common,
    status: 'proven',
    verdict,
    provingMs: Math.round(proof.provingMs),
    verifyMs: Math.round(verifyMs * 10) / 10,
    proofSizeBytes: proof.sui.proofSizeBytes,
    publicSignals: proof.publicSignals,
    proofHex: proof.sui.proofHex,
    completedAt: Date.now(),
  };

  if (ctx.chain && agreement.onChainId) {
    const receipt = await ctx.chain.submitSlaProof({
      agreementId: agreement.onChainId,
      period: job.period,
      metricsCommitment: proof.publicSignals[0]!,
      proofHex: proof.sui.proofHex,
    });
    Object.assign(result, {
      status: receipt.success ? 'submitted' : 'failed',
      txDigest: receipt.digest,
      gasUsedMist: receipt.gasUsedMist,
      error: receipt.error,
      completedAt: Date.now(),
    });
  }
  return result;
}

export async function runNegotiationJob(ctx: JobContext, job: ProveNegotiationJob): Promise<ProveResult> {
  const common = {
    ...base(ctx, 'negotiation', job.enqueuedAt),
    jobId: job.jobId,
    requestId: job.requestId,
    offerId: job.offerId,
  };
  const [request, offer] = await Promise.all([
    ctx.store.request(job.requestId),
    ctx.store.offer(job.offerId),
  ]);
  if (!request || !offer)
    return { ...common, status: 'failed', error: 'request or offer not found', completedAt: Date.now() };

  const figures = unseal<Omit<Offer, 'salt'> & { salt: string }>(offer.sealed, ctx.sealKey);
  const hidden: Offer = { ...figures, salt: BigInt(figures.salt) };
  if (!evaluateNegotiation(hidden, request.constraints).satisfied) {
    return { ...common, status: 'non_compliant', completedAt: Date.now() };
  }
  const input = buildNegotiationInput({
    requestTag: request.tag,
    constraints: request.constraints,
    offer: hidden,
  });
  if (input['offerCommitment']!.toString() !== offer.commitment) {
    return {
      ...common,
      status: 'failed',
      error: 'sealed offer does not open its commitment',
      completedAt: Date.now(),
    };
  }
  const proof = await ctx.prover.prove(CIRCUITS.RESOURCE_NEGOTIATION, input);
  const { verifyMs } = await ctx.prover.verify(
    CIRCUITS.RESOURCE_NEGOTIATION,
    proof.proof,
    proof.publicSignals,
  );
  const result: ProveResult = {
    ...common,
    status: 'proven',
    provingMs: Math.round(proof.provingMs),
    verifyMs: Math.round(verifyMs * 10) / 10,
    proofSizeBytes: proof.sui.proofSizeBytes,
    publicSignals: proof.publicSignals,
    proofHex: proof.sui.proofHex,
    completedAt: Date.now(),
  };
  if (ctx.chain && request.onChainId && offer.onChainId) {
    const receipt = await ctx.chain.proveOffer({
      requestId: request.onChainId,
      offerId: offer.onChainId,
      proofHex: proof.sui.proofHex,
    });
    Object.assign(result, {
      status: receipt.success ? 'submitted' : 'failed',
      txDigest: receipt.digest,
      gasUsedMist: receipt.gasUsedMist,
      error: receipt.error,
    });
  }
  return result;
}
