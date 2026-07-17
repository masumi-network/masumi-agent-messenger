import { describe, expect, it } from 'vitest';
import { ExpiringSingleFlight } from '@/lib/expiring-single-flight';

describe('expiring single flight', () => {
  it('shares concurrent work and briefly reuses a successful result', async () => {
    let nowMs = 1_000;
    let calls = 0;
    let finish: (value: string) => void = () => {
      throw new Error('Refresh task did not start');
    };
    const singleFlight = new ExpiringSingleFlight<string>({
      ttlMs: 500,
      now: () => nowMs,
    });

    const first = singleFlight.run('token', () => {
      calls += 1;
      return new Promise(resolve => {
        finish = resolve;
      });
    });
    const concurrent = singleFlight.run('token', async () => {
      calls += 1;
      return 'unexpected';
    });

    expect(concurrent).toBe(first);
    expect(calls).toBe(0);
    await Promise.resolve();
    expect(calls).toBe(1);
    finish('refreshed');
    await expect(first).resolves.toBe('refreshed');
    await expect(concurrent).resolves.toBe('refreshed');

    await expect(
      singleFlight.run('token', async () => {
        calls += 1;
        return 'unexpected';
      })
    ).resolves.toBe('refreshed');
    expect(calls).toBe(1);

    nowMs += 501;
    await expect(
      singleFlight.run('token', async () => {
        calls += 1;
        return 'new refresh';
      })
    ).resolves.toBe('new refresh');
    expect(calls).toBe(2);
  });

  it('does not cache failed work', async () => {
    let calls = 0;
    const singleFlight = new ExpiringSingleFlight<string>({ ttlMs: 500 });

    await expect(
      singleFlight.run('token', async () => {
        calls += 1;
        throw new Error('refresh failed');
      })
    ).rejects.toThrow('refresh failed');

    await expect(
      singleFlight.run('token', async () => {
        calls += 1;
        return 'recovered';
      })
    ).resolves.toBe('recovered');
    expect(calls).toBe(2);
  });
});
