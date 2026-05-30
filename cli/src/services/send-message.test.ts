import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'spacetimedb';
import {
  generateAgentKeyPair,
  prepareEncryptedMessage,
} from '../../../shared/agent-crypto';
import { fromHex } from '../../../shared/crypto-utils';
import type { DbConnection } from '../../../webapp/src/module_bindings';
import type { Agent, ThreadSecretEnvelope } from '../../../webapp/src/module_bindings/types';
import {
  isDeregisteringOrDeregisteredInboxAgentState,
  isFailedRegistrationInboxAgentState,
} from '../../../shared/inbox-agent-registration';
import type { PeerKeyTrustStore, PeerKeyTuple } from '../../../shared/peer-key-trust';
import { isCliError } from './errors';
import { pinFirstObservation } from './peer-key-trust';
import { requirePeerKeyTrust, resolveExistingSenderSecret } from './send-message';

// These `p256-ecdh-public:v1:alice:N` strings are arbitrary fixture-only public-key bytes.
// They are NOT instances of the deleted prefix-string key-version scheme — real key
// versions are numeric `u32` (`encryptionKeyVersion`/`signingKeyVersion` below).
const tupleA: PeerKeyTuple = {
  encryptionPublicKey: 'p256-ecdh-public:v1:alice:1',
  encryptionKeyVersion: 1,
  signingPublicKey: 'p256-ecdsa-public:v1:alice:1',
  signingKeyVersion: 1,
};

const tupleARotated: PeerKeyTuple = {
  encryptionPublicKey: 'p256-ecdh-public:v1:alice:2',
  encryptionKeyVersion: 2,
  signingPublicKey: 'p256-ecdsa-public:v1:alice:2',
  signingKeyVersion: 2,
};

function timestamp(microsSinceUnixEpoch: bigint) {
  return new Timestamp(microsSinceUnixEpoch);
}

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: 1n,
    accountId: 1n,
    email: 'agent@example.com',
    slug: 'agent',
    isDefault: true,
    publicIdentity: 'agent-public',
    displayName: 'Agent',
    currentKeyBundleVersion: 1,
    publicDescription: undefined,
    publicLinkedEmailEnabled: false,
    allowAllMessageContentTypes: true,
    allowAllMessageHeaders: true,
    supportedMessageContentTypes: [],
    supportedMessageHeaderNames: [],
    masumiRegistrationNetwork: undefined,
    masumiInboxAgentId: undefined,
    masumiAgentIdentifier: undefined,
    masumiRegistrationState: undefined,
    createdAt: timestamp(1n),
    updatedAt: timestamp(1n),
    ...overrides,
  };
}

async function readPersistedTrustStore(configDir: string): Promise<PeerKeyTrustStore> {
  const raw = await readFile(path.join(configDir, 'masumi-agent-messenger', 'cli', 'peer-key-trust.json'), 'utf8');
  return JSON.parse(raw) as PeerKeyTrustStore;
}

async function writePersistedTrustStore(configDir: string, store: unknown): Promise<void> {
  const filePath = path.join(
    configDir,
    'masumi-agent-messenger',
    'cli',
    'peer-key-trust.json'
  );
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

describe('send-message', () => {
  let tempDir: string;
  let previousXdgConfigHome: string | undefined;

  beforeEach(async () => {
    previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'send-message-'));
    process.env.XDG_CONFIG_HOME = tempDir;
  });

  afterEach(async () => {
    if (previousXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('requirePeerKeyTrust', () => {
    it('returns silently when the observed tuple matches the pinned one', async () => {
      await pinFirstObservation('alice-id', tupleA);
      await expect(
        requirePeerKeyTrust({
          publicIdentity: 'alice-id',
          displayLabel: 'alice',
          observed: tupleA,
          allowFirstContactTrust: false,
        })
      ).resolves.toBeUndefined();
    });

    it('accepts legacy persisted string key versions while checking message trust', async () => {
      await writePersistedTrustStore(tempDir, {
        version: 1,
        peers: {
          'alice-id': {
            publicIdentity: 'alice-id',
            pinnedAt: '2026-04-18T00:00:00.000Z',
            current: {
              ...tupleA,
              encryptionKeyVersion: 'enc-v1',
              signingKeyVersion: 'sig-v1',
            },
          },
        },
      });

      await expect(
        requirePeerKeyTrust({
          publicIdentity: 'alice-id',
          displayLabel: 'alice',
          observed: tupleA,
          allowFirstContactTrust: false,
        })
      ).resolves.toBeUndefined();
    });

    it('auto-pins on first contact when allowFirstContactTrust is true', async () => {
      await expect(
        requirePeerKeyTrust({
          publicIdentity: 'alice-id',
          displayLabel: 'alice',
          observed: tupleA,
          allowFirstContactTrust: true,
        })
      ).resolves.toBeUndefined();

      const store = await readPersistedTrustStore(tempDir);
      expect(store.peers['alice-id']).toBeDefined();
      expect(store.peers['alice-id']?.current).toEqual(tupleA);
    });

    it('refuses to send to an unpinned peer when allowFirstContactTrust is false', async () => {
      const error = await requirePeerKeyTrust({
        publicIdentity: 'alice-id',
        displayLabel: 'alice',
        observed: tupleA,
        allowFirstContactTrust: false,
      }).then(
        () => null,
        (caught: unknown) => caught
      );

      expect(error).not.toBeNull();
      if (!isCliError(error)) {
        throw new Error('Expected CLI error');
      }
      expect(error.code).toBe('PEER_KEY_UNPINNED');
      expect(error.message).toMatch(/not trusted/i);
    });

    it('auto-confirms when the pinned peer rotates keys', async () => {
      await pinFirstObservation('alice-id', tupleA);

      await expect(
        requirePeerKeyTrust({
          publicIdentity: 'alice-id',
          displayLabel: 'alice',
          observed: tupleARotated,
          allowFirstContactTrust: false,
        })
      ).resolves.toBeUndefined();

      const store = await readPersistedTrustStore(tempDir);
      const record = store.peers['alice-id'];
      expect(record?.current).toEqual(tupleARotated);
      expect(record?.history).toHaveLength(2);
      expect(record?.history[0]).toMatchObject(tupleA);
      expect(record?.history[1]).toMatchObject(tupleARotated);
    });

    it('auto-confirms rotation even when allowFirstContactTrust is true', async () => {
      await pinFirstObservation('alice-id', tupleA);

      await expect(
        requirePeerKeyTrust({
          publicIdentity: 'alice-id',
          displayLabel: 'alice',
          observed: tupleARotated,
          allowFirstContactTrust: true,
        })
      ).resolves.toBeUndefined();

      const store = await readPersistedTrustStore(tempDir);
      expect(store.peers['alice-id']?.current).toEqual(tupleARotated);
    });
  });

  describe('sender secret reuse', () => {
    it('rehydrates the current sender secret from the sender own envelope after process restart', async () => {
      const keyPair = await generateAgentKeyPair({
        encryptionKeyVersion: 1,
        signingKeyVersion: 1,
      });
      const ownActor = makeAgent({
        id: 10n,
        accountId: 5n,
        email: 'sender@example.com',
        slug: 'sender',
        publicIdentity: 'sender-public',
      });
      const threadId = 500n;
      const recipient = {
        actorId: ownActor.id,
        email: ownActor.email,
        slug: ownActor.slug,
        publicIdentity: ownActor.publicIdentity,
        encryptionPublicKey: keyPair.encryption.publicKey,
        encryptionKeyVersion: keyPair.encryption.keyVersion,
        signingPublicKey: keyPair.signing.publicKey,
        signingKeyVersion: keyPair.signing.keyVersion,
      };

      const first = await prepareEncryptedMessage({
        threadId,
        senderActorId: ownActor.id,
        senderPublicIdentity: ownActor.publicIdentity,
        senderMessageId: 100n,
        payload: {
          contentType: 'text/plain',
          body: 'first',
        },
        keyPair,
        recipients: [recipient],
        existingSecret: null,
        latestKnownSecretVersion: null,
        rotateSecret: false,
      });
      const ownEnvelopePayload = first.attachedSecretEnvelopes[0];
      if (!ownEnvelopePayload) {
        throw new Error('Expected first message to attach an own envelope');
      }

      const ownEnvelope = {
        id: 1n,
        threadId,
        membershipVersion: 1n,
        secretVersion: first.secretVersion,
        senderAgentDbId: ownActor.id,
        recipientAgentDbId: ownActor.id,
        senderAccountId: ownActor.accountId,
        recipientAccountId: ownActor.accountId,
        senderEncryptionKeyVersion: ownEnvelopePayload.senderEncryptionKeyVersion,
        recipientEncryptionKeyVersion: ownEnvelopePayload.recipientEncryptionKeyVersion,
        signingKeyVersion: ownEnvelopePayload.signingKeyVersion,
        wrappedSecretCiphertext: fromHex(ownEnvelopePayload.wrappedSecretCiphertext),
        wrappedSecretIv: fromHex(ownEnvelopePayload.wrappedSecretIv),
        signature: fromHex(ownEnvelopePayload.signature),
        wrapAlgorithm: { tag: 'EcdhP256AesGcm256V1' as const },
        createdAt: timestamp(2n),
        updatedAt: timestamp(2n),
      } satisfies ThreadSecretEnvelope;
      const conn = {
        procedures: {
          lookupAgentPublicKeys: vi.fn(async () => [
            {
              agentDbId: ownActor.id,
              keyKind: { tag: 'Encryption' as const },
              keyVersion: keyPair.encryption.keyVersion,
              publicKey: keyPair.encryption.publicKey,
            },
            {
              agentDbId: ownActor.id,
              keyKind: { tag: 'Signing' as const },
              keyVersion: keyPair.signing.keyVersion,
              publicKey: keyPair.signing.publicKey,
            },
          ]),
        },
      } as unknown as DbConnection;

      const rehydrated = await resolveExistingSenderSecret({
        conn,
        threadId,
        ownActor,
        keyPair,
        latestSenderState: {
          membershipVersion: ownEnvelope.membershipVersion,
          secretVersion: first.secretVersion,
        },
        envelopes: [ownEnvelope],
        requiresSecretRotation: false,
      });

      expect(rehydrated).toEqual(first.senderSecret);
      const second = await prepareEncryptedMessage({
        threadId,
        senderActorId: ownActor.id,
        senderPublicIdentity: ownActor.publicIdentity,
        senderMessageId: 101n,
        payload: {
          contentType: 'text/plain',
          body: 'second',
        },
        keyPair,
        recipients: [recipient],
        existingSecret: rehydrated,
        latestKnownSecretVersion: first.secretVersion,
        rotateSecret: false,
      });
      expect(second.didRotateSecret).toBe(false);
      expect(second.secretVersion).toBe(first.secretVersion);
      expect(second.attachedSecretEnvelopes).toHaveLength(0);
    });
  });

  describe('Masumi registry advisory predicates', () => {
    it('flags deregistering and deregistered states as send-blockers', () => {
      expect(isDeregisteringOrDeregisteredInboxAgentState('DeregistrationRequested')).toBe(true);
      expect(isDeregisteringOrDeregisteredInboxAgentState('DeregistrationInitiated')).toBe(true);
      expect(isDeregisteringOrDeregisteredInboxAgentState('DeregistrationConfirmed')).toBe(true);
    });

    it('flags failed-registration state as send-blocker', () => {
      expect(isFailedRegistrationInboxAgentState('RegistrationFailed')).toBe(true);
    });

    it('does not flag healthy registration states as send-blockers', () => {
      for (const healthy of [
        'RegistrationRequested',
        'RegistrationInitiated',
        'RegistrationConfirmed',
      ]) {
        expect(isDeregisteringOrDeregisteredInboxAgentState(healthy)).toBe(false);
        expect(isFailedRegistrationInboxAgentState(healthy)).toBe(false);
      }
    });

    it('treats null and undefined registry state as not-blocked (advisory check failed open)', () => {
      // Per CLAUDE.md: registry lookup is advisory; failures must not block sends.
      // The send-path uses `networkTarget?.state` which is undefined when the lookup
      // throws or returns null, and these predicates must NOT trip in that case.
      expect(isDeregisteringOrDeregisteredInboxAgentState(null)).toBe(false);
      expect(isDeregisteringOrDeregisteredInboxAgentState(undefined)).toBe(false);
      expect(isFailedRegistrationInboxAgentState(null)).toBe(false);
      expect(isFailedRegistrationInboxAgentState(undefined)).toBe(false);
    });
  });
});
