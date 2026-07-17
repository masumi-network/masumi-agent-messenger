import { describe, expect, it } from 'vitest';
import {
  keyBundleMatchesAgentKeyPair,
  resolveExistingActorKeySource,
} from '@/lib/bootstrap-key-reconciliation';
import type { AgentKeyPair } from '@/lib/crypto';
import type { AgentKeyBundle } from '@/module_bindings/types';

function buildKeyPair(label: string): AgentKeyPair {
  return {
    encryption: {
      publicKey: `enc-public-${label}`,
      privateKey: `enc-private-${label}`,
      keyVersion: 1,
      algorithm: 'ECDH-P256',
    },
    signing: {
      publicKey: `sign-public-${label}`,
      privateKey: `sign-private-${label}`,
      keyVersion: 1,
      algorithm: 'ECDSA-P256-SHA256',
    },
  };
}

function buildBundle(keyPair: AgentKeyPair): AgentKeyBundle {
  return {
    id: 1n,
    agentDbId: 1n,
    keyBundleVersion: 1,
    encryptionAlgorithm: { tag: 'EcdhP256V1' },
    encryptionPublicKey: keyPair.encryption.publicKey,
    signingAlgorithm: { tag: 'EcdsaP256Sha256V1' },
    signingPublicKey: keyPair.signing.publicKey,
    createdAt: {} as AgentKeyBundle['createdAt'],
    updatedAt: {} as AgentKeyBundle['updatedAt'],
  };
}

describe('existing-agent bootstrap key reconciliation', () => {
  it('resumes a bootstrap whose pending keys were already published', () => {
    const pending = buildKeyPair('pending');
    const bundle = buildBundle(pending);

    expect(keyBundleMatchesAgentKeyPair(bundle, pending)).toBe(true);
    expect(
      resolveExistingActorKeySource({ bundle, pending, stored: null })
    ).toBe('pending');
  });

  it('uses the stored vault keys when pending setup material is stale', () => {
    const pending = buildKeyPair('stale');
    const stored = buildKeyPair('stored');
    const bundle = buildBundle(stored);

    expect(
      resolveExistingActorKeySource({ bundle, pending, stored })
    ).toBe('stored');
  });

  it('requires recovery instead of overwriting an existing key bundle', () => {
    const pending = buildKeyPair('stale');
    const stored = buildKeyPair('wrong');
    const bundle = buildBundle(buildKeyPair('published'));

    expect(
      resolveExistingActorKeySource({ bundle, pending, stored })
    ).toBe('missing');
  });
});
