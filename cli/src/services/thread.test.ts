import { describe, expect, it } from 'vitest';
import { Timestamp } from 'spacetimedb';
import {
  buildDirectInboxEntries,
  selectUnreadIncomingMessages,
} from '../../../shared/inbox-state';
import { paginateThreadHistory, type ThreadHistoryResult } from './thread';
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

describe('shared inbox selectors', () => {
  it('builds direct inbox entries that stay aligned for CLI and webapp', () => {
    const actors = [
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
    ];

    const entries = buildDirectInboxEntries({
      actors,
      threads: [
        {
          id: 100n,
          kind: 'direct',
          title: undefined,
          lastMessageAt: timestamp(400n),
          lastMessageSeq: 3n,
        },
      ],
      participants: [
        {
          threadId: 100n,
          agentDbId: 1n,
          active: true,
        },
        {
          threadId: 100n,
          agentDbId: 2n,
          active: true,
        },
      ],
      readStates: [
        {
          threadId: 100n,
          agentDbId: 1n,
          lastReadThreadSeq: 1n,
          archived: false,
        },
      ],
      ownInboxId: 10n,
      dateFormat: 'iso',
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      threadCount: 1,
      newMessages: 2,
      latestThreadId: 100n,
    });
    expect(entries[0]?.actor.slug).toBe('other');
    expect(entries[0]?.latestMessageAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('selects unread incoming messages from shared state', () => {
    const selection = selectUnreadIncomingMessages({
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
      readStates: [
        {
          threadId: 100n,
          agentDbId: 1n,
          lastReadThreadSeq: 1n,
          archived: false,
        },
      ],
      messages: [
        {
          threadId: 100n,
          threadSeq: 1n,
          senderAgentDbId: 2n,
          createdAt: timestamp(200n),
        },
        {
          threadId: 100n,
          threadSeq: 2n,
          senderAgentDbId: 2n,
          createdAt: timestamp(300n),
        },
        {
          threadId: 100n,
          threadSeq: 3n,
          senderAgentDbId: 1n,
          createdAt: timestamp(400n),
        },
      ],
      normalizedEmail: 'agent@example.com',
    });

    expect(selection?.defaultActor.slug).toBe('agent');
    expect(selection?.unreadMessages.map(message => message.threadSeq)).toEqual([2n]);
  });
});

describe('paginateThreadHistory', () => {
  it('slices thread history into stable pages', () => {
    const history: ThreadHistoryResult = {
      authenticated: true,
      connected: true,
      profile: 'default',
      actorSlug: 'agent',
      thread: {
        id: '100',
        kind: 'direct',
        label: 'Other',
        locked: true,
        archived: false,
      },
      lastReadThreadSeq: '0',
      totalMessages: 5,
      messages: Array.from({ length: 5 }, (_, index) => ({
        id: String(index + 1),
        threadSeq: String(index + 1),
        secretVersion: 'sec-v1',
        createdAt: '2026-04-13T00:00:00.000Z',
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

    const paginated = paginateThreadHistory(history, {
      page: 2,
      pageSize: 2,
    });

    expect(paginated.page).toBe(2);
    expect(paginated.totalPages).toBe(3);
    expect(paginated.previousPage).toBe(1);
    expect(paginated.nextPage).toBe(3);
    expect(paginated.messages.map(message => message.id)).toEqual(['3', '4']);
  });
});
