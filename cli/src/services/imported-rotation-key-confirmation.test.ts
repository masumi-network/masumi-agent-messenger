import { describe, expect, it } from 'vitest';
import type { AgentKeyPair } from '../../../shared/agent-crypto';
import type { DeviceKeyShareSnapshot, SharedActorKeyMaterial } from '../../../shared/device-sharing';
import {
  confirmImportedRotationKeyInStore,
  emptyImportedRotationKeyConfirmationStore,
  getImportedRotationKeyConfirmationStatusFromStore,
  markImportedRotationSnapshotPendingInStore,
  parseImportedRotationKeyConfirmationStore,
  sameAgentKeyPairPublicTuple,
} from '../../../shared/imported-rotation-key-confirmation';

function createKeyPair(suffix: string): AgentKeyPair {
  return {
    encryption: {
      publicKey: `enc-pub-${suffix}`,
      privateKey: `enc-priv-${suffix}`,
      keyVersion: 1,
      algorithm: 'ecdh-p256-v1',
    },
    signing: {
      publicKey: `sig-pub-${suffix}`,
      privateKey: `sig-priv-${suffix}`,
      keyVersion: 1,
      algorithm: 'ecdsa-p256-sha256-v1',
    },
  };
}

function createActor(current: AgentKeyPair): SharedActorKeyMaterial {
  return {
    identity: {
      email: 'agent@example.com',
      slug: 'agent',
    },
    current,
    archived: [],
  };
}

function createSnapshot(actor: SharedActorKeyMaterial): DeviceKeyShareSnapshot {
  return {
    version: 1,
    email: actor.identity.email,
    createdAt: '2026-04-21T00:00:00.000Z',
    actors: [actor],
  };
}

describe('imported rotation key confirmation store', () => {
  it('marks newly imported automatic rotation keys as pending', () => {
    const keyPair = createKeyPair('new');
    const actor = createActor(keyPair);
    const result = markImportedRotationSnapshotPendingInStore({
      store: emptyImportedRotationKeyConfirmationStore(),
      snapshot: createSnapshot(actor),
      importedAt: '2026-04-21T00:00:00.000Z',
    });

    expect(result.pendingCount).toBe(1);
    expect(result.changed).toBe(true);
    expect(
      getImportedRotationKeyConfirmationStatusFromStore(
        result.store,
        actor.identity,
        keyPair
      ).status
    ).toBe('pending');
  });

  it('skips keys that were already the local current keys', () => {
    const keyPair = createKeyPair('known');
    const actor = createActor(keyPair);
    const result = markImportedRotationSnapshotPendingInStore({
      store: emptyImportedRotationKeyConfirmationStore(),
      snapshot: createSnapshot(actor),
      importedAt: '2026-04-21T00:00:00.000Z',
      isKnownCurrent: candidate => sameAgentKeyPairPublicTuple(keyPair, candidate.current),
    });

    expect(result.pendingCount).toBe(0);
    expect(result.changed).toBe(false);
  });

  it('does not reopen a key pair that was already confirmed locally', () => {
    const keyPair = createKeyPair('confirmed');
    const actor = createActor(keyPair);
    const confirmed = confirmImportedRotationKeyInStore({
      store: emptyImportedRotationKeyConfirmationStore(),
      identity: actor.identity,
      keyPair,
      now: '2026-04-21T00:01:00.000Z',
    });

    const result = markImportedRotationSnapshotPendingInStore({
      store: confirmed.store,
      snapshot: createSnapshot(actor),
      importedAt: '2026-04-21T00:02:00.000Z',
    });

    expect(result.pendingCount).toBe(0);
    expect(
      getImportedRotationKeyConfirmationStatusFromStore(
        result.store,
        actor.identity,
        keyPair
      ).status
    ).toBe('confirmed');
  });

  it('normalizes legacy key versions in the confirmation store', () => {
    const keyPair = createKeyPair('legacy');
    const store = parseImportedRotationKeyConfirmationStore({
      version: 1,
      records: [
        {
          email: 'agent@example.com',
          slug: 'agent',
          encryptionPublicKey: keyPair.encryption.publicKey,
          encryptionKeyVersion: 'enc-v1',
          signingPublicKey: keyPair.signing.publicKey,
          signingKeyVersion: 0,
          importedAt: '2026-04-21T00:00:00.000Z',
        },
      ],
    });

    expect(store.records[0]?.encryptionKeyVersion).toBe(1);
    expect(store.records[0]?.signingKeyVersion).toBe(1);
    expect(
      getImportedRotationKeyConfirmationStatusFromStore(
        store,
        {
          email: 'agent@example.com',
          slug: 'agent',
        },
        keyPair
      ).status
    ).toBe('pending');
  });

  it('accepts legacy identity fields in the confirmation store', () => {
    const keyPair = createKeyPair('legacy-identity');
    const store = parseImportedRotationKeyConfirmationStore({
      version: 1,
      records: [
        {
          normalizedEmail: 'AGENT@EXAMPLE.COM',
          slug: 'Agent',
          inboxIdentifier: 'legacy-account',
          encryptionPublicKey: keyPair.encryption.publicKey,
          encryptionKeyVersion: keyPair.encryption.keyVersion,
          signingPublicKey: keyPair.signing.publicKey,
          signingKeyVersion: keyPair.signing.keyVersion,
          importedAt: '2026-04-21T00:00:00.000Z',
          confirmedAt: null,
        },
      ],
    });

    expect(store.records[0]).toMatchObject({
      email: 'agent@example.com',
      slug: 'agent',
      accountIdentifier: 'legacy-account',
    });
    expect(
      getImportedRotationKeyConfirmationStatusFromStore(
        store,
        {
          email: 'agent@example.com',
          slug: 'agent',
        },
        keyPair
      ).status
    ).toBe('pending');
  });

  it('ignores null legacy optional identifiers in the confirmation store', () => {
    const keyPair = createKeyPair('legacy-null-identity');
    const store = parseImportedRotationKeyConfirmationStore({
      version: 1,
      records: [
        {
          normalizedEmail: 'agent@example.com',
          slug: 'agent',
          inboxIdentifier: null,
          encryptionPublicKey: keyPair.encryption.publicKey,
          encryptionKeyVersion: keyPair.encryption.keyVersion,
          signingPublicKey: keyPair.signing.publicKey,
          signingKeyVersion: keyPair.signing.keyVersion,
          importedAt: '2026-04-21T00:00:00.000Z',
        },
      ],
    });

    expect(store.records[0]?.accountIdentifier).toBeUndefined();
  });
});
