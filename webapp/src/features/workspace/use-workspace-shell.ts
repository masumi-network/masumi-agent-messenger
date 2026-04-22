import { useEffect, useMemo, useState } from 'react';
import { useReducer, useSpacetimeDB } from 'spacetimedb/tanstack';
import { useAuthSession, type AuthenticatedBrowserSession } from '@/lib/auth-session';
import {
  resolveWorkspaceSnapshot,
  type OwnedInboxAgentEntry,
} from '@/lib/app-shell';
import { deferEffectStateUpdate } from '@/lib/effect-state';
import { syncBrowserInboxAgentRegistration } from '@/lib/inbox-agent-registration';
import { useLiveTable } from '@/lib/spacetime-live-table';
import { reducers, tables } from '@/module_bindings';
import type { MasumiRegistrationResult } from '../../../../shared/inbox-agent-registration';
import type {
  Agent,
  Inbox as InboxRow,
  VisibleContactRequestRow,
  VisibleThreadInviteRow,
} from '@/module_bindings/types';
import { buildMasumiRegistrationSyncKey } from './actor-settings';

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
  inboxes: InboxRow[];
  actors: Agent[];
  contactRequests: VisibleContactRequestRow[];
  threadInvites: VisibleThreadInviteRow[];
  inboxesReady: boolean;
  actorsReady: boolean;
  contactRequestsReady: boolean;
  threadInvitesReady: boolean;
  tablesReady: boolean;
  tablesError: string | null;
  normalizedEmail: string;
  ownedInbox: InboxRow | null;
  existingDefaultActor: Agent | null;
  ownedInboxAgents: OwnedInboxAgentEntry<Agent>[];
  ownedInboxAgentRegistrationRefresh: OwnedInboxAgentRegistrationRefresh;
  selectedActor: Agent | null;
  shellInboxSlug: string | null;
  approvalView: {
    incoming: VisibleContactRequestRow[];
    outgoing: VisibleContactRequestRow[];
    incomingThreadInvites: VisibleThreadInviteRow[];
    outgoingThreadInvites: VisibleThreadInviteRow[];
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
  const conn = useSpacetimeDB();
  const session = auth.status === 'authenticated' ? auth.session : null;
  const upsertMasumiInboxAgentRegistrationReducer = useReducer(
    reducers.upsertMasumiInboxAgentRegistration
  );
  const [refreshedRegistrationByActorId, setRefreshedRegistrationByActorId] =
    useState<Record<string, RefreshedWorkspaceAgentRegistration>>({});
  const [completedOwnedAgentRegistrationRefreshKey, setCompletedOwnedAgentRegistrationRefreshKey] =
    useState<string | null>(null);
  const [ownedAgentRegistrationRefreshBusy, setOwnedAgentRegistrationRefreshBusy] =
    useState(false);
  const [ownedAgentRegistrationRefreshErrors, setOwnedAgentRegistrationRefreshErrors] =
    useState<Record<string, string>>({});

  const [inboxes, inboxesReady, inboxesError] = useLiveTable<InboxRow>(
    tables.visibleInboxes,
    'visibleInboxes'
  );
  const [actors, actorsReady, actorsError] = useLiveTable<Agent>(
    tables.visibleAgents,
    'visibleAgents'
  );
  const [contactRequests, contactRequestsReady, contactRequestsError] =
    useLiveTable<VisibleContactRequestRow>(
      tables.visibleContactRequests,
      'visibleContactRequests'
    );
  const [threadInvites, threadInvitesReady, threadInvitesError] =
    useLiveTable<VisibleThreadInviteRow>(
      tables.visibleThreadInvites,
      'visibleThreadInvites'
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
                upsertMasumiInboxAgentRegistrationReducer(payload)
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
    upsertMasumiInboxAgentRegistrationReducer,
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
    connectionError: conn.connectionError?.message ?? null,
    inboxes,
    actors,
    contactRequests,
    threadInvites,
    inboxesReady,
    actorsReady,
    contactRequestsReady,
    threadInvitesReady,
    tablesReady: inboxesReady && actorsReady && contactRequestsReady && threadInvitesReady,
    tablesError: inboxesError || actorsError || contactRequestsError || threadInvitesError,
    normalizedEmail: snapshot.normalizedEmail,
    ownedInbox: snapshot.ownedInbox,
    existingDefaultActor: snapshot.existingDefaultActor,
    ownedInboxAgents: snapshot.ownedInboxAgents,
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
