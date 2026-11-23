// Deterministic generators with the same shape and value ranges as the Kaggle
// datasets, used when the CSVs are not available (CI, demos, unit tests).
import { ECG_HEARTBEAT, type EdgeTaskRecord, type HeartbeatRecord, type VitalsRecord } from './kaggle.js';

export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

const pick = <T>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

/** Ranges follow healthcare_iot_target_dataset.csv (36.5–37.5 °C, 90–150 mmHg, 60–99 bpm). */
export function syntheticVitals(n: number, seed = 1, start = Date.UTC(2024, 0, 1)): VitalsRecord[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const systolic = pick(r, [90, 120, 130, 140, 150]);
    const battery = Math.round(80 + r() * 19);
    return {
      patientId: String(1000 + Math.floor(r() * 9000)),
      timestamp: start + i * 3_600_000,
      sensorId: String(1 + Math.floor(r() * 4)),
      sensorType: pick(r, ['Temperature', 'Blood Pressure', 'Heart Rate', 'Battery']),
      temperatureC: round(36.5 + r()),
      systolicMmHg: systolic,
      diastolicMmHg: systolic >= 140 ? pick(r, [90, 95]) : pick(r, [60, 80, 85]),
      heartRateBpm: Math.round(60 + r() * 39),
      deviceBatteryPercent: battery,
      targetHealthStatus: undefined,
      batteryPercent: battery,
    };
  });
}

/**
 * 187-sample beats at 125 Hz mimicking MIT-BIH morphologies: N = narrow QRS +
 * T wave, S = premature narrow beat, V = wide QRS without T wave, F = fused
 * medium-width beat, Q = low-amplitude paced/unclassifiable trace.
 */
export function syntheticHeartbeats(n: number, seed = 2, abnormalRate = 0.17): HeartbeatRecord[] {
  const r = rng(seed);
  const L = ECG_HEARTBEAT.beatLength;
  const shapes = [
    { width: 3, amp: 0.95, t: 0.3, tAt: 60, next: 110 }, // N
    { width: 3, amp: 0.9, t: 0.25, tAt: 45, next: 70 }, // S (premature: next beat early)
    { width: 12, amp: 1.0, t: 0.0, tAt: 60, next: 140 }, // V
    { width: 7, amp: 0.6, t: 0.15, tAt: 55, next: 115 }, // F
    { width: 2, amp: 0.35, t: 0.05, tAt: 60, next: 100 }, // Q
  ];
  return Array.from({ length: n }, () => {
    const label = r() < abnormalRate ? 1 + Math.floor(r() * 4) : 0;
    const s = shapes[label]!;
    const signal = Array.from({ length: L }, (_, t) => {
      const qrs = s.amp * Math.exp(-(t ** 2) / (2 * s.width ** 2));
      const tw = s.t * Math.exp(-((t - s.tAt) ** 2) / (2 * 10 ** 2));
      const nextBeat = 0.8 * s.amp * Math.exp(-((t - s.next) ** 2) / (2 * s.width ** 2));
      const noise = (r() - 0.5) * 0.04;
      return Math.max(0, Math.min(1, qrs + tw + nextBeat + noise + 0.05));
    });
    return { signal, label };
  });
}

/** Ranges follow Green_IoT_Edge_Resource_Allocation_Dataset.csv. */
export function syntheticEdgeTasks(n: number, seed = 3, nodes = 6): EdgeTaskRecord[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const node = Math.floor(r() * nodes);
    const base = 5 + node * 6;
    const latency = base + r() * 25;
    return {
      taskId: `T${i}`,
      edgeNodeId: `EN${String(node + 1).padStart(2, '0')}`,
      sensorType: pick(r, ['Temperature', 'Heart Rate', 'Camera', 'Humidity', 'Motion']),
      networkLatencyMs: round(latency, 2),
      responseTimeMs: round(latency + 20 + r() * 180, 2),
      packetLossPercent: round(r() * 5, 2),
      availableCpuPercent: round(20 + r() * 75, 2),
      availableRamMb: Math.round(512 + r() * 15_872),
      storageUtilizationPercent: round(10 + r() * 85, 2),
      batteryLevelPercent: round(15 + r() * 85, 2),
      powerConsumptionW: round(5 + r() * 95, 2),
      qosScore: round(0.4 + r() * 0.6, 3),
      completed: r() > 0.08,
      allocationDecision: pick(r, ['Local Edge', 'Neighbor Edge', 'Hybrid Edge', 'Cloud', 'Deferred']),
    };
  });
}
