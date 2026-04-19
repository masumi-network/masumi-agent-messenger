import { describe, expect, it } from 'vitest';
import { Timestamp } from 'spacetimedb';
import {
  paginateNewMessages,
  selectUnreadIncomingMessages,
  type NewMessageFeed,
} from './messages';
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
        bundles: [],
        participants: [],
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
