import { useMemo } from 'react';
import {
  evaluateWorkspaceWriteAccess,
  type BrowserSessionLike,
  type OwnedInboxWithOwnerIdentityLike,
} from '@/lib/app-shell';

export function useWorkspaceWriteAccess<
  Inbox extends OwnedInboxWithOwnerIdentityLike,
>(params: {
  connected: boolean;
  session: BrowserSessionLike | null;
  normalizedSessionEmail: string | null;
  inbox: Inbox | null;
  connectionIdentity: { toHexString(): string } | null;
  hasActor?: boolean;
}) {
  return useMemo(
    () =>
      evaluateWorkspaceWriteAccess({
        connected: params.connected,
        session: params.session,
        normalizedSessionEmail: params.normalizedSessionEmail,
        inbox: params.inbox,
        connectionIdentity: params.connectionIdentity,
        hasActor: params.hasActor,
      }),
    [
      params.connected,
      params.connectionIdentity,
      params.hasActor,
      params.inbox,
      params.normalizedSessionEmail,
      params.session,
    ]
  );
}
