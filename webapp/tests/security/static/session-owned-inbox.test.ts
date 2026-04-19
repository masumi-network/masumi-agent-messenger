import { describe, expect, it } from 'vitest';
import {
  findDefaultOwnedActor,
  findSessionOwnedInbox,
} from '@/lib/app-shell';

describe('session-owned inbox helpers', () => {
  it('resolves the inbox by email, issuer, and subject instead of email alone', () => {
    const ownedInbox = findSessionOwnedInbox({
      inboxes: [
        {
          id: 1n,
          normalizedEmail: 'agent@example.com',
          authIssuer: 'https://issuer.example',
          authSubject: 'old-subject',
        },
        {
          id: 2n,
          normalizedEmail: 'agent@example.com',
          authIssuer: 'https://issuer.example',
          authSubject: 'current-subject',
        },
      ],
      session: {
        user: {
          email: 'agent@example.com',
          issuer: 'https://issuer.example',
          subject: 'current-subject',
        },
      },
    });

    expect(ownedInbox?.id).toBe(2n);
  });

  it('finds the default actor only within the resolved inbox', () => {
    const defaultActor = findDefaultOwnedActor(
      [
        {
          id: 1n,
          inboxId: 1n,
          normalizedEmail: 'agent@example.com',
          slug: 'legacy',
          isDefault: true,
          publicIdentity: 'did:legacy',
        },
        {
          id: 2n,
          inboxId: 2n,
          normalizedEmail: 'agent@example.com',
          slug: 'current',
          isDefault: true,
          publicIdentity: 'did:current',
        },
      ],
      2n
    );

    expect(defaultActor?.slug).toBe('current');
  });
});
