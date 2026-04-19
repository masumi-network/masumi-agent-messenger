import { useMemo } from 'react';
import { useSpacetimeDB } from 'spacetimedb/tanstack';
import { useAuthSession, type AuthenticatedBrowserSession } from '@/lib/auth-session';
import {
  resolveWorkspaceSnapshot,
  type OwnedInboxAgentEntry,
} from '@/lib/app-shell';
import { useLiveTable } from '@/lib/spacetime-live-table';
import { tables } from '@/module_bindings';
import type {
  Agent,
  Inbox as InboxRow,
  VisibleContactRequestRow,
  VisibleThreadInviteRow,
} from '@/module_bindings/types';

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
  const snapshot = useMemo(
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
    selectedActor: snapshot.selectedActor,
    shellInboxSlug: snapshot.shellInboxSlug,
    approvalView: snapshot.approvalView,
  };
}
