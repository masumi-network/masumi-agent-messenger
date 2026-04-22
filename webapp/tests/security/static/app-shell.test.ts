import { describe, expect, it } from 'vitest';
import {
  buildApprovalView,
  buildChannelNavEntries,
  buildOwnedInboxAgentEntries,
  buildWorkspaceSearch,
  deriveAppShellSection,
  evaluateWorkspaceWriteAccess,
  parseAgentsTab,
  parseComposeMode,
  parseOptionalThreadId,
  parseSecurityPanel,
  parseWorkspaceTab,
  resolveDashboardModal,
  resolveShellInboxSlug,
  resolveWorkspaceSnapshot,
} from '@/lib/app-shell';

describe('app shell helpers', () => {
  it('aggregates approvals globally and by slug', () => {
    const ownedActors = [
      {
        id: 1n,
        inboxId: 10n,
        normalizedEmail: 'owner@example.com',
        slug: 'alpha',
        isDefault: true,
        publicIdentity: 'did:alpha',
      },
      {
        id: 2n,
        inboxId: 10n,
        normalizedEmail: 'owner@example.com',
        slug: 'beta',
        isDefault: false,
        publicIdentity: 'did:beta',
      },
    ];
    const requests = [
      {
        id: 10n,
        requesterAgentDbId: 99n,
        requesterSlug: 'remote-a',
        targetAgentDbId: 1n,
        targetSlug: 'alpha',
        direction: 'incoming',
        status: 'pending',
        updatedAt: { microsSinceUnixEpoch: 40n },
      },
      {
        id: 11n,
        requesterAgentDbId: 2n,
        requesterSlug: 'beta',
        targetAgentDbId: 88n,
        targetSlug: 'remote-b',
        direction: 'outgoing',
        status: 'pending',
        updatedAt: { microsSinceUnixEpoch: 30n },
      },
      {
        id: 12n,
        requesterAgentDbId: 77n,
        requesterSlug: 'remote-c',
        targetAgentDbId: 2n,
        targetSlug: 'beta',
        direction: 'incoming',
        status: 'rejected',
        updatedAt: { microsSinceUnixEpoch: 20n },
      },
    ];

    const globalView = buildApprovalView({
      contactRequests: requests,
      ownedActors,
    });
    const filteredView = buildApprovalView({
      contactRequests: requests,
      ownedActors,
      selectedSlug: 'beta',
    });

    expect(globalView.pendingIncomingCount).toBe(1);
    expect(globalView.pendingOutgoingCount).toBe(1);
    expect(globalView.incoming.map(request => request.id)).toEqual([10n, 12n]);
    expect(filteredView.incoming.map(request => request.id)).toEqual([12n]);
    expect(filteredView.outgoing.map(request => request.id)).toEqual([11n]);
  });

  it('counts pending thread invites in approval views', () => {
    const view = buildApprovalView({
      contactRequests: [],
      threadInvites: [
        {
          id: 20n,
          inviterAgentDbId: 77n,
          inviterSlug: 'remote-a',
          inviteeAgentDbId: 1n,
          inviteeSlug: 'alpha',
          status: 'pending',
          updatedAt: { microsSinceUnixEpoch: 50n },
        },
        {
          id: 21n,
          inviterAgentDbId: 2n,
          inviterSlug: 'beta',
          inviteeAgentDbId: 88n,
          inviteeSlug: 'remote-b',
          status: 'pending',
          updatedAt: { microsSinceUnixEpoch: 40n },
        },
      ],
      ownedActors: [
        { id: 1n, slug: 'alpha' },
        { id: 2n, slug: 'beta' },
      ],
    });

    expect(view.pendingIncomingCount).toBe(1);
    expect(view.pendingOutgoingCount).toBe(1);
    expect(view.incomingThreadInvites.map(invite => invite.id)).toEqual([20n]);
    expect(view.outgoingThreadInvites.map(invite => invite.id)).toEqual([21n]);
  });

  it('derives the active shell section from the canonical routes', () => {
    expect(deriveAppShellSection('/')).toBe('inbox');
    expect(deriveAppShellSection('/planner-bot')).toBe('inbox');
    expect(deriveAppShellSection('/planner-bot/manage')).toBe('inbox');
    expect(deriveAppShellSection('/agents')).toBe('agents');
    expect(deriveAppShellSection('/security')).toBe('security');
    expect(deriveAppShellSection('/channels')).toBe('channels');
    expect(deriveAppShellSection('/channels/release-room')).toBe('channels');
  });

  it('builds channel sidebar entries with admin approval counts', () => {
    const entries = buildChannelNavEntries({
      channels: [
        {
          id: 10n,
          slug: 'release-room',
          title: 'Release room',
        },
        {
          id: 11n,
          slug: 'incident-feed',
          title: null,
        },
        {
          id: 12n,
          slug: 'remote-only',
          title: 'Remote only',
        },
      ],
      memberships: [
        {
          channelId: 10n,
          agentDbId: 1n,
          permission: 'read_write',
          active: true,
        },
        {
          channelId: 10n,
          agentDbId: 2n,
          permission: 'admin',
          active: true,
        },
        {
          channelId: 11n,
          agentDbId: 1n,
          permission: 'read',
          active: true,
        },
        {
          channelId: 12n,
          agentDbId: 99n,
          permission: 'admin',
          active: true,
        },
      ],
      joinRequests: [
        {
          channelId: 10n,
          direction: 'incoming',
          status: 'pending',
        },
        {
          channelId: 10n,
          direction: 'incoming',
          status: 'approved',
        },
        {
          channelId: 11n,
          direction: 'incoming',
          status: 'pending',
        },
      ],
      ownedActorIds: new Set([1n, 2n]),
    });

    expect(entries).toEqual([
      {
        channelId: 10n,
        slug: 'release-room',
        title: 'Release room',
        permission: 'admin',
        isAdmin: true,
        pendingApprovals: 1,
      },
      {
        channelId: 11n,
        slug: 'incident-feed',
        title: null,
        permission: 'read',
        isAdmin: false,
        pendingApprovals: 0,
      },
    ]);
  });

  it('opens recovery automatically only after bootstrap detects a key issue', () => {
    expect(
      resolveDashboardModal({
        defaultKeyIssue: null,
      })
    ).toBeNull();

    expect(
      resolveDashboardModal({
        bootstrapTriggered: true,
        defaultKeyIssue: 'missing',
      })
    ).toBe('recovery');

    expect(
      resolveDashboardModal({
        requestedModal: 'backups',
        bootstrapTriggered: true,
        defaultKeyIssue: 'mismatch',
      })
    ).toBe('backups');
  });

  it('builds owned inbox entries and resolves the current switcher slug', () => {
    const ownedEntries = buildOwnedInboxAgentEntries({
      actors: [
        {
          id: 3n,
          inboxId: 10n,
          normalizedEmail: 'owner@example.com',
          slug: 'custom',
          isDefault: false,
          publicIdentity: 'did:custom',
        },
        {
          id: 1n,
          inboxId: 10n,
          normalizedEmail: 'owner@example.com',
          slug: 'default',
          isDefault: true,
          publicIdentity: 'did:default',
          masumiInboxAgentId: 'agent-1',
          masumiAgentIdentifier: 'did:masumi:default',
          masumiRegistrationState: 'RegistrationConfirmed',
        },
      ],
      ownInboxId: 10n,
      normalizedEmail: 'owner@example.com',
    });

    expect(ownedEntries.map(entry => entry.actor.slug)).toEqual(['default', 'custom']);
    expect(ownedEntries[0]?.managed).toBe(true);
    expect(ownedEntries[0]?.registered).toBe(true);
    expect(ownedEntries[0]?.deregistered).toBe(false);
    expect(resolveShellInboxSlug(ownedEntries, 'custom')).toBe('custom');
    expect(resolveShellInboxSlug(ownedEntries, 'missing')).toBe('default');
  });

  it('does not treat pending cached Masumi metadata as registered in owned entries', () => {
    const ownedEntries = buildOwnedInboxAgentEntries({
      actors: [
        {
          id: 1n,
          inboxId: 10n,
          normalizedEmail: 'owner@example.com',
          slug: 'pending',
          isDefault: true,
          publicIdentity: 'did:pending',
          masumiInboxAgentId: 'agent-1',
          masumiAgentIdentifier: 'did:masumi:pending',
          masumiRegistrationState: 'RegistrationRequested',
        },
      ],
      ownInboxId: 10n,
      normalizedEmail: 'owner@example.com',
    });

    expect(ownedEntries[0]?.managed).toBe(true);
    expect(ownedEntries[0]?.registered).toBe(false);
    expect(ownedEntries[0]?.deregistered).toBe(false);
  });

  it('keeps deregistered owned agents visible but out of active selection', () => {
    const ownedEntries = buildOwnedInboxAgentEntries({
      actors: [
        {
          id: 1n,
          inboxId: 10n,
          normalizedEmail: 'owner@example.com',
          slug: 'old-agent',
          isDefault: true,
          publicIdentity: 'did:old',
          masumiInboxAgentId: 'agent-old',
          masumiAgentIdentifier: 'did:masumi:old',
          masumiRegistrationState: 'DeregistrationConfirmed',
        },
        {
          id: 2n,
          inboxId: 10n,
          normalizedEmail: 'owner@example.com',
          slug: 'current-agent',
          isDefault: false,
          publicIdentity: 'did:current',
        },
      ],
      ownInboxId: 10n,
      normalizedEmail: 'owner@example.com',
    });

    expect(ownedEntries.map(entry => entry.actor.slug)).toEqual([
      'old-agent',
      'current-agent',
    ]);
    expect(ownedEntries[0]?.deregistered).toBe(true);
    expect(resolveShellInboxSlug(ownedEntries, 'old-agent')).toBe('current-agent');

    const snapshot = resolveWorkspaceSnapshot({
      inboxes: [
        {
          id: 10n,
          normalizedEmail: 'owner@example.com',
          authIssuer: 'https://issuer.example',
          authSubject: 'current-subject',
        },
      ],
      actors: ownedEntries.map(entry => entry.actor),
      contactRequests: [],
      session: {
        user: {
          email: 'owner@example.com',
          issuer: 'https://issuer.example',
          subject: 'current-subject',
        },
      },
      selectedSlug: 'old-agent',
    });

    expect(snapshot.selectedActor?.slug).toBe('current-agent');
    expect(snapshot.shellInboxSlug).toBe('current-agent');
  });

  it('keeps agents with pending deregistration out of active selection', () => {
    const ownedEntries = buildOwnedInboxAgentEntries({
      actors: [
        {
          id: 1n,
          inboxId: 10n,
          normalizedEmail: 'owner@example.com',
          slug: 'leaving-agent',
          isDefault: true,
          publicIdentity: 'did:leaving',
          masumiInboxAgentId: 'agent-leaving',
          masumiAgentIdentifier: 'did:masumi:leaving',
          masumiRegistrationState: 'DeregistrationRequested',
        },
        {
          id: 2n,
          inboxId: 10n,
          normalizedEmail: 'owner@example.com',
          slug: 'current-agent',
          isDefault: false,
          publicIdentity: 'did:current',
        },
      ],
      ownInboxId: 10n,
      normalizedEmail: 'owner@example.com',
    });

    expect(ownedEntries[0]?.deregistered).toBe(true);
    expect(resolveShellInboxSlug(ownedEntries, 'leaving-agent')).toBe('current-agent');
  });

  it('parses optional route search helpers and canonical workspace tabs', () => {
    expect(parseOptionalThreadId('123')).toBe('123');
    expect(parseOptionalThreadId('')).toBeUndefined();
    expect(parseComposeMode('direct')).toBe('direct');
    expect(parseComposeMode('group')).toBe('group');
    expect(parseComposeMode('weird')).toBeUndefined();
    expect(parseSecurityPanel('recovery')).toBe('recovery');
    expect(parseSecurityPanel('backups')).toBe('backups');
    expect(parseSecurityPanel('other')).toBeUndefined();
    expect(parseAgentsTab('discover')).toBe('discover');
    expect(parseAgentsTab('agents')).toBe('agents');
    expect(parseAgentsTab('register')).toBe('agents');
    expect(parseWorkspaceTab('approvals')).toBe('approvals');
    expect(parseWorkspaceTab('settings')).toBeUndefined();
    expect(parseWorkspaceTab('inbox')).toBeUndefined();
  });

  it('builds canonical workspace search state for the new tabbed inbox layout', () => {
    expect(
      buildWorkspaceSearch({
        thread: '42',
        compose: 'add',
        lookup: 'remote-bot',
        tab: 'approvals',
      })
    ).toEqual({
      thread: '42',
      compose: 'direct',
      lookup: 'remote-bot',
      tab: 'approvals',
    });

    expect(
      buildWorkspaceSearch({
        tab: 'inbox',
      })
    ).toEqual({
      thread: undefined,
      compose: undefined,
      lookup: undefined,
      tab: undefined,
    });
  });

  it('resolves the workspace snapshot from the authenticated inbox and selected slug', () => {
    const snapshot = resolveWorkspaceSnapshot({
      inboxes: [
        {
          id: 1n,
          normalizedEmail: 'owner@example.com',
          authIssuer: 'https://issuer.example',
          authSubject: 'legacy-subject',
        },
        {
          id: 2n,
          normalizedEmail: 'owner@example.com',
          authIssuer: 'https://issuer.example',
          authSubject: 'current-subject',
        },
      ],
      actors: [
        {
          id: 10n,
          inboxId: 1n,
          normalizedEmail: 'owner@example.com',
          slug: 'legacy',
          isDefault: true,
          publicIdentity: 'did:legacy',
        },
        {
          id: 20n,
          inboxId: 2n,
          normalizedEmail: 'owner@example.com',
          slug: 'home',
          isDefault: true,
          publicIdentity: 'did:home',
        },
        {
          id: 21n,
          inboxId: 2n,
          normalizedEmail: 'owner@example.com',
          slug: 'project',
          isDefault: false,
          publicIdentity: 'did:project',
        },
      ],
      contactRequests: [
        {
          id: 100n,
          requesterAgentDbId: 9n,
          requesterSlug: 'remote-a',
          targetAgentDbId: 21n,
          targetSlug: 'project',
          direction: 'incoming',
          status: 'pending',
          updatedAt: { microsSinceUnixEpoch: 30n },
        },
        {
          id: 101n,
          requesterAgentDbId: 21n,
          requesterSlug: 'project',
          targetAgentDbId: 8n,
          targetSlug: 'remote-b',
          direction: 'outgoing',
          status: 'pending',
          updatedAt: { microsSinceUnixEpoch: 20n },
        },
      ],
      session: {
        user: {
          email: 'owner@example.com',
          issuer: 'https://issuer.example',
          subject: 'current-subject',
        },
      },
      selectedSlug: 'project',
    });

    expect(snapshot.normalizedEmail).toBe('owner@example.com');
    expect(snapshot.ownedInbox?.id).toBe(2n);
    expect(snapshot.existingDefaultActor?.slug).toBe('home');
    expect(snapshot.selectedActor?.slug).toBe('project');
    expect(snapshot.shellInboxSlug).toBe('project');
    expect(snapshot.ownedInboxAgents.map(entry => entry.actor.slug)).toEqual([
      'home',
      'project',
    ]);
    expect(snapshot.approvalView.pendingIncomingCount).toBe(1);
    expect(snapshot.approvalView.pendingOutgoingCount).toBe(1);
  });

  it('enforces write access using email, issuer, subject, and connection identity', () => {
    const inbox = {
      id: 2n,
      normalizedEmail: 'owner@example.com',
      authIssuer: 'https://issuer.example',
      authSubject: 'current-subject',
      ownerIdentity: {
        toHexString() {
          return '0x-owner';
        },
      },
    };

    expect(
      evaluateWorkspaceWriteAccess({
        connected: true,
        session: {
          user: {
            email: 'owner@example.com',
            issuer: 'https://issuer.example',
            subject: 'other-subject',
          },
        },
        normalizedSessionEmail: 'owner@example.com',
        inbox,
        connectionIdentity: {
          toHexString() {
            return '0x-owner';
          },
        },
        hasActor: true,
      })
    ).toEqual({
      canWrite: false,
      reason: 'Current OIDC subject is not authorized to write to this inbox slug.',
    });

    expect(
      evaluateWorkspaceWriteAccess({
        connected: true,
        session: {
          user: {
            email: 'owner@example.com',
            issuer: 'https://issuer.example',
            subject: 'current-subject',
          },
        },
        normalizedSessionEmail: 'owner@example.com',
        inbox,
        connectionIdentity: {
          toHexString() {
            return '0x-someone-else';
          },
        },
        hasActor: true,
      })
    ).toEqual({
      canWrite: false,
      reason:
        'The live SpacetimeDB connection identity does not match this inbox owner.',
    });

    expect(
      evaluateWorkspaceWriteAccess({
        connected: true,
        session: {
          user: {
            email: 'owner@example.com',
            issuer: 'https://issuer.example',
            subject: 'current-subject',
          },
        },
        normalizedSessionEmail: 'owner@example.com',
        inbox,
        connectionIdentity: {
          toHexString() {
            return '0x-owner';
          },
        },
        hasActor: true,
      })
    ).toEqual({
      canWrite: true,
      reason: null,
    });
  });
});
