// Edge intelligence: a compact ECG beat classifier and vital-sign rules that
// run on the edge node before anything is sent to the cloud.
import { ECG_HEARTBEAT, type HeartbeatRecord } from '@zk-sla/datasets';
import type { SensorKind } from '@zk-sla/shared-entities';

/**
 * Nearest-centroid classifier over MIT-BIH beats with int8-quantised centroids
 * (5 x 187 bytes), small enough for constrained gateways.
 */
export class EcgBeatClassifier {
  private constructor(
    private readonly centroids: Int8Array[],
    private readonly labels: number[],
  ) {}

  static train(beats: HeartbeatRecord[]): EcgBeatClassifier {
    const L = ECG_HEARTBEAT.beatLength;
    const sums = new Map<number, { sum: Float64Array; n: number }>();
    for (const b of beats) {
      const acc = sums.get(b.label) ?? { sum: new Float64Array(L), n: 0 };
      for (let i = 0; i < L; i++) acc.sum[i]! += b.signal[i] ?? 0;
      acc.n++;
      sums.set(b.label, acc);
    }
    const labels = [...sums.keys()].sort();
    const centroids = labels.map((label) => {
      const { sum, n } = sums.get(label)!;
      return Int8Array.from(sum, (v) => Math.round((v / n) * 127));
    });
    return new EcgBeatClassifier(centroids, labels);
  }

  classify(signal: readonly number[]): number {
    let best = 0;
    let bestDist = Infinity;
    this.centroids.forEach((c, k) => {
      let d = 0;
      for (let i = 0; i < c.length; i++) {
        const diff = (signal[i] ?? 0) * 127 - c[i]!;
        d += diff * diff;
      }
      if (d < bestDist) {
        bestDist = d;
        best = k;
      }
    });
    return this.labels[best]!;
  }

  accuracy(beats: HeartbeatRecord[]): number {
    if (!beats.length) return 0;
    return beats.filter((b) => this.classify(b.signal) === b.label).length / beats.length;
  }

  get sizeBytes() {
    return this.centroids.reduce((n, c) => n + c.byteLength, 0);
  }
}

/** Threshold rules for critical events detected locally (latency-critical alerts). */
export function vitalAnomaly(kind: SensorKind, value: number): string | undefined {
  switch (kind) {
    case 'temperature':
      return value >= 38 ? 'fever' : value < 35.5 ? 'hypothermia' : undefined;
    case 'blood_pressure':
      return value >= 160 ? 'hypertensive' : value < 90 ? 'hypotensive' : undefined;
    case 'spo2':
      return value < 90 ? 'desaturation' : undefined;
    case 'cgm':
      return value < 70 ? 'hypoglycaemia' : value > 250 ? 'hyperglycaemia' : undefined;
    default:
      return undefined;
  }
}

/**
 * Resource-aware sampling: devices with a depleted battery halve their
 * sampling rate (energy-saving mode), which the SLA availability term reflects.
 */
export function samplingIntervalSec(baseSec: number, battery: number, lowBatteryPercent: number) {
  return battery < lowBatteryPercent ? baseSec * 2 : baseSec;
}
