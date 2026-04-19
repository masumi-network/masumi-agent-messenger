import { describe, expect, it } from 'vitest';
import { getBirthdayCelebration } from './easter-eggs';

describe('getBirthdayCelebration', () => {
  it('triggers for Patrick email on April 12', () => {
    const result = getBirthdayCelebration({
      email: 'patrick.tobler@nmkr.io',
      now: new Date('2026-04-12T10:00:00Z'),
    });

    expect(result?.message).toBe('Happy Birthday Patrick!');
    expect(result?.fireworks.length).toBeGreaterThan(0);
  });

  it('triggers for Patrick display name on April 12', () => {
    const result = getBirthdayCelebration({
      displayName: 'Patrick Tobler',
      now: new Date('2026-04-12T10:00:00Z'),
    });

    expect(result?.message).toBe('Happy Birthday Patrick!');
  });

  it('triggers a late-birthday message on April 13', () => {
    const result = getBirthdayCelebration({
      email: 'patrick.tobler@nmkr.io',
      now: new Date('2026-04-13T10:00:00Z'),
    });

    expect(result?.message).toBe('Happy late birthday Patrick!');
    expect(result?.fireworks.length).toBeGreaterThan(0);
  });

  it('triggers a late-birthday message on April 14', () => {
    const result = getBirthdayCelebration({
      displayName: 'Patrick Tobler',
      now: new Date('2026-04-14T10:00:00Z'),
    });

    expect(result?.message).toBe('Happy late birthday Patrick!');
  });

  it('triggers a late-birthday message on April 15', () => {
    const result = getBirthdayCelebration({
      email: 'patrick@yellowhouse.gmbh',
      now: new Date('2026-04-15T10:00:00Z'),
    });

    expect(result?.message).toBe('Happy late birthday Patrick!');
  });

  it('triggers a late-birthday message on April 16', () => {
    const result = getBirthdayCelebration({
      displayName: 'Patrick Tobler',
      now: new Date('2026-04-16T10:00:00Z'),
    });

    expect(result?.message).toBe('Happy late birthday Patrick!');
  });

  it('does not trigger on other dates', () => {
    const result = getBirthdayCelebration({
      email: 'patrick@yellowhouse.gmbh',
      now: new Date('2026-04-17T10:00:00Z'),
    });

    expect(result).toBeNull();
  });
});
