import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Timestamp } from 'spacetimedb';
import {
  decryptVisibleMessage,
  paginateNewMessages,
  selectUnreadIncomingMessages,
  type NewMessageFeed,
} from './messages';
import { comparePinnedPeer, pinFirstObservation } from './peer-key-trust';
import type { VisibleAgentRow } from '../../../webapp/src/module_bindings/types';

function timestamp(microsSinceUnixEpoch: bigint) {
  return new Timestamp(microsSinceUnixEpoch);
}

function actor(
  row: Omit<
    VisibleAgentRow,
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
    | 'currentEncryptionAlgorithm'
    | 'currentSigningAlgorithm'
  > &
    Partial<
      Pick<
        VisibleAgentRow,
        | 'publicDescription'
        | 'publicLinkedEmailEnabled'
        | 'allowAllMessageContentTypes'
        | 'allowAllMessageHeaders'
        | 'supportedMessageContentTypes'
        | 'supportedMessageHeaderNames'
        | 'currentEncryptionAlgorithm'
        | 'currentSigningAlgorithm'
      >
    >
): VisibleAgentRow {
  return {
    ...row,
    publicDescription: row.publicDescription ?? undefined,
    publicLinkedEmailEnabled: row.publicLinkedEmailEnabled ?? false,
    allowAllMessageContentTypes: row.allowAllMessageContentTypes ?? false,
    allowAllMessageHeaders: row.allowAllMessageHeaders ?? false,
    supportedMessageContentTypes: row.supportedMessageContentTypes,
    supportedMessageHeaderNames: row.supportedMessageHeaderNames,
    currentEncryptionAlgorithm: row.currentEncryptionAlgorithm ?? 'ecdh-p256-v1',
    currentSigningAlgorithm: row.currentSigningAlgorithm ?? 'ecdsa-p256-sha256-v1',
    masumiRegistrationNetwork: undefined,
    masumiInboxAgentId: undefined,
    masumiAgentIdentifier: undefined,
    masumiRegistrationState: undefined,
  };
}

describe('selectUnreadIncomingMessages', () => {
  it('filters archived, self-sent, and already-read messages', () => {
    const result = selectUnreadIncomingMessages(
      {
        actors: [
          actor({
            id: 1n,
            inboxId: 10n,
            normalizedEmail: 'agent@example.com',
            slug: 'agent',
            inboxIdentifier: undefined,
            isDefault: true,
            publicIdentity: 'agent',
            displayName: 'Agent',
            currentEncryptionPublicKey: 'enc',
            currentEncryptionKeyVersion: 'enc-v1',
            currentSigningPublicKey: 'sig',
            currentSigningKeyVersion: 'sig-v1',
            createdAt: timestamp(1n),
            updatedAt: timestamp(1n),
          }),
          actor({
            id: 2n,
            inboxId: 99n,
            normalizedEmail: 'other@example.com',
            slug: 'other',
            inboxIdentifier: undefined,
            isDefault: true,
            publicIdentity: 'other',
            displayName: 'Other',
            currentEncryptionPublicKey: 'enc-2',
            currentEncryptionKeyVersion: 'enc-v1',
            currentSigningPublicKey: 'sig-2',
            currentSigningKeyVersion: 'sig-v1',
            createdAt: timestamp(1n),
            updatedAt: timestamp(1n),
          }),
        ],
        participants: [
          {
            id: 1n,
            threadId: 20n,
            agentDbId: 1n,
            joinedAt: timestamp(1n),
            lastSentSeq: 0n,
            lastSentMembershipVersion: undefined,
            lastSentSecretVersion: undefined,
            isAdmin: true,
            active: true,
          },
          {
            id: 2n,
            threadId: 20n,
            agentDbId: 2n,
            joinedAt: timestamp(1n),
            lastSentSeq: 0n,
            lastSentMembershipVersion: undefined,
            lastSentSecretVersion: undefined,
            isAdmin: false,
            active: true,
          },
          {
            id: 3n,
            threadId: 21n,
            agentDbId: 1n,
            joinedAt: timestamp(1n),
            lastSentSeq: 0n,
            lastSentMembershipVersion: undefined,
            lastSentSecretVersion: undefined,
            isAdmin: true,
            active: true,
          },
          {
            id: 4n,
            threadId: 21n,
            agentDbId: 2n,
            joinedAt: timestamp(1n),
            lastSentSeq: 0n,
            lastSentMembershipVersion: undefined,
            lastSentSecretVersion: undefined,
            isAdmin: false,
            active: true,
          },
        ],
        readStates: [
          {
            id: 1n,
            threadId: 20n,
            agentDbId: 1n,
            lastReadThreadSeq: 2n,
            archived: false,
            updatedAt: timestamp(1n),
          },
          {
            id: 2n,
            threadId: 21n,
            agentDbId: 1n,
            lastReadThreadSeq: 0n,
            archived: true,
            updatedAt: timestamp(1n),
          },
        ],
        secretEnvelopes: [],
        threads: [],
        messages: [
          {
            id: 100n,
            threadId: 20n,
            threadSeq: 1n,
            membershipVersion: 1n,
            senderAgentDbId: 2n,
            senderSeq: 1n,
            secretVersion: 'sec-v1',
            secretVersionStart: false,
            signingKeyVersion: 'sig-v1',
            ciphertext: 'a',
            iv: 'b',
            cipherAlgorithm: 'aes',
            signature: 'c',
            replyToMessageId: undefined,
            createdAt: timestamp(100n),
          },
          {
            id: 101n,
            threadId: 20n,
            threadSeq: 3n,
            membershipVersion: 1n,
            senderAgentDbId: 2n,
            senderSeq: 2n,
            secretVersion: 'sec-v1',
            secretVersionStart: false,
            signingKeyVersion: 'sig-v1',
            ciphertext: 'a',
            iv: 'b',
            cipherAlgorithm: 'aes',
            signature: 'c',
            replyToMessageId: undefined,
            createdAt: timestamp(300n),
          },
          {
            id: 102n,
            threadId: 20n,
            threadSeq: 4n,
            membershipVersion: 1n,
            senderAgentDbId: 1n,
            senderSeq: 3n,
            secretVersion: 'sec-v1',
            secretVersionStart: false,
            signingKeyVersion: 'sig-v1',
            ciphertext: 'a',
            iv: 'b',
            cipherAlgorithm: 'aes',
            signature: 'c',
            replyToMessageId: undefined,
            createdAt: timestamp(400n),
          },
          {
            id: 103n,
            threadId: 21n,
            threadSeq: 1n,
            membershipVersion: 1n,
            senderAgentDbId: 2n,
            senderSeq: 1n,
            secretVersion: 'sec-v1',
            secretVersionStart: false,
            signingKeyVersion: 'sig-v1',
            ciphertext: 'a',
            iv: 'b',
            cipherAlgorithm: 'aes',
            signature: 'c',
            replyToMessageId: undefined,
            createdAt: timestamp(500n),
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
            inboxId: 10n,
            normalizedEmail: 'agent@example.com',
            slug: 'default',
            inboxIdentifier: undefined,
            isDefault: true,
            publicIdentity: 'default',
            displayName: 'Default',
            currentEncryptionPublicKey: 'default-enc',
            currentEncryptionKeyVersion: 'enc-v1',
            currentSigningPublicKey: 'default-sig',
            currentSigningKeyVersion: 'sig-v1',
            createdAt: timestamp(1n),
            updatedAt: timestamp(1n),
          }),
          actor({
            id: 2n,
            inboxId: 10n,
            normalizedEmail: 'agent@example.com',
            slug: 'circuit',
            inboxIdentifier: undefined,
            isDefault: false,
            publicIdentity: 'circuit',
            displayName: 'Circuit',
            currentEncryptionPublicKey: 'circuit-enc',
            currentEncryptionKeyVersion: 'enc-v1',
            currentSigningPublicKey: 'circuit-sig',
            currentSigningKeyVersion: 'sig-v1',
            createdAt: timestamp(1n),
            updatedAt: timestamp(1n),
          }),
          actor({
            id: 3n,
            inboxId: 10n,
            normalizedEmail: 'agent@example.com',
            slug: 'auditor',
            inboxIdentifier: undefined,
            isDefault: false,
            publicIdentity: 'auditor',
            displayName: 'Auditor',
            currentEncryptionPublicKey: 'auditor-enc',
            currentEncryptionKeyVersion: 'enc-v1',
            currentSigningPublicKey: 'auditor-sig',
            currentSigningKeyVersion: 'sig-v1',
            createdAt: timestamp(1n),
            updatedAt: timestamp(1n),
          }),
          actor({
            id: 4n,
            inboxId: 20n,
            normalizedEmail: 'external@example.com',
            slug: 'external',
            inboxIdentifier: undefined,
            isDefault: true,
            publicIdentity: 'external',
            displayName: 'External',
            currentEncryptionPublicKey: 'external-enc',
            currentEncryptionKeyVersion: 'enc-v1',
            currentSigningPublicKey: 'external-sig',
            currentSigningKeyVersion: 'sig-v1',
            createdAt: timestamp(1n),
            updatedAt: timestamp(1n),
          }),
        ],
        participants: [
          {
            id: 1n,
            threadId: 30n,
            agentDbId: 2n,
            joinedAt: timestamp(1n),
            lastSentSeq: 0n,
            lastSentMembershipVersion: undefined,
            lastSentSecretVersion: undefined,
            isAdmin: true,
            active: true,
          },
          {
            id: 2n,
            threadId: 30n,
            agentDbId: 3n,
            joinedAt: timestamp(1n),
            lastSentSeq: 0n,
            lastSentMembershipVersion: undefined,
            lastSentSecretVersion: undefined,
            isAdmin: false,
            active: true,
          },
          {
            id: 3n,
            threadId: 31n,
            agentDbId: 1n,
            joinedAt: timestamp(1n),
            lastSentSeq: 0n,
            lastSentMembershipVersion: undefined,
            lastSentSecretVersion: undefined,
            isAdmin: true,
            active: true,
          },
          {
            id: 4n,
            threadId: 31n,
            agentDbId: 4n,
            joinedAt: timestamp(1n),
            lastSentSeq: 0n,
            lastSentMembershipVersion: undefined,
            lastSentSecretVersion: undefined,
            isAdmin: false,
            active: true,
          },
        ],
        readStates: [
          {
            id: 1n,
            threadId: 30n,
            agentDbId: 2n,
            lastReadThreadSeq: 0n,
            archived: false,
            updatedAt: timestamp(1n),
          },
          {
            id: 2n,
            threadId: 31n,
            agentDbId: 1n,
            lastReadThreadSeq: 0n,
            archived: false,
            updatedAt: timestamp(1n),
          },
        ],
        secretEnvelopes: [],
        threads: [],
        messages: [
          {
            id: 201n,
            threadId: 30n,
            threadSeq: 1n,
            membershipVersion: 1n,
            senderAgentDbId: 3n,
            senderSeq: 1n,
            secretVersion: 'sec-v1',
            secretVersionStart: false,
            signingKeyVersion: 'sig-v1',
            ciphertext: 'a',
            iv: 'b',
            cipherAlgorithm: 'aes',
            signature: 'c',
            replyToMessageId: undefined,
            createdAt: timestamp(100n),
          },
          {
            id: 202n,
            threadId: 30n,
            threadSeq: 2n,
            membershipVersion: 1n,
            senderAgentDbId: 2n,
            senderSeq: 1n,
            secretVersion: 'sec-v1',
            secretVersionStart: false,
            signingKeyVersion: 'sig-v1',
            ciphertext: 'a',
            iv: 'b',
            cipherAlgorithm: 'aes',
            signature: 'c',
            replyToMessageId: undefined,
            createdAt: timestamp(200n),
          },
          {
            id: 203n,
            threadId: 31n,
            threadSeq: 1n,
            membershipVersion: 1n,
            senderAgentDbId: 4n,
            senderSeq: 1n,
            secretVersion: 'sec-v1',
            secretVersionStart: false,
            signingKeyVersion: 'sig-v1',
            ciphertext: 'a',
            iv: 'b',
            cipherAlgorithm: 'aes',
            signature: 'c',
            replyToMessageId: undefined,
            createdAt: timestamp(300n),
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
      threadSeq: String(index + 1),
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
      inboxId: 10n,
      normalizedEmail: 'agent@example.com',
      slug: 'agent',
      inboxIdentifier: undefined,
      isDefault: true,
      publicIdentity: 'agent',
      displayName: 'Agent',
      currentEncryptionPublicKey: 'agent-enc',
      currentEncryptionKeyVersion: 'enc-v1',
      currentSigningPublicKey: 'agent-sig',
      currentSigningKeyVersion: 'sig-v1',
      createdAt: timestamp(1n),
      updatedAt: timestamp(1n),
    });
    const rotatedSender = actor({
      id: 2n,
      inboxId: 20n,
      normalizedEmail: 'other@example.com',
      slug: 'other',
      inboxIdentifier: undefined,
      isDefault: true,
      publicIdentity: 'other',
      displayName: 'Other',
      currentEncryptionPublicKey: 'other-enc-v2',
      currentEncryptionKeyVersion: 'enc-v2',
      currentSigningPublicKey: 'other-sig-v2',
      currentSigningKeyVersion: 'sig-v2',
      createdAt: timestamp(1n),
      updatedAt: timestamp(1n),
    });

    try {
      await pinFirstObservation(
        rotatedSender.publicIdentity,
        {
          encryptionPublicKey: 'other-enc-v1',
          encryptionKeyVersion: 'enc-v1',
          signingPublicKey: 'other-sig-v1',
          signingKeyVersion: 'sig-v1',
        },
        () => '2026-04-21T00:00:00.000Z'
      );

      const decrypted = await decryptVisibleMessage({
        message: {
          id: 100n,
          threadId: 200n,
          threadSeq: 2n,
          membershipVersion: 1n,
          senderAgentDbId: rotatedSender.id,
          senderSeq: 2n,
          secretVersion: 'sec-v1',
          secretVersionStart: false,
          signingKeyVersion: 'sig-v2',
          ciphertext: 'ciphertext',
          iv: 'iv',
          cipherAlgorithm: 'aes-gcm-256-v1',
          signature: 'signature',
          replyToMessageId: undefined,
          createdAt: timestamp(2n),
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
        'other has rotated keys. Message signature is not trusted.'
      );
      await expect(
        comparePinnedPeer(rotatedSender.publicIdentity, {
          encryptionPublicKey: rotatedSender.currentEncryptionPublicKey,
          encryptionKeyVersion: rotatedSender.currentEncryptionKeyVersion,
          signingPublicKey: rotatedSender.currentSigningPublicKey,
          signingKeyVersion: rotatedSender.currentSigningKeyVersion,
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
