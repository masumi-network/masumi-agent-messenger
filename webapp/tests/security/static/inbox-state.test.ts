import { describe, expect, it } from 'vitest';
import { buildDirectInboxEntries, findDirectThreads } from '../../../../shared/inbox-state';

describe('direct thread selectors', () => {
  it('keeps duplicate direct threads visible and sorts them deterministically', () => {
    const threads = findDirectThreads(
      [
        {
          id: 3n,
          kind: 'direct',
          directLowAgentDbId: 1n,
          directHighAgentDbId: 2n,
          lastMessageAt: { microsSinceUnixEpoch: 200n },
          lastMessageId: 5n,
        },
        {
          id: 7n,
          kind: 'direct',
          directLowAgentDbId: 1n,
          directHighAgentDbId: 2n,
          lastMessageAt: { microsSinceUnixEpoch: 200n },
          lastMessageId: 6n,
        },
        {
          id: 2n,
          kind: 'direct',
          directLowAgentDbId: 1n,
          directHighAgentDbId: 2n,
          lastMessageAt: { microsSinceUnixEpoch: 150n },
          lastMessageId: 4n,
        },
        {
          id: 9n,
          kind: 'group',
          directLowAgentDbId: 1n,
          directHighAgentDbId: 2n,
          lastMessageAt: { microsSinceUnixEpoch: 999n },
          lastMessageId: 1n,
        },
      ],
      1n,
      2n
    );

    expect(threads.map(thread => thread.id)).toEqual([7n, 3n, 2n]);
    expect(
      threads.every(
        thread => thread.directLowAgentDbId === 1n && thread.directHighAgentDbId === 2n
      )
    ).toBe(true);
  });

  it('does not count archived direct threads as unread', () => {
    const entries = buildDirectInboxEntries({
      actors: [
        {
          id: 1n,
          accountId: 10n,
          email: 'alice@example.com',
          slug: 'alice',
          isDefault: true,
          publicIdentity: 'alice',
        },
        {
          id: 2n,
          accountId: 20n,
          email: 'bob@example.com',
          slug: 'bob',
          isDefault: true,
          publicIdentity: 'bob',
        },
      ],
      threads: [
        {
          id: 99n,
          kind: 'direct',
          directLowAgentDbId: 1n,
          directHighAgentDbId: 2n,
          lastMessageId: 3n,
          lastMessageAt: { microsSinceUnixEpoch: 300n },
        },
      ],
      participants: [
        {
          threadId: 99n,
          agentDbId: 1n,
          active: true,
          archived: true,
          lastReadMessageId: 0n,
        },
        {
          threadId: 99n,
          agentDbId: 2n,
          active: true,
        },
      ],
      messages: [
        {
          id: 1n,
          threadId: 99n,
          senderAgentDbId: 2n,
          createdAt: { microsSinceUnixEpoch: 100n },
        },
        {
          id: 2n,
          threadId: 99n,
          senderAgentDbId: 2n,
          createdAt: { microsSinceUnixEpoch: 200n },
        },
        {
          id: 3n,
          threadId: 99n,
          senderAgentDbId: 2n,
          createdAt: { microsSinceUnixEpoch: 300n },
        },
      ],
      ownAccountId: 10n,
      dateFormat: 'iso',
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.newMessages).toBe(0);
  });
});
