import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Timestamp } from 'spacetimedb';
import {
  normalizeEnvelopeWrapAlgorithm,
  normalizeMessageCipherAlgorithm,
} from '../../../shared/agent-crypto';
import {
  decryptVisibleMessage,
  paginateNewMessages,
  selectUnreadIncomingMessages,
  type NewMessageFeed,
} from './messages';
import { comparePinnedPeer, pinFirstObservation } from './peer-key-trust';
import type { Agent } from '../../../webapp/src/module_bindings/types';

function timestamp(microsSinceUnixEpoch: bigint) {
  return new Timestamp(microsSinceUnixEpoch);
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function actor(
  row: Omit<
    Agent,
    | 'masumiRegistrationNetwork'
    | 'masumiInboxAgentId'
    | 'masumiAgentIdentifier'
    | 'masumiRegistrationState'
    | 'publicDescription'
    | 'publicLinkedEmailEnabled'
    | 'allowAllMessageContentTypes'
    | 'allowAllMessageHeaders'
    | 'supportedMessageContentTypes'
    | 'supportedMessageHeaderNames'
  > &
    Partial<
      Pick<
        Agent,
        | 'publicDescription'
        | 'publicLinkedEmailEnabled'
        | 'allowAllMessageContentTypes'
        | 'allowAllMessageHeaders'
        | 'supportedMessageContentTypes'
        | 'supportedMessageHeaderNames'
      >
    >
): Agent {
  return {
    ...row,
    publicDescription: row.publicDescription ?? undefined,
    publicLinkedEmailEnabled: row.publicLinkedEmailEnabled ?? false,
    allowAllMessageContentTypes: row.allowAllMessageContentTypes ?? false,
    allowAllMessageHeaders: row.allowAllMessageHeaders ?? false,
    supportedMessageContentTypes: row.supportedMessageContentTypes ?? [],
    supportedMessageHeaderNames: row.supportedMessageHeaderNames ?? [],
    masumiRegistrationNetwork: undefined,
    masumiInboxAgentId: undefined,
    masumiAgentIdentifier: undefined,
    masumiRegistrationState: undefined,
  };
}

describe('SpacetimeDB crypto algorithm normalization', () => {
  it('maps generated enum tags back to signed wire strings', () => {
    expect(normalizeMessageCipherAlgorithm({ tag: 'AesGcm256V1' })).toBe(
      'aes-gcm-256-v1'
    );
    expect(normalizeEnvelopeWrapAlgorithm({ tag: 'EcdhP256AesGcm256V1' })).toBe(
      'aes-gcm-256-wrap-v1'
    );
  });
});

describe('selectUnreadIncomingMessages', () => {
  it('filters archived, self-sent, and already-read messages', () => {
    const result = selectUnreadIncomingMessages(
      {
        actors: [
          actor({
            id: 1n,
            accountId: 10n,
            email: 'agent@example.com',
            slug: 'agent',
            isDefault: true,
            publicIdentity: 'agent',
            displayName: 'Agent',
            currentKeyBundleVersion: 1,
            createdAt: timestamp(1n),
            updatedAt: timestamp(1n),
          }),
          actor({
            id: 2n,
            accountId: 99n,
            email: 'other@example.com',
            slug: 'other',
            isDefault: true,
            publicIdentity: 'other',
            displayName: 'Other',
            currentKeyBundleVersion: 1,
            createdAt: timestamp(1n),
            updatedAt: timestamp(1n),
          }),
        ],
        participants: [
          {
            id: 1n,
            threadId: 20n,
            agentDbId: 1n,
            createdAt: timestamp(1n),
            lastSentSeq: 0n,
            lastSentSecretVersion: 0,
            isAdmin: true,
            active: true,
            activeRecencySortKey: 0n,
            accountId: 0n,
            membershipVersion: 1n,
            lastReadMessageId: 0n,
            archived: false,
            updatedAt: timestamp(1n),
          },
          {
            id: 2n,
            threadId: 20n,
            agentDbId: 2n,
            createdAt: timestamp(1n),
            lastSentSeq: 0n,
            lastSentSecretVersion: 0,
            isAdmin: false,
            active: true,
            activeRecencySortKey: 0n,
            accountId: 0n,
            membershipVersion: 1n,
            lastReadMessageId: 0n,
            archived: false,
            updatedAt: timestamp(1n),
          },
          {
            id: 3n,
            threadId: 21n,
            agentDbId: 1n,
            createdAt: timestamp(1n),
            lastSentSeq: 0n,
            lastSentSecretVersion: 0,
            isAdmin: true,
            active: true,
            activeRecencySortKey: 0n,
            accountId: 0n,
            membershipVersion: 1n,
            lastReadMessageId: 0n,
            archived: false,
            updatedAt: timestamp(1n),
          },
          {
            id: 4n,
            threadId: 21n,
            agentDbId: 2n,
            createdAt: timestamp(1n),
            lastSentSeq: 0n,
            lastSentSecretVersion: 0,
            isAdmin: false,
            active: true,
            activeRecencySortKey: 0n,
            accountId: 0n,
            membershipVersion: 1n,
            lastReadMessageId: 0n,
            archived: false,
            updatedAt: timestamp(1n),
          },
        ],
        readStates: [
          {
            id: 1n,
            threadId: 20n,
            agentDbId: 1n,
            lastReadMessageId: 100n,
            archived: false,
            updatedAt: timestamp(1n),
            accountId: 0n,
            membershipVersion: 1n,
            lastSentSeq: 0n,
            lastSentSecretVersion: 0,
            isAdmin: false,
            active: true,
            activeRecencySortKey: 0n,
            createdAt: timestamp(1n),
          },
          {
            id: 2n,
            threadId: 21n,
            agentDbId: 1n,
            lastReadMessageId: 0n,
            archived: true,
            updatedAt: timestamp(1n),
            accountId: 0n,
            membershipVersion: 1n,
            lastSentSeq: 0n,
            lastSentSecretVersion: 0,
            isAdmin: false,
            active: true,
            activeRecencySortKey: 0n,
            createdAt: timestamp(1n),
          },
        ],
        secretEnvelopes: [],
        threads: [],
        messages: [
          {
            id: 100n,
            threadId: 20n,
            idDescSortKey: 0n,
            membershipVersion: 1n,
            senderAgentDbId: 2n,
            senderMessageId: 1n,
            secretVersion: 1,
            attachesNewEnvelopes: false,
            signingKeyVersion: 1,
            ciphertext: bytes('ciphertext'),
            iv: bytes('iv'),
            cipherAlgorithm: { tag: 'AesGcm256V1' as const },
            signature: bytes('signature'),
            replyToMessageId: undefined,
            createdAt: timestamp(100n),
            updatedAt: timestamp(1n),
          },
          {
            id: 101n,
            threadId: 20n,
            idDescSortKey: 0n,
            membershipVersion: 1n,
            senderAgentDbId: 2n,
            senderMessageId: 2n,
            secretVersion: 1,
            attachesNewEnvelopes: false,
            signingKeyVersion: 1,
            ciphertext: bytes('ciphertext'),
            iv: bytes('iv'),
            cipherAlgorithm: { tag: 'AesGcm256V1' as const },
            signature: bytes('signature'),
            replyToMessageId: undefined,
            createdAt: timestamp(300n),
            updatedAt: timestamp(1n),
          },
          {
            id: 102n,
            threadId: 20n,
            idDescSortKey: 0n,
            membershipVersion: 1n,
            senderAgentDbId: 1n,
            senderMessageId: 3n,
            secretVersion: 1,
            attachesNewEnvelopes: false,
            signingKeyVersion: 1,
            ciphertext: bytes('ciphertext'),
            iv: bytes('iv'),
            cipherAlgorithm: { tag: 'AesGcm256V1' as const },
            signature: bytes('signature'),
            replyToMessageId: undefined,
            createdAt: timestamp(400n),
            updatedAt: timestamp(1n),
          },
          {
            id: 103n,
            threadId: 21n,
            idDescSortKey: 0n,
            membershipVersion: 1n,
            senderAgentDbId: 2n,
            senderMessageId: 1n,
            secretVersion: 1,
            attachesNewEnvelopes: false,
            signingKeyVersion: 1,
            ciphertext: bytes('ciphertext'),
            iv: bytes('iv'),
            cipherAlgorithm: { tag: 'AesGcm256V1' as const },
            signature: bytes('signature'),
            replyToMessageId: undefined,
            createdAt: timestamp(500n),
            updatedAt: timestamp(1n),
          },
        ],
      },
      'agent@example.com'
    );

    expect(result.defaultActor.id).toBe(1n);
    expect(result.unreadMessages.map(message => message.id)).toEqual([101n]);
  });

  it('treats other owned slugs as incoming only when they message the selected slug', () => {
    const result = selectUnreadIncomingMessages(
      {
        actors: [
          actor({
            id: 1n,
            accountId: 10n,
            email: 'agent@example.com',
            slug: 'default',
            isDefault: true,
            publicIdentity: 'default',
            displayName: 'Default',
            currentKeyBundleVersion: 1,
            createdAt: timestamp(1n),
            updatedAt: timestamp(1n),
          }),
          actor({
            id: 2n,
            accountId: 10n,
            email: 'agent@example.com',
            slug: 'circuit',
            isDefault: false,
            publicIdentity: 'circuit',
            displayName: 'Circuit',
            currentKeyBundleVersion: 1,
            createdAt: timestamp(1n),
            updatedAt: timestamp(1n),
          }),
          actor({
            id: 3n,
            accountId: 10n,
            email: 'agent@example.com',
            slug: 'auditor',
            isDefault: false,
            publicIdentity: 'auditor',
            displayName: 'Auditor',
            currentKeyBundleVersion: 1,
            createdAt: timestamp(1n),
            updatedAt: timestamp(1n),
          }),
          actor({
            id: 4n,
            accountId: 20n,
            email: 'external@example.com',
            slug: 'external',
            isDefault: true,
            publicIdentity: 'external',
            displayName: 'External',
            currentKeyBundleVersion: 1,
            createdAt: timestamp(1n),
            updatedAt: timestamp(1n),
          }),
        ],
        participants: [
          {
            id: 1n,
            threadId: 30n,
            agentDbId: 2n,
            createdAt: timestamp(1n),
            lastSentSeq: 0n,
            lastSentSecretVersion: 0,
            isAdmin: true,
            active: true,
            activeRecencySortKey: 0n,
            accountId: 0n,
            membershipVersion: 1n,
            lastReadMessageId: 0n,
            archived: false,
            updatedAt: timestamp(1n),
          },
          {
            id: 2n,
            threadId: 30n,
            agentDbId: 3n,
            createdAt: timestamp(1n),
            lastSentSeq: 0n,
            lastSentSecretVersion: 0,
            isAdmin: false,
            active: true,
            activeRecencySortKey: 0n,
            accountId: 0n,
            membershipVersion: 1n,
            lastReadMessageId: 0n,
            archived: false,
            updatedAt: timestamp(1n),
          },
          {
            id: 3n,
            threadId: 31n,
            agentDbId: 1n,
            createdAt: timestamp(1n),
            lastSentSeq: 0n,
            lastSentSecretVersion: 0,
            isAdmin: true,
            active: true,
            activeRecencySortKey: 0n,
            accountId: 0n,
            membershipVersion: 1n,
            lastReadMessageId: 0n,
            archived: false,
            updatedAt: timestamp(1n),
          },
          {
            id: 4n,
            threadId: 31n,
            agentDbId: 4n,
            createdAt: timestamp(1n),
            lastSentSeq: 0n,
            lastSentSecretVersion: 0,
            isAdmin: false,
            active: true,
            activeRecencySortKey: 0n,
            accountId: 0n,
            membershipVersion: 1n,
            lastReadMessageId: 0n,
            archived: false,
            updatedAt: timestamp(1n),
          },
        ],
        readStates: [
          {
            id: 1n,
            threadId: 30n,
            agentDbId: 2n,
            lastReadMessageId: 0n,
            archived: false,
            updatedAt: timestamp(1n),
            accountId: 0n,
            membershipVersion: 1n,
            lastSentSeq: 0n,
            lastSentSecretVersion: 0,
            isAdmin: false,
            active: true,
            activeRecencySortKey: 0n,
            createdAt: timestamp(1n),
          },
          {
            id: 2n,
            threadId: 31n,
            agentDbId: 1n,
            lastReadMessageId: 0n,
            archived: false,
            updatedAt: timestamp(1n),
            accountId: 0n,
            membershipVersion: 1n,
            lastSentSeq: 0n,
            lastSentSecretVersion: 0,
            isAdmin: false,
            active: true,
            activeRecencySortKey: 0n,
            createdAt: timestamp(1n),
          },
        ],
        secretEnvelopes: [],
        threads: [],
        messages: [
          {
            id: 201n,
            threadId: 30n,
            idDescSortKey: 0n,
            membershipVersion: 1n,
            senderAgentDbId: 3n,
            senderMessageId: 1n,
            secretVersion: 1,
            attachesNewEnvelopes: false,
            signingKeyVersion: 1,
            ciphertext: bytes('ciphertext'),
            iv: bytes('iv'),
            cipherAlgorithm: { tag: 'AesGcm256V1' as const },
            signature: bytes('signature'),
            replyToMessageId: undefined,
            createdAt: timestamp(100n),
            updatedAt: timestamp(1n),
          },
          {
            id: 202n,
            threadId: 30n,
            idDescSortKey: 0n,
            membershipVersion: 1n,
            senderAgentDbId: 2n,
            senderMessageId: 1n,
            secretVersion: 1,
            attachesNewEnvelopes: false,
            signingKeyVersion: 1,
            ciphertext: bytes('ciphertext'),
            iv: bytes('iv'),
            cipherAlgorithm: { tag: 'AesGcm256V1' as const },
            signature: bytes('signature'),
            replyToMessageId: undefined,
            createdAt: timestamp(200n),
            updatedAt: timestamp(1n),
          },
          {
            id: 203n,
            threadId: 31n,
            idDescSortKey: 0n,
            membershipVersion: 1n,
            senderAgentDbId: 4n,
            senderMessageId: 1n,
            secretVersion: 1,
            attachesNewEnvelopes: false,
            signingKeyVersion: 1,
            ciphertext: bytes('ciphertext'),
            iv: bytes('iv'),
            cipherAlgorithm: { tag: 'AesGcm256V1' as const },
            signature: bytes('signature'),
            replyToMessageId: undefined,
            createdAt: timestamp(300n),
            updatedAt: timestamp(1n),
          },
        ],
      },
      'agent@example.com',
      'circuit'
    );

    expect(result.defaultActor.slug).toBe('circuit');
    expect(result.ownActorIds).toEqual(new Set([2n]));
    expect(result.unreadMessages.map(message => message.id)).toEqual([201n]);
  });
});

describe('paginateNewMessages', () => {
  const feed: NewMessageFeed = {
    authenticated: true,
    connected: true,
    profile: 'default',
    scope: {
      slug: null,
      threadId: null,
    },
    totalMessages: 6,
    messages: Array.from({ length: 6 }, (_, index) => ({
      id: String(index + 1),
      threadId: '20',
      messageId: String(index + 1),
      createdAt: '2026-04-12T00:00:00.000Z',
      threadLabel: 'Thread',
      sender: {
        id: '2',
        slug: 'other',
        displayName: 'Other',
        publicIdentity: 'other',
      },
      text: `message-${index + 1}`,
      decryptStatus: 'ok',
      decryptError: null,
      contentType: 'text/plain',
      headerNames: [],
      headers: [],
      unsupportedReasons: [],
      legacyPlaintext: false,
      replyToMessageId: null,
      trustStatus: 'trusted',
      trustNotice: null,
      trustWarning: null,
    })),
  };

  it('slices pages and exposes next-page metadata', () => {
    const paginated = paginateNewMessages(feed, {
      page: 2,
      pageSize: 2,
    });

    expect(paginated.page).toBe(2);
    expect(paginated.totalPages).toBe(3);
    expect(paginated.hasPrevious).toBe(true);
    expect(paginated.hasNext).toBe(true);
    expect(paginated.previousPage).toBe(1);
    expect(paginated.nextPage).toBe(3);
    expect(paginated.messages.map(message => message.id)).toEqual(['3', '4']);
  });
});

describe('decryptVisibleMessage trust handling', () => {
  it('does not promote an unconfirmed rotated signing key while reading inbound messages', async () => {
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'messages-peer-trust-'));
    process.env.XDG_CONFIG_HOME = tempDir;

    const ownActor = actor({
      id: 1n,
      accountId: 10n,
      email: 'agent@example.com',
      slug: 'agent',
      isDefault: true,
      publicIdentity: 'agent',
      displayName: 'Agent',
      currentKeyBundleVersion: 1,
      createdAt: timestamp(1n),
      updatedAt: timestamp(1n),
    });
    const rotatedSender = actor({
      id: 2n,
      accountId: 20n,
      email: 'other@example.com',
      slug: 'other',
      isDefault: true,
      publicIdentity: 'other',
      displayName: 'Other',
      currentKeyBundleVersion: 2,
      createdAt: timestamp(1n),
      updatedAt: timestamp(1n),
    });

    try {
      await pinFirstObservation(
        rotatedSender.publicIdentity,
        {
          encryptionPublicKey: 'other-enc-v1',
          encryptionKeyVersion: 1,
          signingPublicKey: 'other-sig-v1',
          signingKeyVersion: 1,
        },
        () => '2026-04-21T00:00:00.000Z'
      );

      const decrypted = await decryptVisibleMessage({
        message: {
          id: 100n,
          threadId: 200n,
          idDescSortKey: 0n,
          membershipVersion: 1n,
          senderAgentDbId: rotatedSender.id,
          senderMessageId: 2n,
          secretVersion: 1,
          attachesNewEnvelopes: false,
          signingKeyVersion: 2,
          ciphertext: bytes('ciphertext'),
          iv: bytes('iv'),
          cipherAlgorithm: { tag: 'AesGcm256V1' as const },
          signature: bytes('signature'),
          replyToMessageId: undefined,
          createdAt: timestamp(2n),
          updatedAt: timestamp(1n),
        },
        defaultActor: ownActor,
        actorsById: new Map([
          [ownActor.id, ownActor],
          [rotatedSender.id, rotatedSender],
        ]),
        publicKeysByActorId: new Map(),
        ownActorIds: new Set([ownActor.id]),
        secretEnvelopes: [],
        recipientKeyPair: null,
      });

      expect(decrypted.trustStatus).toBe('untrusted-rotation');
      expect(decrypted.trustWarning).toBe(
        'other keys could not be resolved for trust verification.'
      );
      await expect(
        comparePinnedPeer(rotatedSender.publicIdentity, {
          encryptionPublicKey: 'enc-rotated',
          encryptionKeyVersion: rotatedSender.currentKeyBundleVersion,
          signingPublicKey: 'sig-rotated',
          signingKeyVersion: rotatedSender.currentKeyBundleVersion,
        })
      ).resolves.toMatchObject({ status: 'rotated' });
    } finally {
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
