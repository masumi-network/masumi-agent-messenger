import { describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'spacetimedb';
import type {
  VisibleAgentRow,
  VisibleContactAllowlistEntryRow,
  VisibleContactRequestRow,
  VisibleThreadInviteRow,
} from '../../../webapp/src/module_bindings/types';
import type { TaskReporter } from './command-runtime';

type ContactRows = {
  actors: VisibleAgentRow[];
  contactRequests: VisibleContactRequestRow[];
  threadInvites: VisibleThreadInviteRow[];
  allowlistEntries: VisibleContactAllowlistEntryRow[];
};

function timestamp(microsSinceUnixEpoch: bigint): Timestamp {
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
  >
): VisibleAgentRow {
  return {
    ...row,
    publicDescription: undefined,
    publicLinkedEmailEnabled: false,
    allowAllMessageContentTypes: false,
    allowAllMessageHeaders: false,
    supportedMessageContentTypes: undefined,
    supportedMessageHeaderNames: undefined,
    currentEncryptionAlgorithm: 'ecdh-p256-v1',
    currentSigningAlgorithm: 'ecdsa-p256-sha256-v1',
    masumiRegistrationNetwork: undefined,
    masumiInboxAgentId: undefined,
    masumiAgentIdentifier: undefined,
    masumiRegistrationState: undefined,
  };
}

function contactRequest(
  row: Omit<
    VisibleContactRequestRow,
    | 'requesterDisplayName'
    | 'requesterLinkedEmail'
    | 'targetDisplayName'
    | 'targetLinkedEmail'
    | 'resolvedAt'
    | 'resolvedByAgentDbId'
  > &
    Partial<
      Pick<
        VisibleContactRequestRow,
        | 'requesterDisplayName'
        | 'requesterLinkedEmail'
        | 'targetDisplayName'
        | 'targetLinkedEmail'
        | 'resolvedAt'
        | 'resolvedByAgentDbId'
      >
    >
): VisibleContactRequestRow {
  return {
    ...row,
    requesterDisplayName: row.requesterDisplayName,
    requesterLinkedEmail: row.requesterLinkedEmail,
    targetDisplayName: row.targetDisplayName,
    targetLinkedEmail: row.targetLinkedEmail,
    resolvedAt: row.resolvedAt,
    resolvedByAgentDbId: row.resolvedByAgentDbId,
  };
}

const reporter: TaskReporter = {
  info() {},
  success() {},
  verbose() {},
};

describe('resolveContactRequest', () => {
  it('approves requests for a secondary owned actor without falling back to the default actor', async () => {
    vi.resetModules();

    const defaultActor = actor({
      id: 1n,
      inboxId: 10n,
      normalizedEmail: 'sebastian@example.com',
      slug: 'sebastian-kuepers-gmail-com',
      inboxIdentifier: undefined,
      isDefault: true,
      publicIdentity: 'seb',
      displayName: 'Sebastian',
      currentEncryptionPublicKey: 'enc-1',
      currentEncryptionKeyVersion: 'enc-v1',
      currentSigningPublicKey: 'sig-1',
      currentSigningKeyVersion: 'sig-v1',
      createdAt: timestamp(1n),
      updatedAt: timestamp(1n),
    });
    const lisaActor = actor({
      id: 2n,
      inboxId: 10n,
      normalizedEmail: 'sebastian@example.com',
      slug: 'lisa-kuepers',
      inboxIdentifier: undefined,
      isDefault: false,
      publicIdentity: 'lisa',
      displayName: 'Lisa',
      currentEncryptionPublicKey: 'enc-2',
      currentEncryptionKeyVersion: 'enc-v1',
      currentSigningPublicKey: 'sig-2',
      currentSigningKeyVersion: 'sig-v1',
      createdAt: timestamp(1n),
      updatedAt: timestamp(1n),
    });
    const pendingRequest = contactRequest({
      id: 42n,
      threadId: 100n,
      requesterAgentDbId: 9n,
      requesterPublicIdentity: 'external',
      requesterSlug: 'external-agent',
      requesterNormalizedEmail: 'external@example.com',
      requesterDisplayEmail: 'external@example.com',
      targetAgentDbId: lisaActor.id,
      targetPublicIdentity: lisaActor.publicIdentity,
      targetSlug: lisaActor.slug,
      direction: 'incoming',
      status: 'pending',
      messageCount: 1n,
      createdAt: timestamp(2n),
      updatedAt: timestamp(3n),
    });
    const approvedRequest = contactRequest({
      ...pendingRequest,
      status: 'approved',
      resolvedAt: timestamp(4n),
      resolvedByAgentDbId: lisaActor.id,
    });
    let rows: ContactRows = {
      actors: [defaultActor, lisaActor],
      contactRequests: [pendingRequest],
      threadInvites: [],
      allowlistEntries: [],
    };
    const approveContactRequest = vi.fn(async () => {
      rows = {
        ...rows,
        contactRequests: [approvedRequest],
      };
    });
    const rejectContactRequest = vi.fn(async () => {});
    const unsubscribe = vi.fn();

    vi.doMock('./auth', () => ({
      ensureAuthenticatedSession: vi.fn(async () => ({
        profile: {
          name: 'default',
          spacetimeHost: 'ws://localhost:3000',
          spacetimeDbName: 'agentmessenger-dev',
        },
        session: {
          idToken: 'id-token',
        },
        claims: {
          email: 'sebastian@example.com',
        },
      })),
    }));
    vi.doMock('./spacetimedb', () => ({
      connectAuthenticated: vi.fn(async () => ({
        conn: {
          reducers: {
            approveContactRequest,
            rejectContactRequest,
          },
        },
      })),
      disconnectConnection: vi.fn(),
      readContactRows: vi.fn(() => rows),
      subscribeContactTables: vi.fn(async () => ({
        unsubscribe,
      })),
    }));

    const { resolveContactRequest } = await import('./contact-management');

    const result = await resolveContactRequest({
      profileName: 'default',
      reporter,
      requestId: '#42',
      action: 'approve',
    });

    expect(approveContactRequest).toHaveBeenCalledWith({
      agentDbId: lisaActor.id,
      requestId: pendingRequest.id,
    });
    expect(rejectContactRequest).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      profile: 'default',
      requestId: '42',
      status: 'approved',
      slug: 'lisa-kuepers',
    });
  });
});
