import { describe, expect, it } from 'vitest';
import { Timestamp } from 'spacetimedb';
import type { Agent } from '../../../webapp/src/module_bindings/types';
import { buildOwnedInboxAgents } from './inbox-agents';

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
        | 'masumiRegistrationNetwork'
        | 'masumiInboxAgentId'
        | 'masumiAgentIdentifier'
        | 'masumiRegistrationState'
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
    masumiRegistrationNetwork: row.masumiRegistrationNetwork,
    masumiInboxAgentId: row.masumiInboxAgentId,
    masumiAgentIdentifier: row.masumiAgentIdentifier,
    masumiRegistrationState: row.masumiRegistrationState,
  };
}

describe('buildOwnedInboxAgents', () => {
  it('filters to the authenticated inbox and sorts default-first', () => {
    const agents = buildOwnedInboxAgents(
      [
        actor({
          id: 1n,
          accountId: 10n,
          email: 'owner@example.com',
          slug: 'owner',
          isDefault: true,
          publicIdentity: 'owner',
          displayName: 'Owner',
          currentKeyBundleVersion: 1,
          masumiAgentIdentifier: 'agent-1',
          createdAt: timestamp(1n),
          updatedAt: timestamp(1n),
        }),
        actor({
          id: 2n,
          accountId: 10n,
          email: 'owner@example.com',
          slug: 'owner-build',
          isDefault: false,
          publicIdentity: 'owner-build',
          displayName: 'Owner Build',
          currentKeyBundleVersion: 1,
          createdAt: timestamp(1n),
          updatedAt: timestamp(1n),
        }),
        actor({
          id: 3n,
          accountId: 99n,
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
      'owner@example.com'
    );

    expect(agents.map(agent => agent.slug)).toEqual(['owner', 'owner-build']);
    expect(agents[0]).toMatchObject({
      isDefault: true,
      managed: true,
      agentIdentifier: 'agent-1',
    });
    expect(agents[1]).toMatchObject({
      isDefault: false,
      managed: false,
    });
  });
});
