import { describe, expect, it } from 'vitest';
import { findDirectThreads } from '../../../../shared/inbox-state';

describe('direct thread selectors', () => {
  it('keeps duplicate direct threads visible and sorts them deterministically', () => {
    const threads = findDirectThreads(
      [
        {
          id: 3n,
          kind: 'direct',
          dedupeKey: 'direct:alice:bob',
          lastMessageAt: { microsSinceUnixEpoch: 200n },
          lastMessageSeq: 5n,
        },
        {
          id: 7n,
          kind: 'direct',
          dedupeKey: 'direct:alice:bob',
          lastMessageAt: { microsSinceUnixEpoch: 200n },
          lastMessageSeq: 6n,
        },
        {
          id: 2n,
          kind: 'direct',
          dedupeKey: 'direct:alice:bob',
          lastMessageAt: { microsSinceUnixEpoch: 150n },
          lastMessageSeq: 4n,
        },
        {
          id: 9n,
          kind: 'group',
          dedupeKey: 'direct:alice:bob',
          lastMessageAt: { microsSinceUnixEpoch: 999n },
          lastMessageSeq: 1n,
        },
      ],
      { publicIdentity: 'alice' },
      'bob'
    );

    expect(threads.map(thread => thread.id)).toEqual([7n, 3n, 2n]);
    expect(threads.every(thread => thread.dedupeKey === 'direct:alice:bob')).toBe(true);
  });
});
