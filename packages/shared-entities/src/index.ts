// Domain model shared by every service. No raw patient or device identifiers
// appear here: devices are referenced by keyed pseudonyms (`deviceRef`) and the
// deployment description is only stored sealed.

export type Role = 'consumer' | 'provider' | 'admin';

export interface Account {
  _id: string;
  email: string;
  passwordHash: string;
  role: Role;
  organisation: string;
  suiAddress?: string;
  createdAt: Date;
}

export type SensorKind = 'ecg' | 'cgm' | 'temperature' | 'spo2' | 'blood_pressure' | 'camera';

export interface SlaTerms {
  maxLatencyMs: number;
  latencyQuorumBp: number;
  minAvailabilityBp: number;
  maxIntervalSec: number;
  periodMs: number;
  totalPeriods: number;
  graceMs: number;
  rewardPerPeriod: number;
  penaltyPerPeriod: number;
}

export type AgreementStatus = 'proposed' | 'active' | 'closed' | 'cancelled';

export interface Agreement {
  _id: string;
  /** Sui object ID once the agreement exists on chain. */
  onChainId?: string;
  title: string;
  consumerId: string;
  providerId: string;
  terms: SlaTerms;
  status: AgreementStatus;
  startMs?: number;
  /** Public-input tag (decimal string), derived from `onChainId` or the local ID. */
  tag: string;
  deploymentCommitment?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type PeriodStatus =
  | 'queued'
  | 'proving'
  | 'proven'
  | 'submitted'
  | 'non_compliant'
  | 'insufficient_data'
  | 'violated'
  | 'failed';

export interface SlaVerdict {
  compliant: boolean;
  checks: { latencyQuorum: boolean; updateInterval: boolean; availability: boolean };
  observed: { latencyWithinBp: number; maxIntervalSec: number; availabilityBp: number };
}

export interface PeriodRecord {
  _id: string; // `${agreementId}:${period}`
  agreementId: string;
  period: number;
  status: PeriodStatus;
  jobId?: string;
  verdict?: SlaVerdict;
  metricsCommitment?: string;
  txDigest?: string;
  queuedAt?: Date;
  updatedAt: Date;
}

/** Plain deployment description; only ever persisted sealed. */
export interface DeploymentDescription {
  deviceIds: string[];
  locations: string[];
  sensorConfig: Record<string, unknown>;
  devices: Array<{ deviceRef: string; kind: SensorKind; expectedIntervalSec: number }>;
  salt: string;
}

export interface DeploymentRecord {
  _id: string; // agreement ID
  sealed: string;
  commitment: string;
  deviceCount: number;
  createdAt: Date;
}

export interface DeviceRecord {
  _id: string; // deviceRef pseudonym
  agreementId: string;
  kind: SensorKind;
  edgeNodeId: string;
  expectedIntervalSec: number;
  registeredAt: Date;
}

export interface TelemetryReading {
  agreementId: string;
  deviceRef: string;
  kind: SensorKind;
  /** Time the sample was taken at the sensor (ms since epoch). */
  sampledAt: number;
  value: number;
  /** Edge-side inference flag (fall, arrhythmia, threshold violation …). */
  anomaly?: string;
  /** Battery level reported by the device, 0-100. */
  battery?: number;
}

export interface TelemetryBatch {
  edgeNodeId: string;
  sentAt: number;
  readings: TelemetryReading[];
}

export interface TelemetryDocument {
  ts: Date;
  meta: { agreementId: string; deviceRef: string; kind: SensorKind; edgeNodeId: string };
  value: number;
  /** End-to-end sensor-to-cloud latency measured at ingest. */
  latencyMs: number;
  anomaly?: string;
  battery?: number;
}

export interface TelemetryAlert {
  agreementId: string;
  deviceRef: string;
  kind: SensorKind;
  anomaly: string;
  value: number;
  sampledAt: number;
  edgeNodeId: string;
}

export interface ProveSlaJob {
  jobId: string;
  agreementId: string;
  period: number;
  enqueuedAt: number;
}

export interface ProveNegotiationJob {
  jobId: string;
  requestId: string;
  offerId: string;
  enqueuedAt: number;
}

export type ProofStatus = 'proven' | 'submitted' | 'non_compliant' | 'insufficient_data' | 'failed';

export interface ProveResult {
  jobId: string;
  kind: 'sla' | 'negotiation';
  status: ProofStatus;
  agreementId?: string;
  period?: number;
  requestId?: string;
  offerId?: string;
  workerId: string;
  provingMs?: number;
  verifyMs?: number;
  proofSizeBytes?: number;
  publicSignals?: string[];
  proofHex?: string;
  verdict?: SlaVerdict;
  txDigest?: string;
  gasUsedMist?: number;
  error?: string;
  enqueuedAt: number;
  completedAt: number;
}

export interface ProofRecord extends Omit<ProveResult, 'jobId'> {
  _id: string;
  endToEndMs: number;
}

export interface ResourceConstraints {
  minStorageGb: number;
  maxLatencyMs: number;
  maxCostMicroUsd: number;
  minCpuMillicores: number;
}

export interface OfferRecord {
  _id: string;
  onChainId?: string;
  providerId: string;
  label: string;
  commitment: string;
  /** Sealed {storageGb, latencyMs, costMicroUsd, cpuMillicores, salt}. */
  sealed: string;
  active: boolean;
  createdAt: Date;
}

export interface RequestRecord {
  _id: string;
  onChainId?: string;
  consumerId: string;
  constraints: ResourceConstraints;
  tag: string;
  status: 'open' | 'matched' | 'cancelled';
  candidates: Array<{ offerId: string; providerId: string; qualifiedAt: Date; txDigest?: string }>;
  selectedOfferId?: string;
  createdAt: Date;
}

export interface WorkerHeartbeat {
  workerId: string;
  kind: 'prover';
  busy: boolean;
  processed: number;
  failed: number;
  sentAt: number;
}
