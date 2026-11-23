import { rng, type Datasets } from '@zk-sla/datasets';
import type { SensorKind, TelemetryReading } from '@zk-sla/shared-entities';
import { pseudonymize } from '@zk-sla/shared-utils';
import { EcgBeatClassifier, vitalAnomaly } from './inference.js';

export interface DeviceSpec {
  deviceId: string;
  kind: SensorKind;
  intervalSec: number;
}

/** Replays a Kaggle-derived stream for one device and runs local inference on it. */
export class SimulatedDevice {
  readonly deviceRef: string;
  battery: number;
  private cursor = 0;
  private readonly random: () => number;

  constructor(
    readonly spec: DeviceSpec,
    private readonly data: Datasets,
    private readonly classifier: EcgBeatClassifier,
    pseudonymKey: string,
    seed: number,
    /** Battery drain per sample in percentage points. */
    private readonly drain = 0.002,
  ) {
    this.deviceRef = pseudonymize(spec.deviceId, pseudonymKey);
    this.random = rng(seed);
    const v = data.vitals.records;
    this.battery = v.length ? v[seed % v.length]!.deviceBatteryPercent : 100;
  }

  sample(agreementId: string, now: number): TelemetryReading {
    const i = this.cursor++;
    this.battery = Math.max(0, this.battery - this.drain);
    const { value, anomaly } = this.read(i);
    return {
      agreementId,
      deviceRef: this.deviceRef,
      kind: this.spec.kind,
      sampledAt: now,
      value,
      ...(anomaly ? { anomaly } : {}),
      battery: Math.round(this.battery * 10) / 10,
    };
  }

  private read(i: number): { value: number; anomaly?: string } {
    const vitals = this.data.vitals.records;
    const vital = vitals[i % Math.max(1, vitals.length)];
    switch (this.spec.kind) {
      case 'ecg': {
        const beats = this.data.heartbeats.records;
        const beat = beats[i % beats.length]!;
        const label = this.classifier.classify(beat.signal);
        return { value: label, anomaly: label === 0 ? undefined : `arrhythmia:${'NSVFQ'[label]}` };
      }
      case 'temperature': {
        const value = vital?.temperatureC ?? 36.8;
        return { value, anomaly: vitalAnomaly('temperature', value) };
      }
      case 'blood_pressure': {
        const value = vital?.systolicMmHg ?? 120;
        return { value, anomaly: vitalAnomaly('blood_pressure', value) };
      }
      case 'spo2': {
        const value = Math.round(93 + this.random() * 7);
        return { value, anomaly: vitalAnomaly('spo2', value) };
      }
      case 'cgm': {
        const value = Math.round(90 + 60 * Math.sin(i / 20) + this.random() * 20);
        return { value, anomaly: vitalAnomaly('cgm', value) };
      }
      case 'camera': {
        const fall = this.random() < 0.002;
        return { value: fall ? 1 : 0, anomaly: fall ? 'fall' : undefined };
      }
    }
  }
}
