import { Link, createFileRoute } from '@tanstack/react-router';
import { ArrowLeft, Hash, ShieldCheck, WarningCircle } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import { useReducer, useSpacetimeDB } from 'spacetimedb/tanstack';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { loadStoredAgentKeyPair } from '@/lib/agent-session';
import { buildLoginHref, useAuthSession } from '@/lib/auth-session';
import { deferEffectStateUpdate } from '@/lib/effect-state';
import { buildRouteHead } from '@/lib/seo';
import { useLiveTable, usePublicLiveTable } from '@/lib/spacetime-live-table';
import {
  matchesPublishedActorKeys,
  toActorIdentity,
} from '@/features/workspace/actor-settings';
import { DbConnection, reducers, tables } from '@/module_bindings';
import type {
  Agent,
  ChannelMemberListRow,
  ChannelMessageRow,
  PublicChannel,
  SelectedPublicRecentChannelMessageRow,
  VisibleChannelJoinRequestRow,
  VisibleChannelMessageRow,
  VisibleChannelMembershipRow,
  VisibleChannelRow,
} from '@/module_bindings/types';
import {
  prepareChannelMessage,
  verifySignedChannelMessage,
  type ChannelMessageSignatureInput,
} from '../../../shared/channel-crypto';
import { normalizeEmail } from '../../../shared/inbox-slug';
import {
  formatEncryptedMessageBody,
  normalizeEncryptedMessagePayload,
} from '../../../shared/message-format';

export const Route = createFileRoute('/channels/$slug')({
  head: ({ params }) =>
    buildRouteHead({
      title: `#${params.slug}`,
      description: 'Read recent public channel messages.',
      path: `/channels/${params.slug}`,
    }),
  component: ChannelPage,
});

type DecryptedChannelMessage =
  | {
      status: 'ok';
      text: string;
    }
  | {
      status: 'failed';
      error: string;
    };

type ChannelPageDetails = {
  channelId: bigint;
  slug: string;
  title?: string;
  description?: string;
  accessMode: string;
  discoverable: boolean;
  lastMessageSeq: bigint;
};

type CombinedChannelMessage =
  | ChannelMessageRow
  | SelectedPublicRecentChannelMessageRow
  | VisibleChannelMessageRow;

function compareBigint(left: bigint, right: bigint): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function channelPermissionRank(permission: string): number {
  if (permission === 'admin') return 3;
  if (permission === 'read_write') return 2;
  if (permission === 'read') return 1;
  return 0;
}

function pickPreferredChannelActor(params: {
  actors: Agent[];
  normalizedSessionEmail: string;
  channelId: bigint;
  memberships: VisibleChannelMembershipRow[];
  joinRequests: VisibleChannelJoinRequestRow[];
}): Agent | null {
  const defaultActor =
    params.actors.find(
      actor => actor.isDefault && actor.normalizedEmail === params.normalizedSessionEmail
    ) ?? null;
  const ownedActors = defaultActor
    ? params.actors.filter(actor => actor.inboxId === defaultActor.inboxId)
    : params.actors.filter(actor => actor.normalizedEmail === params.normalizedSessionEmail);
  const ownedActorsById = new Map(ownedActors.map(actor => [actor.id, actor]));

  const memberActorId = params.memberships
    .filter(
      membership =>
        membership.channelId === params.channelId &&
        membership.active &&
        ownedActorsById.has(membership.agentDbId)
    )
    .sort((left, right) => {
      const permissionOrder =
        channelPermissionRank(right.permission) - channelPermissionRank(left.permission);
      if (permissionOrder !== 0) return permissionOrder;
      if (left.agentDbId === defaultActor?.id) return -1;
      if (right.agentDbId === defaultActor?.id) return 1;
      return compareBigint(left.agentDbId, right.agentDbId);
    })[0]?.agentDbId;

  if (memberActorId !== undefined) {
    return ownedActorsById.get(memberActorId) ?? null;
  }

  const pendingRequestActorId = params.joinRequests
    .filter(
      request =>
        request.channelId === params.channelId &&
        request.direction === 'outgoing' &&
        request.status === 'pending' &&
        ownedActorsById.has(request.requesterAgentDbId)
    )
    .sort((left, right) => {
      if (left.requesterAgentDbId === defaultActor?.id) return -1;
      if (right.requesterAgentDbId === defaultActor?.id) return 1;
      return compareBigint(left.id, right.id);
    })[0]?.requesterAgentDbId;

  if (pendingRequestActorId !== undefined) {
    return ownedActorsById.get(pendingRequestActorId) ?? null;
  }

  return defaultActor ?? ownedActors[0] ?? null;
}

function toSignatureInput(message: {
  channelId: bigint;
  senderPublicIdentity: string;
  senderSeq: bigint;
  senderSigningKeyVersion: string;
  plaintext: string;
  replyToMessageId?: bigint | null;
}): ChannelMessageSignatureInput {
  return {
    channelId: message.channelId,
    senderPublicIdentity: message.senderPublicIdentity,
    senderSeq: message.senderSeq,
    senderSigningKeyVersion: message.senderSigningKeyVersion,
    plaintext: message.plaintext,
    replyToMessageId: message.replyToMessageId ?? null,
  };
}

function channelMessageKey(message: { channelId: bigint; channelSeq: bigint }): string {
  return `${message.channelId.toString()}:${message.channelSeq.toString()}`;
}

function toDecryptDomainMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : '';
  const text = raw.toLowerCase();
  if (!raw) {
    return 'This message could not be read. Try reloading; if the issue persists, the sender may have rotated keys.';
  }
  if (text.includes('signature')) {
    return 'This message could not be verified as coming from the claimed sender.';
  }
  if (text.includes('private key') || text.includes('key pair') || text.includes('published agent keys')) {
    return 'Your local keys are missing or out of sync. Restore or rotate keys before reading this channel.';
  }
  if (text.includes('sign in') || text.includes('channel member')) {
    return 'Sign in as a channel member to read this message.';
  }
  return 'This message could not be read. Try reloading; if the issue persists, the sender may have rotated keys.';
}

function isRetryableChannelSendError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes('senderSigningKeyVersion must match') ||
      error.message.includes('senderSeq must be'))
  );
}

function ChannelPage() {
  const { slug } = Route.useParams();
  const auth = useAuthSession();
  const connectionState = useSpacetimeDB();
  const connection = connectionState.getConnection?.() as DbConnection | null;
  const approveChannelJoinReducer = useReducer(reducers.approveChannelJoin);
  const joinPublicChannelReducer = useReducer(reducers.joinPublicChannel);
  const rejectChannelJoinReducer = useReducer(reducers.rejectChannelJoin);
  const removeChannelMemberReducer = useReducer(reducers.removeChannelMember);
  const sendChannelMessageReducer = useReducer(reducers.sendChannelMessage);
  const requestChannelJoinReducer = useReducer(reducers.requestChannelJoin);
  const setChannelMemberPermissionReducer = useReducer(reducers.setChannelMemberPermission);
  const [channels, channelsReady, channelsError] = usePublicLiveTable<PublicChannel>(
    tables.publicChannel,
    'publicChannel'
  );
  const [visibleChannels, visibleChannelsReady, visibleChannelsError] = useLiveTable<VisibleChannelRow>(
    tables.visibleChannels,
    'visibleChannels'
  );
  const [actors, actorsReady, actorsError] = useLiveTable<Agent>(
    tables.visibleAgents,
    'visibleAgents'
  );
  const [memberships, membershipsReady, membershipsError] = useLiveTable<VisibleChannelMembershipRow>(
    tables.visibleChannelMemberships,
    'visibleChannelMemberships'
  );
  const [joinRequests, joinRequestsReady, joinRequestsError] = useLiveTable<VisibleChannelJoinRequestRow>(
    tables.visibleChannelJoinRequests,
    'visibleChannelJoinRequests'
  );
  const publicChannel = useMemo(
    () => channels.find(row => row.slug === slug) ?? null,
    [channels, slug]
  );
  const visibleChannel = useMemo(
    () => visibleChannels.find(row => row.slug === slug) ?? null,
    [slug, visibleChannels]
  );
  const channel = useMemo<ChannelPageDetails | null>(() => {
    if (visibleChannel) {
      return {
        channelId: visibleChannel.id,
        slug: visibleChannel.slug,
        title: visibleChannel.title,
        description: visibleChannel.description,
        accessMode: visibleChannel.accessMode,
        discoverable: visibleChannel.discoverable,
        lastMessageSeq: visibleChannel.lastMessageSeq,
      };
    }
    if (publicChannel) {
      return {
        channelId: publicChannel.channelId,
        slug: publicChannel.slug,
        title: publicChannel.title,
        description: publicChannel.description,
        accessMode: publicChannel.accessMode,
        discoverable: publicChannel.discoverable,
        lastMessageSeq: publicChannel.lastMessageSeq,
      };
    }
    return null;
  }, [publicChannel, visibleChannel]);
  const channelId = channel?.channelId ?? 0n;
  const messageQuery = useMemo(
    () => tables.selectedPublicRecentChannelMessages.where(row => row.channelId.eq(channelId)),
    [channelId]
  );
  const [messages, messagesReady, messagesError] =
    usePublicLiveTable<SelectedPublicRecentChannelMessageRow>(
      messageQuery,
      'selectedPublicRecentChannelMessages'
    );
  const liveMessageQuery = useMemo(
    () => tables.visibleChannelMessages.where(row => row.channelId.eq(channelId)),
    [channelId]
  );
  const [liveMessages, liveMessagesReady, liveMessagesError] =
    useLiveTable<VisibleChannelMessageRow>(
      liveMessageQuery,
      'visibleChannelMessages'
    );
  const [historyMessages, setHistoryMessages] = useState<ChannelMessageRow[]>([]);
  const [memberRows, setMemberRows] = useState<ChannelMemberListRow[]>([]);
  const [decryptedByKey, setDecryptedByKey] = useState<Record<string, DecryptedChannelMessage>>({});
  const [draft, setDraft] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [joining, setJoining] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const authenticatedSession = auth.status === 'authenticated' ? auth.session : null;
  const normalizedSessionEmail = useMemo(
    () => normalizeEmail(authenticatedSession?.user.email ?? ''),
    [authenticatedSession?.user.email]
  );
  const activeActor = useMemo(
    () =>
      pickPreferredChannelActor({
        actors,
        normalizedSessionEmail,
        channelId,
        memberships,
        joinRequests,
      }),
    [actors, channelId, joinRequests, memberships, normalizedSessionEmail]
  );
  const membership = useMemo(
    () =>
      activeActor
        ? memberships.find(
            row => row.channelId === channelId && row.agentDbId === activeActor.id && row.active
          ) ?? null
        : null,
    [activeActor, channelId, memberships]
  );
  const canSend = membership?.permission === 'read_write' || membership?.permission === 'admin';
  const canManage = membership?.permission === 'admin';
  const canListMembers = Boolean(membership);
  const ownJoinRequest = useMemo(
    () =>
      activeActor
        ? joinRequests.find(
            request =>
              request.channelId === channelId &&
              request.requesterAgentDbId === activeActor.id &&
              request.direction === 'outgoing'
          ) ?? null
        : null,
    [activeActor, channelId, joinRequests]
  );
  const pendingAdminRequests = useMemo(
    () =>
      canManage
        ? joinRequests.filter(
            request =>
              request.channelId === channelId &&
              request.direction === 'incoming' &&
              request.status === 'pending'
          )
        : [],
    [canManage, channelId, joinRequests]
  );
  const historyMessagesForChannel = useMemo(
    () => historyMessages.filter(message => message.channelId === channelId),
    [channelId, historyMessages]
  );
  const memberRowsForChannel = useMemo(
    () => memberRows.filter(member => member.channelId === channelId),
    [channelId, memberRows]
  );

  const sortedMessages = useMemo(
    () =>
      [...messages]
        .filter(message => message.channelId === channelId)
        .sort((left, right) => {
          if (left.channelSeq < right.channelSeq) return -1;
          if (left.channelSeq > right.channelSeq) return 1;
          return Number(left.id - right.id);
        }),
    [channelId, messages]
  );
  const sortedLiveMessages = useMemo(
    () =>
      [...liveMessages]
        .filter(message => message.channelId === channelId)
        .sort((left, right) => {
          if (left.channelSeq < right.channelSeq) return -1;
          if (left.channelSeq > right.channelSeq) return 1;
          return Number(left.id - right.id);
        }),
    [channelId, liveMessages]
  );
  const combinedMessages = useMemo(() => {
    const byKey = new Map<string, CombinedChannelMessage>();
    for (const message of historyMessagesForChannel) {
      byKey.set(channelMessageKey(message), message);
    }
    for (const message of sortedMessages) {
      byKey.set(channelMessageKey(message), message);
    }
    for (const message of sortedLiveMessages) {
      byKey.set(channelMessageKey(message), message);
    }
    return Array.from(byKey.values()).sort((left, right) => {
      if (left.channelSeq < right.channelSeq) return -1;
      if (left.channelSeq > right.channelSeq) return 1;
      return Number(left.id - right.id);
    });
  }, [historyMessagesForChannel, sortedLiveMessages, sortedMessages]);
  const earliestLoadedSeq = combinedMessages[0]?.channelSeq ?? null;
  const canLoadOlder = Boolean(
    authenticatedSession && activeActor && channel && earliestLoadedSeq !== null && earliestLoadedSeq > 1n
  );

  useEffect(() => {
    return deferEffectStateUpdate(() => {
      setHistoryMessages([]);
      setMemberRows([]);
      setDecryptedByKey({});
      setActionError(null);
      setActionFeedback(null);
    });
  }, [channelId]);

  useEffect(() => {
    let cancelled = false;
    if (!channel) {
      const cancelReset = deferEffectStateUpdate(() => {
        if (!cancelled) {
          setDecryptedByKey({});
        }
      });
      return () => {
        cancelled = true;
        cancelReset();
      };
    }

    void (async () => {
      const entries = await Promise.all(
        combinedMessages.map(async message => {
          try {
            const verified = await verifySignedChannelMessage({
              input: toSignatureInput(message),
              signature: message.signature,
              senderSigningPublicKey: message.senderSigningPublicKey,
            });
            return [
              channelMessageKey(message),
              {
                status: 'ok',
                text: formatEncryptedMessageBody(verified.payload),
              } satisfies DecryptedChannelMessage,
            ] as const;
          } catch (error) {
            return [
              channelMessageKey(message),
              {
                status: 'failed',
                error: toDecryptDomainMessage(error),
              } satisfies DecryptedChannelMessage,
            ] as const;
          }
        })
      );
      if (!cancelled) {
        setDecryptedByKey(Object.fromEntries(entries));
      }
    })().catch(error => {
      if (!cancelled) {
        const message = toDecryptDomainMessage(error);
        setDecryptedByKey(
          Object.fromEntries(
            combinedMessages.map(item => [
              channelMessageKey(item),
              { status: 'failed', error: message } satisfies DecryptedChannelMessage,
            ])
          )
        );
      }
    });

    return () => {
      cancelled = true;
    };
  }, [channel, combinedMessages]);

  async function handleJoin() {
    if (!activeActor) {
      return;
    }
    setJoining(true);
    setActionError(null);
    setActionFeedback(null);
    try {
      await Promise.resolve(
        joinPublicChannelReducer({
          agentDbId: activeActor.id,
          channelId: channel?.channelId,
          channelSlug: channel ? undefined : slug,
        })
      );
      setActionFeedback('Joined channel.');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to join channel');
    } finally {
      setJoining(false);
    }
  }

  async function handleRequestJoin() {
    if (!activeActor) {
      return;
    }
    setRequesting(true);
    setActionError(null);
    setActionFeedback(null);
    try {
      await Promise.resolve(
        requestChannelJoinReducer({
          agentDbId: activeActor.id,
          channelId: channel?.channelId,
          channelSlug: channel ? undefined : slug,
          permission: 'read',
        })
      );
      setActionFeedback('Requested channel access.');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to request channel access');
    } finally {
      setRequesting(false);
    }
  }

  async function handleResolveRequest(
    requestId: bigint,
    action: 'approve' | 'reject',
    permission?: string
  ) {
    if (!activeActor) {
      return;
    }
    setActionError(null);
    setActionFeedback(null);
    try {
      if (action === 'approve') {
        await Promise.resolve(
          approveChannelJoinReducer({
            agentDbId: activeActor.id,
            requestId,
            permission,
          })
        );
        setActionFeedback('Approved channel request.');
        return;
      }

      await Promise.resolve(
        rejectChannelJoinReducer({
          agentDbId: activeActor.id,
          requestId,
        })
      );
      setActionFeedback('Rejected channel request.');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to update channel request');
    }
  }

  async function handleLoadMembers(reset = false) {
    if (!connection || !channel || !activeActor || !canListMembers) {
      return;
    }
    setLoadingMembers(true);
    setActionError(null);
    setActionFeedback(null);
    try {
      const afterMemberId =
        reset || memberRowsForChannel.length === 0
          ? undefined
          : memberRowsForChannel[memberRowsForChannel.length - 1]?.id;
      const rows = await connection.procedures.listChannelMembers({
        agentDbId: activeActor.id,
        channelId: channel.channelId,
        channelSlug: undefined,
        afterMemberId,
        limit: 100n,
      });
      setMemberRows(current => (reset ? rows : [...current, ...rows]));
      setActionFeedback(`Loaded ${rows.length.toString()} member${rows.length === 1 ? '' : 's'}.`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to load channel members');
    } finally {
      setLoadingMembers(false);
    }
  }

  async function handleSetMemberPermission(memberAgentDbId: bigint, permission: string) {
    if (!channel || !activeActor || !canManage) {
      return;
    }
    setActionError(null);
    setActionFeedback(null);
    try {
      await Promise.resolve(
        setChannelMemberPermissionReducer({
          agentDbId: activeActor.id,
          channelId: channel.channelId,
          memberAgentDbId,
          permission,
        })
      );
      setMemberRows(rows =>
        rows.map(row =>
          row.channelId === channel.channelId && row.agentDbId === memberAgentDbId
            ? { ...row, permission }
            : row
        )
      );
      setActionFeedback('Updated member permission.');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to update permission');
    }
  }

  async function handleRemoveMember(memberAgentDbId: bigint) {
    if (!channel || !activeActor || !canManage) {
      return;
    }
    setActionError(null);
    setActionFeedback(null);
    try {
      await Promise.resolve(
        removeChannelMemberReducer({
          agentDbId: activeActor.id,
          channelId: channel.channelId,
          memberAgentDbId,
        })
      );
      setMemberRows(rows =>
        rows.map(row =>
          row.channelId === channel.channelId && row.agentDbId === memberAgentDbId
            ? { ...row, active: false, permission: 'read' }
            : row
        )
      );
      setActionFeedback('Removed channel member.');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to remove member');
    }
  }

  async function handleLoadOlder() {
    if (!connection || !channel || !activeActor || !earliestLoadedSeq) {
      return;
    }
    setLoadingOlder(true);
    setActionError(null);
    setActionFeedback(null);
    try {
      const rows = await connection.procedures.listChannelMessages({
        agentDbId: activeActor.id,
        channelId: channel.channelId,
        channelSlug: undefined,
        beforeChannelSeq: earliestLoadedSeq,
        limit: 100n,
      });
      setHistoryMessages(current => {
        const byKey = new Map<string, ChannelMessageRow>();
        for (const message of current) {
          byKey.set(channelMessageKey(message), message);
        }
        for (const message of rows) {
          byKey.set(channelMessageKey(message), message);
        }
        return Array.from(byKey.values());
      });
      setActionFeedback(`Loaded ${rows.length.toString()} older message${rows.length === 1 ? '' : 's'}.`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to load older messages');
    } finally {
      setLoadingOlder(false);
    }
  }

  async function runSendAttempt(body: string) {
    if (!connection) {
      throw new Error('Not connected to the realtime service.');
    }
    const freshActors = Array.from(connection.db.visibleAgents.iter()) as Agent[];
    const freshVisibleChannel =
      (Array.from(connection.db.visibleChannels.iter()) as VisibleChannelRow[]).find(
        row => row.slug === slug
      ) ?? null;
    const freshPublicChannel =
      (Array.from(connection.db.publicChannel.iter()) as PublicChannel[]).find(
        row => row.slug === slug
      ) ?? null;
    const freshChannelId = freshVisibleChannel?.id ?? freshPublicChannel?.channelId;
    if (!freshChannelId) {
      throw new Error('Channel is unavailable.');
    }
    const freshMemberships = Array.from(
      connection.db.visibleChannelMemberships.iter()
    ) as VisibleChannelMembershipRow[];
    const freshJoinRequests = Array.from(
      connection.db.visibleChannelJoinRequests.iter()
    ) as VisibleChannelJoinRequestRow[];
    const freshActor = pickPreferredChannelActor({
      actors: freshActors,
      normalizedSessionEmail,
      channelId: freshChannelId,
      memberships: freshMemberships,
      joinRequests: freshJoinRequests,
    });
    if (!freshActor) {
      throw new Error('No active agent is available for this session.');
    }
    const freshMembership =
      freshMemberships.find(
        row =>
          row.channelId === freshChannelId && row.agentDbId === freshActor.id && row.active
      ) ?? null;
    if (!freshMembership) {
      throw new Error('Join the channel before sending.');
    }
    const keyPair = await loadStoredAgentKeyPair(toActorIdentity(freshActor));
    if (!keyPair) {
      throw new Error('Local key pair is missing. Restore or rotate keys before sending.');
    }
    if (!matchesPublishedActorKeys(freshActor, keyPair)) {
      throw new Error('Local key pair does not match the published agent keys.');
    }
    const nextSeq = freshMembership.lastSentSeq + 1n;
    const prepared = await prepareChannelMessage({
      channelId: freshChannelId,
      senderPublicIdentity: freshActor.publicIdentity,
      senderSeq: nextSeq,
      keyPair,
      payload: normalizeEncryptedMessagePayload({
        contentType: 'text/plain',
        body,
      }),
    });
    await Promise.resolve(
      sendChannelMessageReducer({
        agentDbId: freshActor.id,
        channelId: freshChannelId,
        senderSeq: nextSeq,
        senderSigningKeyVersion: prepared.senderSigningKeyVersion,
        plaintext: prepared.plaintext,
        signature: prepared.signature,
        replyToMessageId: undefined,
      })
    );
  }

  async function handleSend(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!channel || !activeActor || !membership || !canSend) {
      return;
    }
    const body = draft.trim();
    if (!body) {
      return;
    }
    setSending(true);
    setActionError(null);
    setActionFeedback(null);
    try {
      try {
        await runSendAttempt(body);
      } catch (error) {
        if (!isRetryableChannelSendError(error)) {
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
        await runSendAttempt(body);
      }
      setDraft('');
      setActionFeedback('Message sent.');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to send message');
    } finally {
      setSending(false);
    }
  }

  const error =
    channelsError ??
    messagesError ??
    (auth.status === 'authenticated'
      ? visibleChannelsError ??
        actorsError ??
        membershipsError ??
        joinRequestsError ??
        liveMessagesError
      : null);
  const authenticatedTablesReady =
    auth.status !== 'authenticated' ||
    (visibleChannelsReady &&
      actorsReady &&
      membershipsReady &&
      joinRequestsReady &&
      liveMessagesReady);
  const pageReady = channelsReady && authenticatedTablesReady;
  const channelMessagesReady =
    messagesReady && (auth.status !== 'authenticated' || liveMessagesReady);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-5 p-4 md:p-8">
      <div>
        <Button asChild variant="ghost" size="sm">
          <Link to="/channels">
            <ArrowLeft size={16} />
            Channels
          </Link>
        </Button>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Channel subscription failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {!pageReady ? (
        <Skeleton className="h-36 rounded-lg" />
      ) : !channel ? (
        <Alert>
          <AlertTitle>Channel not found</AlertTitle>
          <AlertDescription className="space-y-3">
            <span className="block">No public or discoverable channel exists at /{slug}.</span>
            {authenticatedSession && activeActor ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleJoin()}
                  disabled={joining}
                >
                  {joining ? 'Joining...' : 'Join public channel'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleRequestJoin()}
                  disabled={requesting}
                >
                  {requesting ? 'Requesting...' : 'Request private channel'}
                </Button>
              </div>
            ) : (
              <Button asChild variant="outline">
                <a href={buildLoginHref(`/channels/${slug}`)}>Sign in</a>
              </Button>
            )}
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <header className="flex flex-col gap-3 rounded-lg border bg-card p-5 text-card-foreground">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">
                {channel.accessMode === 'public' ? 'Latest 100 public messages' : 'Approval required'}
              </Badge>
              <Badge variant={channel.discoverable ? 'default' : 'outline'}>
                {channel.discoverable ? 'Discoverable' : channel.accessMode}
              </Badge>
              {membership ? <Badge variant="outline">{membership.permission}</Badge> : null}
              {ownJoinRequest ? <Badge variant="outline">{ownJoinRequest.status}</Badge> : null}
            </div>
            <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div className="space-y-2">
                <h1 className="flex items-center gap-2 text-3xl font-semibold tracking-tight">
                  <Hash size={24} />
                  {channel.title ?? channel.slug}
                </h1>
                <p className="text-sm text-muted-foreground">/{channel.slug}</p>
                {channel.description ? (
                  <p className="max-w-3xl text-sm text-muted-foreground">{channel.description}</p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {authenticatedSession ? (
                  <>
                    {activeActor && !membership && channel.accessMode === 'public' ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void handleJoin()}
                        disabled={joining}
                      >
                        {joining ? 'Joining...' : 'Join'}
                      </Button>
                    ) : null}
                    {activeActor && !membership && channel.accessMode === 'approval_required' ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void handleRequestJoin()}
                        disabled={requesting || ownJoinRequest?.status === 'pending'}
                      >
                        {requesting ? 'Requesting...' : ownJoinRequest?.status === 'pending' ? 'Requested' : 'Request access'}
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void handleLoadOlder()}
                      disabled={!canLoadOlder || loadingOlder}
                    >
                      {loadingOlder ? 'Loading...' : 'Load older'}
                    </Button>
                    {canListMembers ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void handleLoadMembers(true)}
                        disabled={loadingMembers}
                      >
                        {loadingMembers ? 'Loading...' : 'Members'}
                      </Button>
                    ) : null}
                  </>
                ) : (
                  <Button asChild variant="outline">
                    <a href={buildLoginHref(`/channels/${channel.slug}`)}>Sign in</a>
                  </Button>
                )}
              </div>
            </div>
          </header>

          {actionError ? (
            <Alert variant="destructive">
              <AlertTitle>Channel action failed</AlertTitle>
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          ) : null}

          {actionFeedback ? (
            <Alert>
              <AlertTitle>{actionFeedback}</AlertTitle>
            </Alert>
          ) : null}

          {canManage && pendingAdminRequests.length > 0 ? (
            <section className="space-y-3 rounded-lg border bg-card p-4 text-card-foreground">
              <div>
                <h2 className="text-base font-semibold">Join requests</h2>
                <p className="text-sm text-muted-foreground">
                  {pendingAdminRequests.length.toString()} pending request
                  {pendingAdminRequests.length === 1 ? '' : 's'}
                </p>
              </div>
              <div className="space-y-2">
                {pendingAdminRequests.map(request => (
                  <div
                    key={request.id.toString()}
                    className="flex flex-col gap-3 rounded-md border p-3 md:flex-row md:items-center md:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{request.requesterSlug}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {request.requesterPublicIdentity}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void handleResolveRequest(request.id, 'approve', 'read')}
                      >
                        Read
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void handleResolveRequest(request.id, 'approve', 'read_write')
                        }
                      >
                        Write
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => void handleResolveRequest(request.id, 'reject')}
                      >
                        Reject
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {memberRowsForChannel.length > 0 ? (
            <section className="space-y-3 rounded-lg border bg-card p-4 text-card-foreground">
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 className="text-base font-semibold">Members</h2>
                  <p className="text-sm text-muted-foreground">
                    Showing {memberRowsForChannel.length.toString()} loaded member
                    {memberRowsForChannel.length === 1 ? '' : 's'}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void handleLoadMembers(false)}
                  disabled={loadingMembers}
                >
                  {loadingMembers ? 'Loading...' : 'More'}
                </Button>
              </div>
              <div className="space-y-2">
                {memberRowsForChannel.map(member => (
                  <div
                    key={member.id.toString()}
                    className="flex flex-col gap-3 rounded-md border p-3 md:flex-row md:items-center md:justify-between"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium">{member.agentSlug}</p>
                        <Badge variant={member.active ? 'outline' : 'secondary'}>
                          {member.active ? 'active' : 'removed'}
                        </Badge>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {member.agentPublicIdentity}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {canManage ? (
                        <select
                          value={member.permission}
                          onChange={event =>
                            void handleSetMemberPermission(
                              member.agentDbId,
                              event.currentTarget.value
                            )
                          }
                          className="h-9 rounded-md border bg-background px-2 text-sm"
                          disabled={!member.active}
                        >
                          <option value="read">read</option>
                          <option value="read_write">read_write</option>
                          <option value="admin">admin</option>
                        </select>
                      ) : (
                        <Badge variant="outline">{member.permission}</Badge>
                      )}
                      {canManage ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => void handleRemoveMember(member.agentDbId)}
                          disabled={!member.active}
                        >
                          Remove
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {authenticatedSession && activeActor && canSend ? (
            <form onSubmit={event => void handleSend(event)} className="space-y-3">
              <Textarea
                value={draft}
                onChange={event => setDraft(event.target.value)}
                placeholder={`Message #${channel.slug}`}
                className="min-h-24"
              />
              <div className="flex justify-end">
                <Button type="submit" disabled={sending || !draft.trim()}>
                  {sending ? 'Sending...' : 'Send'}
                </Button>
              </div>
            </form>
          ) : null}

          {!channelMessagesReady ? (
            <div className="space-y-3">
              <Skeleton className="h-24 rounded-lg" />
              <Skeleton className="h-24 rounded-lg" />
            </div>
          ) : combinedMessages.length === 0 ? (
            <Alert>
              <AlertTitle>No messages</AlertTitle>
              <AlertDescription>
                {channel.accessMode === 'public'
                  ? 'This public channel has not published messages yet.'
                  : membership
                    ? 'This channel has not published messages yet.'
                    : 'Join approval is required before messages are available.'}
              </AlertDescription>
            </Alert>
          ) : (
            <section className="space-y-3">
              {combinedMessages.map(message => {
                const messageKey = channelMessageKey(message);
                const decrypted = decryptedByKey[messageKey];
                return (
                  <Card key={messageKey}>
                    <CardHeader className="space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <CardTitle className="text-base">
                          {message.senderPublicIdentity}
                        </CardTitle>
                        <Badge variant="outline">#{message.channelSeq.toString()}</Badge>
                      </div>
                      <CardDescription className="flex items-center gap-2">
                        <ShieldCheck size={15} />
                        {message.senderSigningKeyVersion}
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      {!decrypted ? (
                        <Skeleton className="h-6 w-2/3 rounded-md" />
                      ) : decrypted.status === 'ok' ? (
                        <p className="whitespace-pre-wrap text-sm leading-6">{decrypted.text}</p>
                      ) : (
                        <Alert variant="destructive">
                          <WarningCircle size={16} />
                          <AlertTitle>Message could not be read</AlertTitle>
                          <AlertDescription>{decrypted.error}</AlertDescription>
                        </Alert>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </section>
          )}
        </>
      )}
    </main>
  );
}
