import { describe, expect, test } from 'vitest';
import { median, percentile, pseudonymize, retry, seal, unseal } from '@zk-sla/shared-utils';

const KEY = 'a'.repeat(64);

describe('sealing', () => {
  test('round-trips JSON and uses a fresh IV each time', () => {
    const value = { deviceIds: ['ecg-01'], salt: '42' };
    const a = seal(value, KEY);
    expect(a).not.toEqual(seal(value, KEY));
    expect(unseal(a, KEY)).toEqual(value);
  });

  test('rejects tampered ciphertext and wrong keys', () => {
    const sealed = seal({ x: 1 }, KEY);
    const bytes = Buffer.from(sealed, 'base64');
    bytes[bytes.length - 1]! ^= 1;
    expect(() => unseal(bytes.toString('base64'), KEY)).toThrow();
    expect(() => unseal(sealed, 'b'.repeat(64))).toThrow();
  });
});

describe('pseudonymize', () => {
  test('is keyed, stable and 32 hex chars', () => {
    const ref = pseudonymize('ecg-ward-a-01', 'pepper-1');
    expect(ref).toMatch(/^[0-9a-f]{32}$/);
    expect(ref).toEqual(pseudonymize('ecg-ward-a-01', 'pepper-1'));
    expect(ref).not.toEqual(pseudonymize('ecg-ward-a-01', 'pepper-2'));
  });
});

describe('statistics', () => {
  test('percentiles interpolate', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([], 95)).toBeNull();
  });
});

describe('retry', () => {
  test('retries until success', async () => {
    let calls = 0;
    const out = await retry(async () => (++calls < 3 ? Promise.reject(new Error('no')) : 'ok'), {
      baseMs: 1,
    });
    expect(out).toBe('ok');
    expect(calls).toBe(3);
  });
});
