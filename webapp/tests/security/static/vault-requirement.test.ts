import { describe, expect, it } from 'vitest';
import { describeLocalVaultRequirement } from '@/lib/app-shell';

describe('local vault requirement messaging', () => {
  it('asks to unlock when the vault already exists', () => {
    expect(
      describeLocalVaultRequirement({
        initialized: true,
        phrase: 'to load private keys for this inbox',
      })
    ).toBe('Unlock the local key vault to load private keys for this inbox.');
  });

  it('asks to create a vault when none exists yet', () => {
    expect(
      describeLocalVaultRequirement({
        initialized: false,
        phrase: 'to load private keys for this inbox',
      })
    ).toBe('Create a local key vault to load private keys for this inbox.');
  });
});
