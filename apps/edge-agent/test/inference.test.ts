import { describe, expect, test } from 'vitest';
import { syntheticHeartbeats } from '@zk-sla/datasets';
import { EcgBeatClassifier, samplingIntervalSec, vitalAnomaly } from '../src/inference.js';

describe('ECG beat classifier', () => {
  test('detects abnormal beats with a sub-kilobyte int8 model', () => {
    const beats = syntheticHeartbeats(3_000, 11, 0.3);
    const model = EcgBeatClassifier.train(beats.slice(0, 2_400));
    const holdout = beats.slice(2_400);
    expect(model.sizeBytes).toBeLessThan(1024);
    expect(model.accuracy(holdout)).toBeGreaterThan(0.95);
    const detected = holdout.filter((b) => (model.classify(b.signal) !== 0) === (b.label !== 0)).length;
    expect(detected / holdout.length).toBeGreaterThan(0.97);
  });
});

describe('vital-sign rules', () => {
  test('flag critical thresholds only', () => {
    expect(vitalAnomaly('temperature', 38.4)).toBe('fever');
    expect(vitalAnomaly('temperature', 36.9)).toBeUndefined();
    expect(vitalAnomaly('spo2', 88)).toBe('desaturation');
    expect(vitalAnomaly('cgm', 62)).toBe('hypoglycaemia');
    expect(vitalAnomaly('blood_pressure', 165)).toBe('hypertensive');
  });
});

describe('resource-aware sampling', () => {
  test('halves the sampling rate on low battery', () => {
    expect(samplingIntervalSec(2, 50, 20)).toBe(2);
    expect(samplingIntervalSec(2, 10, 20)).toBe(4);
  });
});
