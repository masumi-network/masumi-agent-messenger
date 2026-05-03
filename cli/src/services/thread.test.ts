import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Timestamp } from 'spacetimedb';
import {
  buildDirectInboxEntries,
  selectUnreadIncomingMessages,
} from '../../../shared/inbox-state';
import { paginateThreadHistory, type ThreadHistoryResult } from './thread';
import type { Agent } from '../../../webapp/src/module_bindings/types';

function timestamp(microsSinceUnixEpoch: bigint) {
  return new Timestamp(microsSinceUnixEpoch);
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

describe('shared inbox selectors', () => {
  it('builds direct inbox entries that stay aligned for CLI and webapp', () => {
    const actors = [
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
        email: 'other@example.com',
        slug: 'other',
        isDefault: true,
        publicIdentity: 'other',
        displayName: 'Other',
        currentKeyBundleVersion: 1,
        createdAt: timestamp(1n),
        updatedAt: timestamp(1n),
      }),
    ];

    const entries = buildDirectInboxEntries({
      actors,
      threads: [
        {
          id: 100n,
          kind: { tag: 'Direct' as const },
          directLowAgentDbId: 1n,
          directHighAgentDbId: 2n,
          title: undefined,
          lastMessageAt: timestamp(400n),
        },
      ],
      participants: [
        {
          threadId: 100n,
          agentDbId: 1n,
          active: true,
          lastReadMessageId: 1n,
          archived: false,
        },
        {
          threadId: 100n,
          agentDbId: 2n,
          active: true,
        },
      ],
      messages: [
        { threadId: 100n, id: 1n, senderAgentDbId: 2n, createdAt: timestamp(1n) },
        { threadId: 100n, id: 2n, senderAgentDbId: 2n, createdAt: timestamp(2n) },
        { threadId: 100n, id: 3n, senderAgentDbId: 2n, createdAt: timestamp(3n) },
      ],
      ownAccountId: 10n,
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
          threadId: 100n,
          agentDbId: 1n,
          active: true,
          lastReadMessageId: 1n,
          archived: false,
        },
      ],
      messages: [
        {
          threadId: 100n,
          id: 1n,
          senderAgentDbId: 2n,
          createdAt: timestamp(200n),
        },
        {
          threadId: 100n,
          id: 2n,
          senderAgentDbId: 2n,
          createdAt: timestamp(300n),
        },
        {
          threadId: 100n,
          id: 3n,
          senderAgentDbId: 1n,
          createdAt: timestamp(400n),
        },
      ],
      email: 'agent@example.com',
    });

    expect(selection?.defaultActor.slug).toBe('agent');
    expect(selection?.unreadMessages.map(message => message.id)).toEqual([2n]);
  });
});

describe('thread reducer routing', () => {
  // Static guard: the renamed `updateThreadReadState` reducer replaced the legacy
  // `markThreadRead` + `setThreadArchived` pair. If a refactor accidentally reintroduces the
  // old names, this fails before runtime tests would catch a 404 from the new Rust module.
  const threadSource = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), 'thread.ts'),
    'utf8'
  );

  it('routes markThreadRead and setThreadArchived through updateThreadReadState', () => {
    expect(threadSource).toMatch(/conn\.reducers\.updateThreadReadState\(/);
    expect(threadSource).not.toMatch(/conn\.reducers\.markThreadRead\b/);
    expect(threadSource).not.toMatch(/conn\.reducers\.setThreadArchived\b/);
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
      lastReadMessageId: '0',
      totalMessages: 5,
      messages: Array.from({ length: 5 }, (_, index) => ({
        id: String(index + 1),
        messageId: String(index + 1),
        secretVersion: '1',
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
        trustNotice: null,
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
