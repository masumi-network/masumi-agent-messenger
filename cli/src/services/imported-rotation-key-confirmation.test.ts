import { describe, expect, it } from 'vitest';
import type { AgentKeyPair } from '../../../shared/agent-crypto';
import type { DeviceKeyShareSnapshot, SharedActorKeyMaterial } from '../../../shared/device-sharing';
import {
  confirmImportedRotationKeyInStore,
  emptyImportedRotationKeyConfirmationStore,
  getImportedRotationKeyConfirmationStatusFromStore,
  markImportedRotationSnapshotPendingInStore,
  sameAgentKeyPairPublicTuple,
} from '../../../shared/imported-rotation-key-confirmation';

function createKeyPair(suffix: string): AgentKeyPair {
  return {
    encryption: {
      publicKey: `enc-pub-${suffix}`,
      privateKey: `enc-priv-${suffix}`,
      keyVersion: `enc-${suffix}`,
      algorithm: 'ecdh-p256-v1',
    },
    signing: {
      publicKey: `sig-pub-${suffix}`,
      privateKey: `sig-priv-${suffix}`,
      keyVersion: `sig-${suffix}`,
      algorithm: 'ecdsa-p256-sha256-v1',
    },
  };
}

function createActor(current: AgentKeyPair): SharedActorKeyMaterial {
  return {
    identity: {
      normalizedEmail: 'agent@example.com',
      slug: 'agent',
    },
    current,
    archived: [],
  };
}

function createSnapshot(actor: SharedActorKeyMaterial): DeviceKeyShareSnapshot {
  return {
    version: 1,
    normalizedEmail: actor.identity.normalizedEmail,
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
});
