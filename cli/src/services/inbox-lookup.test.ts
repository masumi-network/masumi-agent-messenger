import { describe, expect, it } from 'vitest';
import { Timestamp } from 'spacetimedb';
import {
  buildDiscoveredInboxLookupItems,
  buildInboxLookupEntries,
} from './inbox-lookup';
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

describe('buildInboxLookupEntries', () => {
  it('aggregates direct threads by inbox slug, counts unread incoming messages, and sorts by latest message', () => {
    const result = buildInboxLookupEntries({
      snapshot: {
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
            accountId: 20n,
            email: 'patrick@example.com',
            slug: 'patrick',
            isDefault: true,
            publicIdentity: 'patrick',
            displayName: 'Patrick Tobler',
            currentKeyBundleVersion: 1,
            createdAt: timestamp(1n),
            updatedAt: timestamp(1n),
          }),
          actor({
            id: 3n,
            accountId: 30n,
            email: 'alice@example.com',
            slug: 'alice',
            isDefault: true,
            publicIdentity: 'alice',
            displayName: 'Alice',
            currentKeyBundleVersion: 1,
            createdAt: timestamp(1n),
            updatedAt: timestamp(1n),
          }),
        ],
        participants: [
          {
            id: 1n,
            threadId: 100n,
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
            threadId: 100n,
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
            threadId: 101n,
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
            threadId: 101n,
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
            id: 5n,
            threadId: 102n,
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
            id: 6n,
            threadId: 102n,
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
        ],
        contactRequests: [],
        threadInvites: [],
        readStates: [
          {
            id: 1n,
            threadId: 100n,
            agentDbId: 1n,
            lastReadMessageId: 500n,
            archived: false,
            accountId: 0n,
            membershipVersion: 1n,
            lastSentSeq: 0n,
            lastSentSecretVersion: 0,
            isAdmin: false,
            active: true,
            activeRecencySortKey: 0n,
            createdAt: timestamp(1n),
            updatedAt: timestamp(1n),
          },
          {
            id: 3n,
            threadId: 101n,
            agentDbId: 1n,
            lastReadMessageId: 0n,
            archived: false,
            accountId: 0n,
            membershipVersion: 1n,
            lastSentSeq: 0n,
            lastSentSecretVersion: 0,
            isAdmin: false,
            active: true,
            activeRecencySortKey: 0n,
            createdAt: timestamp(1n),
            updatedAt: timestamp(1n),
          },
          {
            id: 5n,
            threadId: 102n,
            agentDbId: 1n,
            lastReadMessageId: 0n,
            archived: false,
            accountId: 0n,
            membershipVersion: 1n,
            lastSentSeq: 0n,
            lastSentSecretVersion: 0,
            isAdmin: false,
            active: true,
            activeRecencySortKey: 0n,
            createdAt: timestamp(1n),
            updatedAt: timestamp(1n),
          },
        ],
        secretEnvelopes: [],
        threads: [
          {
            id: 100n,
            directLowAgentDbId: 1n,
            directHighAgentDbId: 2n,
            kind: { tag: 'Direct' as const },
            title: undefined,
            creatorAgentDbId: 1n,
            membershipVersion: 1n,
            lastMessageId: 2n,

            messageCount: 2n,
            activeParticipantCount: 2n,
            messageRetentionMs: undefined,
            createdAt: timestamp(1n),
            updatedAt: timestamp(300n),
            lastMessageAt: timestamp(300n),
          },
          {
            id: 101n,
            directLowAgentDbId: 1n,
            directHighAgentDbId: 2n,
            kind: { tag: 'Direct' as const },
            title: undefined,
            creatorAgentDbId: 1n,
            membershipVersion: 1n,
            lastMessageId: 1n,

            messageCount: 1n,
            activeParticipantCount: 2n,
            messageRetentionMs: undefined,
            createdAt: timestamp(1n),
            updatedAt: timestamp(400n),
            lastMessageAt: timestamp(400n),
          },
          {
            id: 102n,
            directLowAgentDbId: 1n,
            directHighAgentDbId: 3n,
            kind: { tag: 'Direct' as const },
            title: undefined,
            creatorAgentDbId: 1n,
            membershipVersion: 1n,
            lastMessageId: 1n,

            messageCount: 1n,
            activeParticipantCount: 2n,
            messageRetentionMs: undefined,
            createdAt: timestamp(1n),
            updatedAt: timestamp(200n),
            lastMessageAt: timestamp(200n),
          },
        ],
        messages: [
          {
            id: 500n,
            threadId: 100n,
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
            id: 501n,
            threadId: 100n,
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
            id: 502n,
            threadId: 101n,
            idDescSortKey: 0n,
            membershipVersion: 1n,
            senderAgentDbId: 2n,
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
            id: 503n,
            threadId: 102n,
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
            createdAt: timestamp(200n),
            updatedAt: timestamp(1n),
          },
        ],
      },
      email: 'agent@example.com',
    });

    expect(result.totalInboxes).toBe(2);
    expect(result.results.map(item => item.slug)).toEqual(['patrick', 'alice']);
    expect(result.results[0]).toMatchObject({
      slug: 'patrick',
      threadCount: 2,
      newMessages: 2,
      latestThreadId: '101',
    });
    expect(result.results[1]).toMatchObject({
      slug: 'alice',
      threadCount: 1,
      newMessages: 1,
      latestThreadId: '102',
    });
  });

  it('filters lookup results by query and respects limit after sorting', () => {
    const result = buildInboxLookupEntries({
      snapshot: {
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
            accountId: 20n,
            email: 'patrick@example.com',
            slug: 'patrick',
            isDefault: true,
            publicIdentity: 'patrick',
            displayName: 'Patrick Tobler',
            currentKeyBundleVersion: 1,
            createdAt: timestamp(1n),
            updatedAt: timestamp(1n),
          }),
          actor({
            id: 3n,
            accountId: 30n,
            email: 'paul@example.com',
            slug: 'paul',
            isDefault: true,
            publicIdentity: 'paul',
            displayName: 'Paul',
            currentKeyBundleVersion: 1,
            createdAt: timestamp(1n),
            updatedAt: timestamp(1n),
          }),
        ],
        participants: [
          {
            id: 1n,
            threadId: 100n,
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
            threadId: 100n,
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
            threadId: 101n,
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
            threadId: 101n,
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
        ],
        contactRequests: [],
threadInvites: [],
readStates: [],
        secretEnvelopes: [],
        threads: [
          {
            id: 100n,
            directLowAgentDbId: 1n,
            directHighAgentDbId: 2n,
            kind: { tag: 'Direct' as const },
            title: undefined,
            creatorAgentDbId: 1n,
            membershipVersion: 1n,
            lastMessageId: 0n,

            messageCount: 0n,
            activeParticipantCount: 2n,
            messageRetentionMs: undefined,
            createdAt: timestamp(1n),
            updatedAt: timestamp(200n),
            lastMessageAt: timestamp(200n),
          },
          {
            id: 101n,
            directLowAgentDbId: 1n,
            directHighAgentDbId: 3n,
            kind: { tag: 'Direct' as const },
            title: undefined,
            creatorAgentDbId: 1n,
            membershipVersion: 1n,
            lastMessageId: 0n,

            messageCount: 0n,
            activeParticipantCount: 2n,
            messageRetentionMs: undefined,
            createdAt: timestamp(1n),
            updatedAt: timestamp(100n),
            lastMessageAt: timestamp(100n),
          },
        ],
        messages: [],
      },
      email: 'agent@example.com',
      query: 'pat',
      limit: 1,
    });

    expect(result.query).toBe('pat');
    expect(result.totalInboxes).toBe(1);
    expect(result.results.map(item => item.slug)).toEqual(['patrick']);
  });
});

describe('buildDiscoveredInboxLookupItems', () => {
  it('filters out owned actors and existing local contacts', () => {
    const result = buildDiscoveredInboxLookupItems({
      matchedActors: [
        {
          agentDbId: 2n,
          slug: 'existing-contact',
          displayName: 'Existing Contact',
          publicIdentity: 'contact-1',
          isDefault: true,
        },
        {
          agentDbId: 1n,
          slug: 'owned-default',
          displayName: 'Owned Default',
          publicIdentity: 'own-1',
          isDefault: true,
        },
        {
          agentDbId: 3n,
          slug: 'new-agent',
          displayName: 'New Agent',
          publicIdentity: 'new-1',
          isDefault: true,
        },
        {
          agentDbId: 4n,
          slug: 'new-agent-two',
          displayName: null,
          publicIdentity: 'new-2',
          isDefault: false,
        },
      ],
      existingPublicIdentities: new Set(['contact-1']),
      ownedPublicIdentities: new Set(['own-1']),
      limit: 10,
    });

    expect(result).toEqual([
      {
        slug: 'new-agent',
        displayName: 'New Agent',
        publicIdentity: 'new-1',
        isDefault: true,
      },
      {
        slug: 'new-agent-two',
        displayName: null,
        publicIdentity: 'new-2',
        isDefault: false,
      },
    ]);
  });
});
