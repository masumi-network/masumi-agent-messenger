import { useEffect, useMemo, useRef, useState } from 'react';
import { useReducer, useSpacetimeDB } from 'spacetimedb/tanstack';
import { useAuthSession, type AuthenticatedBrowserSession } from '@/lib/auth-session';
import {
  buildChannelNavEntries,
  resolveWorkspaceSnapshot,
  type ChannelNavEntry,
  type OwnedInboxAgentEntry,
} from '@/lib/app-shell';
import { deferEffectStateUpdate } from '@/lib/effect-state';
import { syncBrowserInboxAgentRegistration } from '@/lib/inbox-agent-registration';
import { useLiveTable } from '@/lib/spacetime-live-table';
import {
  readAllOwnedAgents,
  readPendingChannelJoinRequests,
  readPendingContactRequests,
  readPendingThreadInvites,
} from '@/lib/spacetime-procedure-reads';
import { useProcedureSnapshot } from '@/lib/spacetime-procedure-snapshot';
import { reducers, tables } from '@/module_bindings';
import type { MasumiRegistrationResult } from '../../../../shared/inbox-agent-registration';
import type {
  Agent,
  Account,
  ChannelJoinRequest,
  ChannelMember,
  Channel,
  ContactRequest,
  ThreadInvite,
  AccountChangeSignal,
} from '@/module_bindings/types';
import { buildMasumiRegistrationSyncKey } from './actor-settings';
import { isOidcTokenExpiredError } from '@/lib/session-recovery';
import { useOidcSessionRecovery } from '@/hooks/use-oidc-session-recovery';

type RefreshedWorkspaceAgentRegistration = {
  sourceSyncKey: string | null;
  actor: Agent;
  registration: MasumiRegistrationResult;
};

type OwnedInboxAgentRegistrationRefresh = {
  busy: boolean;
  targetIds: Set<string>;
  refreshKey: string;
  completedKey: string | null;
  resultsByActorId: Record<string, RefreshedWorkspaceAgentRegistration>;
  errorsByActorId: Record<string, string>;
};

export type WorkspaceShellReadyState = {
  status: 'ready';
  auth: ReturnType<typeof useAuthSession>;
  session: AuthenticatedBrowserSession;
  conn: ReturnType<typeof useSpacetimeDB>;
  connected: boolean;
  connectionError: string | null;
  inboxes: Account[];
  actors: Agent[];
  contactRequests: ContactRequest[];
  threadInvites: ThreadInvite[];
  inboxesReady: boolean;
  actorsReady: boolean;
  contactRequestsReady: boolean;
  threadInvitesReady: boolean;
  channelTablesReady: boolean;
  tablesReady: boolean;
  tablesError: string | null;
  channelTablesError: string | null;
  email: string;
  ownedInbox: Account | null;
  existingDefaultActor: Agent | null;
  ownedInboxAgents: OwnedInboxAgentEntry<Agent>[];
  channelNavEntries: ChannelNavEntry[];
  ownedInboxAgentRegistrationRefresh: OwnedInboxAgentRegistrationRefresh;
  selectedActor: Agent | null;
  shellInboxSlug: string | null;
  approvalView: {
    incoming: ContactRequest[];
    outgoing: ContactRequest[];
    incomingThreadInvites: ThreadInvite[];
    outgoingThreadInvites: ThreadInvite[];
    pendingIncomingCount: number;
    pendingOutgoingCount: number;
  };
};

export type WorkspaceShellState =
  | {
      status: 'loading' | 'error' | 'signed_out' | 'verified_email_required';
      auth: ReturnType<typeof useAuthSession>;
      conn: ReturnType<typeof useSpacetimeDB>;
      session: AuthenticatedBrowserSession | null;
    }
  | WorkspaceShellReadyState;

export function useWorkspaceShell(params?: {
  selectedSlug?: string | null;
}): WorkspaceShellState {
  const auth = useAuthSession();
  const refreshAuthSession = auth.refresh;
  const conn = useSpacetimeDB();
  const session = auth.status === 'authenticated' ? auth.session : null;
  const rawConnectionError = conn.connectionError?.message ?? null;
  const recoveringConnectionSession =
    useOidcSessionRecovery(rawConnectionError);
  const upsertMasumiRegistrationReducer = useReducer(
    reducers.upsertMasumiRegistration
  );
  const [refreshedRegistrationByActorId, setRefreshedRegistrationByActorId] =
    useState<Record<string, RefreshedWorkspaceAgentRegistration>>({});
  const [completedOwnedAgentRegistrationRefreshKey, setCompletedOwnedAgentRegistrationRefreshKey] =
    useState<string | null>(null);
  const [ownedAgentRegistrationRefreshBusy, setOwnedAgentRegistrationRefreshBusy] =
    useState(false);
  const [ownedAgentRegistrationRefreshErrors, setOwnedAgentRegistrationRefreshErrors] =
    useState<Record<string, string>>({});
  const recoveredExpiredTokenRef = useRef<string | null>(null);

  const [inboxes, inboxesReady, inboxesError] = useLiveTable<Account>(
    tables.visible_accounts,
    'visible_accounts'
  );
  const [accountSignals] = useLiveTable<AccountChangeSignal>(
    tables.visible_account_change_signal,
    'visible_account_change_signal'
  );
  const accountSignal = accountSignals[0] ?? null;
  const [actors, actorsReady, actorsError] =
    useProcedureSnapshot<Agent>(
      readAllOwnedAgents,
      accountSignal?.ownedAgentsVersion.toString() ?? null
    );
  const [contactRequests, contactRequestsReady, contactRequestsError] =
    useProcedureSnapshot<ContactRequest>(
      readPendingContactRequests,
      accountSignal?.contactRequestsVersion.toString() ?? null
    );
  const [threadInvites, threadInvitesReady, threadInvitesError] =
    useProcedureSnapshot<ThreadInvite>(
      readPendingThreadInvites,
      accountSignal?.threadInvitesVersion.toString() ?? null
    );
  const [visible_channels, visible_channelsReady, visible_channelsError] =
    useLiveTable<Channel>(
      tables.visible_channels,
      'visible_channels'
    );
  const [
    visible_channel_memberships,
    visible_channel_membershipsReady,
    visible_channel_membershipsError,
  ] = useLiveTable<ChannelMember>(
    tables.visible_channel_memberships,
    'visible_channel_memberships'
  );
  const [
    pendingChannelJoinRequests,
    pendingChannelJoinRequestsReady,
    pendingChannelJoinRequestsError,
  ] = useProcedureSnapshot<ChannelJoinRequest>(
    readPendingChannelJoinRequests,
    accountSignal?.channelJoinRequestsVersion.toString() ?? null
  );
  const rawSnapshot = useMemo(
    () =>
      resolveWorkspaceSnapshot({
        inboxes,
        actors,
        contactRequests,
        threadInvites,
        session,
        selectedSlug: params?.selectedSlug ?? null,
      }),
    [actors, contactRequests, inboxes, params?.selectedSlug, session, threadInvites]
  );
  const ownedAgentRegistrationRefreshTargets = rawSnapshot.ownedInboxAgents;
  const ownedAgentRegistrationRefreshKey = useMemo(
    () =>
      ownedAgentRegistrationRefreshTargets
        .map(entry => buildMasumiRegistrationSyncKey(entry.actor) ?? '')
        .join('\n'),
    [ownedAgentRegistrationRefreshTargets]
  );
  const ownedAgentRegistrationRefreshTargetIds = useMemo(
    () =>
      new Set(
        ownedAgentRegistrationRefreshTargets.map(entry => entry.actor.id.toString())
      ),
    [ownedAgentRegistrationRefreshTargets]
  );
  const refreshedActors = useMemo(
    () =>
      actors.map(actor => {
        const actorId = actor.id.toString();
        const sourceSyncKey = buildMasumiRegistrationSyncKey(actor);
        const refreshed = refreshedRegistrationByActorId[actorId];
        return refreshed && refreshed.sourceSyncKey === sourceSyncKey
          ? refreshed.actor
          : actor;
      }),
    [actors, refreshedRegistrationByActorId]
  );
  const snapshot = useMemo(
    () =>
      resolveWorkspaceSnapshot({
        inboxes,
        actors: refreshedActors,
        contactRequests,
        threadInvites,
        session,
        selectedSlug: params?.selectedSlug ?? null,
      }),
    [contactRequests, inboxes, params?.selectedSlug, refreshedActors, session, threadInvites]
  );
  const channelNavEntries = useMemo(
    () =>
      buildChannelNavEntries({
        channels: visible_channels,
        memberships: visible_channel_memberships,
        joinRequests: pendingChannelJoinRequests,
        ownedActorIds: new Set(
          snapshot.selectedActor ? [snapshot.selectedActor.id] : []
        ),
      }),
    [
      snapshot.selectedActor,
      pendingChannelJoinRequests,
      visible_channel_memberships,
      visible_channels,
    ]
  );
  const channelTablesReady =
    visible_channelsReady &&
    visible_channel_membershipsReady &&
    pendingChannelJoinRequestsReady;
  const rawChannelTablesError =
    visible_channelsError ||
    visible_channel_membershipsError ||
    pendingChannelJoinRequestsError;
  const rawTablesError =
    inboxesError || actorsError || contactRequestsError || threadInvitesError;
  const expiredOidcError = [rawTablesError, rawChannelTablesError].find(error =>
    isOidcTokenExpiredError(error)
  );

  useEffect(() => {
    if (!session || !expiredOidcError) {
      if (!expiredOidcError) {
        recoveredExpiredTokenRef.current = null;
      }
      return;
    }
    if (recoveredExpiredTokenRef.current === session.idToken) {
      return;
    }

    recoveredExpiredTokenRef.current = session.idToken;
    void refreshAuthSession();
  }, [expiredOidcError, refreshAuthSession, session]);

  const channelTablesError = isOidcTokenExpiredError(rawChannelTablesError)
    ? null
    : rawChannelTablesError;
  const tablesError = isOidcTokenExpiredError(rawTablesError)
    ? null
    : rawTablesError;

  useEffect(() => {
    if (
      !session ||
      !actorsReady ||
      !inboxesReady ||
      ownedAgentRegistrationRefreshTargets.length === 0
    ) {
      return deferEffectStateUpdate(() => {
        setOwnedAgentRegistrationRefreshBusy(false);
        setCompletedOwnedAgentRegistrationRefreshKey(current =>
          current === ownedAgentRegistrationRefreshKey
            ? current
            : ownedAgentRegistrationRefreshKey
        );
      });
    }

    if (
      completedOwnedAgentRegistrationRefreshKey ===
      ownedAgentRegistrationRefreshKey
    ) {
      return deferEffectStateUpdate(() => {
        setOwnedAgentRegistrationRefreshBusy(false);
      });
    }

    let cancelled = false;
    const cancelPendingState = deferEffectStateUpdate(() => {
      if (!cancelled) {
        setOwnedAgentRegistrationRefreshBusy(true);
        setCompletedOwnedAgentRegistrationRefreshKey(null);
      }
    });

    void (async () => {
      const nextRefreshed: Record<string, RefreshedWorkspaceAgentRegistration> = {};
      const nextErrors: Record<string, string> = {};

      for (const entry of ownedAgentRegistrationRefreshTargets) {
        const actor = entry.actor;
        const actorId = actor.id.toString();
        const sourceSyncKey = buildMasumiRegistrationSyncKey(actor);

        try {
          const result = await syncBrowserInboxAgentRegistration({
            session,
            actor,
            persistRegistration: async payload => {
              await Promise.resolve(
                upsertMasumiRegistrationReducer(payload)
              );
            },
          });
          nextRefreshed[actorId] = {
            sourceSyncKey,
            actor: result.actor,
            registration: result.registration,
          };
          if (result.registration.error) {
            nextErrors[actorId] = result.registration.error;
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Failed to refresh agent registration';
          nextErrors[actorId] = message;
          console.warn(
            `Workspace shell: failed to refresh registration for actor ${actor.slug ?? actorId}`,
            error
          );
        }
      }

      if (cancelled) {
        return;
      }

      setRefreshedRegistrationByActorId(current => ({
        ...current,
        ...nextRefreshed,
      }));
      setOwnedAgentRegistrationRefreshErrors(current => {
        const next = { ...current };
        for (const entry of ownedAgentRegistrationRefreshTargets) {
          const actorId = entry.actor.id.toString();
          if (nextErrors[actorId]) {
            next[actorId] = nextErrors[actorId];
          } else {
            delete next[actorId];
          }
        }
        return next;
      });
      setCompletedOwnedAgentRegistrationRefreshKey(
        ownedAgentRegistrationRefreshKey
      );
      setOwnedAgentRegistrationRefreshBusy(false);
    })();

    return () => {
      cancelled = true;
      cancelPendingState();
    };
  }, [
    actorsReady,
    completedOwnedAgentRegistrationRefreshKey,
    inboxesReady,
    ownedAgentRegistrationRefreshKey,
    ownedAgentRegistrationRefreshTargets,
    session,
    upsertMasumiRegistrationReducer,
  ]);

  if (auth.status === 'loading') {
    return { status: 'loading', auth, conn, session: null };
  }

  if (auth.status === 'error') {
    return { status: 'error', auth, conn, session: null };
  }

  if (!session) {
    return { status: 'signed_out', auth, conn, session: null };
  }

  if (!session.user.email || !session.user.emailVerified) {
    return { status: 'verified_email_required', auth, conn, session };
  }

  return {
    status: 'ready',
    auth,
    session,
    conn,
    connected: conn.isActive,
    connectionError: recoveringConnectionSession ? null : rawConnectionError,
    inboxes,
    actors,
    contactRequests,
    threadInvites,
    inboxesReady,
    actorsReady,
    contactRequestsReady,
    threadInvitesReady,
    channelTablesReady,
    tablesReady: inboxesReady && actorsReady && contactRequestsReady && threadInvitesReady,
    tablesError,
    channelTablesError,
    email: snapshot.email,
    ownedInbox: snapshot.ownedInbox,
    existingDefaultActor: snapshot.existingDefaultActor,
    ownedInboxAgents: snapshot.ownedInboxAgents,
    channelNavEntries,
    ownedInboxAgentRegistrationRefresh: {
      busy: ownedAgentRegistrationRefreshBusy,
      targetIds: ownedAgentRegistrationRefreshTargetIds,
      refreshKey: ownedAgentRegistrationRefreshKey,
      completedKey: completedOwnedAgentRegistrationRefreshKey,
      resultsByActorId: refreshedRegistrationByActorId,
      errorsByActorId: ownedAgentRegistrationRefreshErrors,
    },
    selectedActor: snapshot.selectedActor,
    shellInboxSlug: snapshot.shellInboxSlug,
    approvalView: snapshot.approvalView,
  };
}
