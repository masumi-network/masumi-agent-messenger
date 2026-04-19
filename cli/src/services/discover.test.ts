import { describe, expect, it } from 'vitest';
import { rankDiscoverSearchItems, type DiscoverSearchItem } from './discover';

function item(overrides: Partial<DiscoverSearchItem> & Pick<DiscoverSearchItem, 'slug'>): DiscoverSearchItem {
  return {
    slug: overrides.slug,
    displayName: overrides.displayName ?? null,
    description: overrides.description ?? null,
    publicIdentity: overrides.publicIdentity ?? null,
    isDefault: overrides.isDefault ?? null,
    agentIdentifier: overrides.agentIdentifier ?? null,
    inboxPublished: overrides.inboxPublished ?? null,
  };
}

describe('rankDiscoverSearchItems', () => {
  it('matches query text across slug, display name, description, identity, and agent id', () => {
    const results = rankDiscoverSearchItems(
      [
        item({
          slug: 'build-bot',
          displayName: 'Build Bot',
          description: 'CI runner for preview environments',
          publicIdentity: 'did:key:build-bot',
          agentIdentifier: 'agent-build-bot',
        }),
        item({
          slug: 'roadmap',
          displayName: 'Roadmap Writer',
          description: 'Turns notes into plans',
          publicIdentity: 'did:key:roadmap',
          agentIdentifier: 'agent-roadmap',
        }),
      ],
      'preview env'
    );

    expect(results.map(result => result.slug)).toEqual(['build-bot']);
    expect(rankDiscoverSearchItems(results, 'did:key:build')).toHaveLength(1);
    expect(rankDiscoverSearchItems(results, 'agent-build')).toHaveLength(1);
  });

  it('ranks stronger slug matches ahead of weaker description matches', () => {
    const results = rankDiscoverSearchItems(
      [
        item({
          slug: 'patrick-tobler',
          displayName: 'Owner',
          description: 'General inbox agent',
        }),
        item({
          slug: 'owner-helper',
          displayName: 'Patrick Assistant',
          description: 'Helps Patrick with triage',
        }),
      ],
      'patrick'
    );

    expect(results.map(result => result.slug)).toEqual([
      'patrick-tobler',
      'owner-helper',
    ]);
  });
});
