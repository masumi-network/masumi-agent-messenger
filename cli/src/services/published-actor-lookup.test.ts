import { describe, expect, it, vi } from 'vitest';
import type { PublishedActorLookupLike } from '../../../shared/published-actors';
import { resolvePublishedActorLookup } from './published-actor-lookup';

describe('resolvePublishedActorLookup', () => {
  it('resolves an exact slug directly from SpacetimeDB', async () => {
    const lookupBySlug = vi.fn(async ({ slug }: { slug: string }) => {
      if (slug !== 'lisa-kuepers') {
        return [];
      }

      return [
        {
          slug: 'lisa-kuepers',
          publicIdentity: 'lisa-kuepers',
          isDefault: false,
          displayName: 'Lisa Kuepers',
          agentIdentifier: null,
          encryptionKeyVersion: 'enc-v1',
          encryptionPublicKey: 'enc-lisa',
          signingKeyVersion: 'sig-v1',
          signingPublicKey: 'sig-lisa',
        },
      ];
    });
    const lookupByEmail = vi.fn(async () => []);

    const result = await resolvePublishedActorLookup<PublishedActorLookupLike>({
      identifier: 'Lisa-kuepers',
      lookupBySlug,
      lookupByEmail,
    });

    expect(result.inputKind).toBe('slug');
    expect(result.selected.slug).toBe('lisa-kuepers');
    expect(result.selectedActor.displayName).toBe('Lisa Kuepers');
    expect(result.matchedActors.map(actor => actor.slug)).toEqual(['lisa-kuepers']);
    expect(lookupBySlug).toHaveBeenCalledWith({ slug: 'lisa-kuepers' });
  });

  it('resolves an exact email directly from SpacetimeDB and selects the default actor', async () => {
    const lookupBySlug = vi.fn(async () => []);
    const lookupByEmail = vi.fn(async () => [
      {
        slug: 'owner-build',
        publicIdentity: 'owner-build',
        isDefault: false,
        displayName: 'Owner Build',
        agentIdentifier: null,
        encryptionKeyVersion: 'enc-v1',
        encryptionPublicKey: 'enc-build',
        signingKeyVersion: 'sig-v1',
        signingPublicKey: 'sig-build',
      },
      {
        slug: 'owner',
        publicIdentity: 'owner',
        isDefault: true,
        displayName: 'Owner',
        agentIdentifier: 'agent-1',
        encryptionKeyVersion: 'enc-v1',
        encryptionPublicKey: 'enc',
        signingKeyVersion: 'sig-v1',
        signingPublicKey: 'sig',
      },
    ]);

    const result = await resolvePublishedActorLookup<PublishedActorLookupLike>({
      identifier: 'Owner@Example.com',
      lookupBySlug,
      lookupByEmail,
    });

    expect(result.inputKind).toBe('email');
    expect(result.selected.slug).toBe('owner');
    expect(result.selectedActor.isDefault).toBe(true);
    expect(result.matchedActors.map(actor => actor.slug)).toEqual(['owner-build', 'owner']);
    expect(lookupByEmail).toHaveBeenCalledWith({ email: 'owner@example.com' });
    expect(lookupBySlug).not.toHaveBeenCalled();
  });

  it('does not resolve a slug through fuzzy discovery results', async () => {
    const lookupBySlug = vi.fn(async () => []);
    const lookupByEmail = vi.fn(async () => []);

    await expect(
      resolvePublishedActorLookup<PublishedActorLookupLike>({
        identifier: 'owner',
        lookupBySlug,
        lookupByEmail,
      })
    ).rejects.toMatchObject({
      code: 'ACTOR_NOT_FOUND',
      message: 'No published inbox actor found for slug `owner`.',
    });

    expect(lookupBySlug).toHaveBeenCalledWith({ slug: 'owner' });
    expect(lookupByEmail).not.toHaveBeenCalled();
  });

  it('maps invalid identifiers to a CLI user error', async () => {
    await expect(
      resolvePublishedActorLookup<PublishedActorLookupLike>({
        identifier: '@example.com',
        lookupBySlug: vi.fn(),
        lookupByEmail: vi.fn(),
      })
    ).rejects.toMatchObject({
      code: 'INVALID_AGENT_IDENTIFIER',
      message: 'Inbox slug or email is invalid.',
    });
  });
});
