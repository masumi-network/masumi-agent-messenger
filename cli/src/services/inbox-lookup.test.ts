import { describe, expect, it } from 'vitest';
import { Timestamp } from 'spacetimedb';
import {
  buildDiscoveredInboxLookupItems,
  buildInboxLookupEntries,
} from './inbox-lookup';
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

describe('buildInboxLookupEntries', () => {
  it('aggregates direct threads by inbox slug, counts unread incoming messages, and sorts by latest message', () => {
    const result = buildInboxLookupEntries({
      snapshot: {
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
            inboxId: 20n,
            normalizedEmail: 'patrick@example.com',
            slug: 'patrick',
            inboxIdentifier: undefined,
            isDefault: true,
            publicIdentity: 'patrick',
            displayName: 'Patrick Tobler',
            currentEncryptionPublicKey: 'enc-2',
            currentEncryptionKeyVersion: 'enc-v1',
            currentSigningPublicKey: 'sig-2',
            currentSigningKeyVersion: 'sig-v1',
            createdAt: timestamp(1n),
            updatedAt: timestamp(1n),
          }),
          actor({
            id: 3n,
            inboxId: 30n,
            normalizedEmail: 'alice@example.com',
            slug: 'alice',
            inboxIdentifier: undefined,
            isDefault: true,
            publicIdentity: 'alice',
            displayName: 'Alice',
            currentEncryptionPublicKey: 'enc-3',
            currentEncryptionKeyVersion: 'enc-v1',
            currentSigningPublicKey: 'sig-3',
            currentSigningKeyVersion: 'sig-v1',
            createdAt: timestamp(1n),
            updatedAt: timestamp(1n),
          }),
        ],
        participants: [
          {
            id: 1n,
            threadId: 100n,
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
            threadId: 100n,
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
            threadId: 101n,
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
            threadId: 101n,
            agentDbId: 2n,
            joinedAt: timestamp(1n),
            lastSentSeq: 0n,
            lastSentMembershipVersion: undefined,
            lastSentSecretVersion: undefined,
            isAdmin: false,
            active: true,
          },
          {
            id: 5n,
            threadId: 102n,
            agentDbId: 1n,
            joinedAt: timestamp(1n),
            lastSentSeq: 0n,
            lastSentMembershipVersion: undefined,
            lastSentSecretVersion: undefined,
            isAdmin: true,
            active: true,
          },
          {
            id: 6n,
            threadId: 102n,
            agentDbId: 3n,
            joinedAt: timestamp(1n),
            lastSentSeq: 0n,
            lastSentMembershipVersion: undefined,
            lastSentSecretVersion: undefined,
            isAdmin: false,
            active: true,
          },
        ],
        contactRequests: [],
threadInvites: [],
readStates: [
          {
            id: 1n,
            threadId: 100n,
            agentDbId: 1n,
            lastReadThreadSeq: 1n,
            archived: false,
            updatedAt: timestamp(1n),
          },
          {
            id: 2n,
            threadId: 101n,
            agentDbId: 1n,
            lastReadThreadSeq: 0n,
            archived: false,
            updatedAt: timestamp(1n),
          },
          {
            id: 3n,
            threadId: 102n,
            agentDbId: 1n,
            lastReadThreadSeq: 0n,
            archived: false,
            updatedAt: timestamp(1n),
          },
        ],
        secretEnvelopes: [],
        threads: [
          {
            id: 100n,
            dedupeKey: 'direct:a:b',
            kind: 'direct',
            membershipLocked: false,
            title: undefined,
            creatorAgentDbId: 1n,
            membershipVersion: 1n,
            nextThreadSeq: 3n,
            lastMessageSeq: 2n,
            createdAt: timestamp(1n),
            updatedAt: timestamp(300n),
            lastMessageAt: timestamp(300n),
          },
          {
            id: 101n,
            dedupeKey: 'direct:a:b',
            kind: 'direct',
            membershipLocked: false,
            title: undefined,
            creatorAgentDbId: 1n,
            membershipVersion: 1n,
            nextThreadSeq: 2n,
            lastMessageSeq: 1n,
            createdAt: timestamp(1n),
            updatedAt: timestamp(400n),
            lastMessageAt: timestamp(400n),
          },
          {
            id: 102n,
            dedupeKey: 'direct:a:c',
            kind: 'direct',
            membershipLocked: false,
            title: undefined,
            creatorAgentDbId: 1n,
            membershipVersion: 1n,
            nextThreadSeq: 2n,
            lastMessageSeq: 1n,
            createdAt: timestamp(1n),
            updatedAt: timestamp(200n),
            lastMessageAt: timestamp(200n),
          },
        ],
        messages: [
          {
            id: 500n,
            threadId: 100n,
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
            id: 501n,
            threadId: 100n,
            threadSeq: 2n,
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
            id: 502n,
            threadId: 101n,
            threadSeq: 1n,
            membershipVersion: 1n,
            senderAgentDbId: 2n,
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
            id: 503n,
            threadId: 102n,
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
            createdAt: timestamp(200n),
          },
        ],
      },
      normalizedEmail: 'agent@example.com',
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
            inboxId: 20n,
            normalizedEmail: 'patrick@example.com',
            slug: 'patrick',
            inboxIdentifier: undefined,
            isDefault: true,
            publicIdentity: 'patrick',
            displayName: 'Patrick Tobler',
            currentEncryptionPublicKey: 'enc-2',
            currentEncryptionKeyVersion: 'enc-v1',
            currentSigningPublicKey: 'sig-2',
            currentSigningKeyVersion: 'sig-v1',
            createdAt: timestamp(1n),
            updatedAt: timestamp(1n),
          }),
          actor({
            id: 3n,
            inboxId: 30n,
            normalizedEmail: 'paul@example.com',
            slug: 'paul',
            inboxIdentifier: undefined,
            isDefault: true,
            publicIdentity: 'paul',
            displayName: 'Paul',
            currentEncryptionPublicKey: 'enc-3',
            currentEncryptionKeyVersion: 'enc-v1',
            currentSigningPublicKey: 'sig-3',
            currentSigningKeyVersion: 'sig-v1',
            createdAt: timestamp(1n),
            updatedAt: timestamp(1n),
          }),
        ],
        participants: [
          {
            id: 1n,
            threadId: 100n,
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
            threadId: 100n,
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
            threadId: 101n,
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
            threadId: 101n,
            agentDbId: 3n,
            joinedAt: timestamp(1n),
            lastSentSeq: 0n,
            lastSentMembershipVersion: undefined,
            lastSentSecretVersion: undefined,
            isAdmin: false,
            active: true,
          },
        ],
        contactRequests: [],
threadInvites: [],
readStates: [],
        secretEnvelopes: [],
        threads: [
          {
            id: 100n,
            dedupeKey: 'direct:a:b',
            kind: 'direct',
            membershipLocked: false,
            title: undefined,
            creatorAgentDbId: 1n,
            membershipVersion: 1n,
            nextThreadSeq: 1n,
            lastMessageSeq: 0n,
            createdAt: timestamp(1n),
            updatedAt: timestamp(200n),
            lastMessageAt: timestamp(200n),
          },
          {
            id: 101n,
            dedupeKey: 'direct:a:c',
            kind: 'direct',
            membershipLocked: false,
            title: undefined,
            creatorAgentDbId: 1n,
            membershipVersion: 1n,
            nextThreadSeq: 1n,
            lastMessageSeq: 0n,
            createdAt: timestamp(1n),
            updatedAt: timestamp(100n),
            lastMessageAt: timestamp(100n),
          },
        ],
        messages: [],
      },
      normalizedEmail: 'agent@example.com',
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
          slug: 'existing-contact',
          displayName: 'Existing Contact',
          publicIdentity: 'contact-1',
          isDefault: true,
        },
        {
          slug: 'owned-default',
          displayName: 'Owned Default',
          publicIdentity: 'own-1',
          isDefault: true,
        },
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
