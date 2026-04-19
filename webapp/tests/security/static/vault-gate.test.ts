import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { VaultGate } from '@/components/app/vault-gate';
import type { UseKeyVaultResult } from '@/hooks/use-key-vault';

function createVaultState(
  overrides: Partial<UseKeyVaultResult>
): UseKeyVaultResult {
  return {
    owner: null,
    initialized: false,
    unlocked: false,
    loading: false,
    submitting: false,
    error: null,
    handleSubmit: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('VaultGate', () => {
  it('renders the create-vault flow when no local vault exists yet', () => {
    const html = renderToStaticMarkup(
      createElement(
        VaultGate,
        {
          vault: createVaultState({ initialized: false, unlocked: false }),
          children: createElement('div', null, 'Unlocked content'),
        }
      )
    );

    expect(html).toContain('Create Private Key Vault');
    expect(html).toContain('Create vault');
    expect(html).not.toContain('Unlocked content');
  });

  it('renders the unlock flow when a local vault already exists', () => {
    const html = renderToStaticMarkup(
      createElement(
        VaultGate,
        {
          vault: createVaultState({ initialized: true, unlocked: false }),
          children: createElement('div', null, 'Unlocked content'),
        }
      )
    );

    expect(html).toContain('Unlock Private Keys');
    expect(html).toContain('Unlock keys');
    expect(html).not.toContain('Unlocked content');
  });

  it('renders children once the vault is unlocked', () => {
    const html = renderToStaticMarkup(
      createElement(
        VaultGate,
        {
          vault: createVaultState({ initialized: true, unlocked: true }),
          children: createElement('div', null, 'Unlocked content'),
        }
      )
    );

    expect(html).toContain('Unlocked content');
    expect(html).not.toContain('Unlock Private Keys');
  });
});
