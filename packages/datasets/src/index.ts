import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ECG_HEARTBEAT,
  GREEN_IOT_EDGE,
  HEALTHCARE_IOT,
  parseEcgHeartbeat,
  parseGreenIotEdge,
  parseHealthcareIot,
  type EdgeTaskRecord,
  type HeartbeatRecord,
  type VitalsRecord,
} from './kaggle.js';
import { syntheticEdgeTasks, syntheticHeartbeats, syntheticVitals } from './synthetic.js';

export * from './csv.js';
export * from './kaggle.js';
export * from './synthetic.js';

export type Source = 'kaggle' | 'synthetic';

export interface Datasets {
  vitals: { source: Source; records: VitalsRecord[] };
  heartbeats: { source: Source; records: HeartbeatRecord[] };
  edgeTasks: { source: Source; records: EdgeTaskRecord[] };
}

/**
 * Loads the Kaggle CSVs from `dir` (see scripts/fetch-kaggle.sh) and falls back
 * to schema-compatible synthetic data for any file that is missing.
 */
export function loadDatasets(dir?: string, { heartbeatLimit = 20_000 } = {}): Datasets {
  const file = (name: string) =>
    dir && existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : null;

  const vitalsCsv = file(HEALTHCARE_IOT.file);
  const beatsCsv = file(ECG_HEARTBEAT.files[0]);
  const edgeCsv = file(GREEN_IOT_EDGE.file);

  return {
    vitals: vitalsCsv
      ? { source: 'kaggle', records: parseHealthcareIot(vitalsCsv) }
      : { source: 'synthetic', records: syntheticVitals(500) },
    heartbeats: beatsCsv
      ? { source: 'kaggle', records: parseEcgHeartbeat(beatsCsv, heartbeatLimit) }
      : { source: 'synthetic', records: syntheticHeartbeats(2_000) },
    edgeTasks: edgeCsv
      ? { source: 'kaggle', records: parseGreenIotEdge(edgeCsv) }
      : { source: 'synthetic', records: syntheticEdgeTasks(3_000) },
  };
}

export interface EdgeNodeProfile {
  edgeNodeId: string;
  tasks: number;
  /** p95 network latency (ms), rounded up: the latency a provider can commit to. */
  latencyP95Ms: number;
  /** Mean free storage converted to GB for a nominal 2 TB node. */
  storageGb: number;
  /** Mean available CPU converted to millicores for a nominal 16-core node. */
  cpuMillicores: number;
  /** Indicative hourly price in micro-USD derived from power draw and QoS. */
  costMicroUsd: number;
  completionRate: number;
  meanQos: number;
}

const p95 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(0.95 * (s.length - 1)))] ?? 0;
};

/**
 * Aggregates Green IoT edge task records into per-node capability profiles.
 * These become the hidden figures behind negotiation offers (Scenario 2).
 */
export function edgeNodeProfiles(records: EdgeTaskRecord[]): EdgeNodeProfile[] {
  const byNode = new Map<string, EdgeTaskRecord[]>();
  for (const r of records) byNode.set(r.edgeNodeId, [...(byNode.get(r.edgeNodeId) ?? []), r]);
  return [...byNode.entries()]
    .map(([edgeNodeId, rs]) => {
      const mean = (f: (r: EdgeTaskRecord) => number) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
      const meanQos = mean((r) => r.qosScore);
      const power = mean((r) => r.powerConsumptionW);
      return {
        edgeNodeId,
        tasks: rs.length,
        latencyP95Ms: Math.ceil(p95(rs.map((r) => r.networkLatencyMs))),
        storageGb: Math.round(2048 * (1 - mean((r) => r.storageUtilizationPercent) / 100)),
        cpuMillicores: Math.round(16_000 * (mean((r) => r.availableCpuPercent) / 100)),
        costMicroUsd: Math.round(400_000 + power * 6_000 + meanQos * 500_000),
        completionRate: rs.filter((r) => r.completed).length / rs.length,
        meanQos,
      };
    })
    .sort((a, b) => a.edgeNodeId.localeCompare(b.edgeNodeId));
}
