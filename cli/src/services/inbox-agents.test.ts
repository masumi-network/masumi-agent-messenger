import { describe, expect, it } from 'vitest';
import { Timestamp } from 'spacetimedb';
import type { VisibleAgentRow } from '../../../webapp/src/module_bindings/types';
import { buildOwnedInboxAgents } from './inbox-agents';

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
        | 'masumiRegistrationNetwork'
        | 'masumiInboxAgentId'
        | 'masumiAgentIdentifier'
        | 'masumiRegistrationState'
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
          inboxId: 10n,
          normalizedEmail: 'owner@example.com',
          slug: 'owner',
          inboxIdentifier: undefined,
          isDefault: true,
          publicIdentity: 'owner',
          displayName: 'Owner',
          currentEncryptionPublicKey: 'enc',
          currentEncryptionKeyVersion: 'enc-v1',
          currentSigningPublicKey: 'sig',
          currentSigningKeyVersion: 'sig-v1',
          masumiAgentIdentifier: 'agent-1',
          createdAt: timestamp(1n),
          updatedAt: timestamp(1n),
        }),
        actor({
          id: 2n,
          inboxId: 10n,
          normalizedEmail: 'owner@example.com',
          slug: 'owner-build',
          inboxIdentifier: undefined,
          isDefault: false,
          publicIdentity: 'owner-build',
          displayName: 'Owner Build',
          currentEncryptionPublicKey: 'enc-2',
          currentEncryptionKeyVersion: 'enc-v1',
          currentSigningPublicKey: 'sig-2',
          currentSigningKeyVersion: 'sig-v1',
          createdAt: timestamp(1n),
          updatedAt: timestamp(1n),
        }),
        actor({
          id: 3n,
          inboxId: 99n,
          normalizedEmail: 'other@example.com',
          slug: 'other',
          inboxIdentifier: undefined,
          isDefault: true,
          publicIdentity: 'other',
          displayName: 'Other',
          currentEncryptionPublicKey: 'enc-3',
          currentEncryptionKeyVersion: 'enc-v1',
          currentSigningPublicKey: 'sig-3',
          currentSigningKeyVersion: 'sig-v1',
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
