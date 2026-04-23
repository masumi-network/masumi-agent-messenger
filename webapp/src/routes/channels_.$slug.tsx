import { Link, createFileRoute } from '@tanstack/react-router';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CaretDown,
  ChatText,
  DotsThreeVertical,
  Hash,
  Lock,
  SignIn,
  UserMinus,
  Users,
  X,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import { useReducer, useSpacetimeDB } from 'spacetimedb/tanstack';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { AgentAvatar } from '@/components/inbox/agent-avatar';
import { DayDivider } from '@/components/inbox/day-divider';
import { EmptyState } from '@/components/inbox/empty-state';
import { MessageComposer } from '@/components/inbox/message-composer';
import { MessageItem } from '@/components/inbox/message-item';
import { loadStoredAgentKeyPair } from '@/lib/agent-session';
import { buildLoginHref, useAuthSession } from '@/lib/auth-session';
import { deferEffectStateUpdate } from '@/lib/effect-state';
import { formatDayLabel } from '@/lib/format-relative-time';
import { computeDayBoundaries, computeGroupedFlags } from '@/lib/group-messages';
import { buildRouteHead } from '@/lib/seo';
import { useLiveTable, usePublicLiveTable } from '@/lib/spacetime-live-table';
import { formatTimestamp } from '@/lib/thread-format';
import { cn } from '@/lib/utils';
import {
  matchesPublishedActorKeys,
  toActorIdentity,
} from '@/features/workspace/actor-settings';
import { useWorkspaceShell } from '@/features/workspace/use-workspace-shell';
import { WorkspaceRouteShell } from '@/features/workspace/workspace-route-shell';
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
import { isDeregisteringOrDeregisteredInboxAgentState } from '../../../shared/inbox-agent-registration';
import {
  formatEncryptedMessageBody,
  normalizeEncryptedMessagePayload,
  type EncryptedMessageHeader,
} from '../../../shared/message-format';

const MAX_CHANNEL_MESSAGE_CHARS = 10_000;
const SCROLL_LOAD_THRESHOLD_PX = 80;

export const Route = createFileRoute('/channels_/$slug')({
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
      contentType: string;
      headers: EncryptedMessageHeader[] | null;
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
  publicJoinPermission: string;
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

function describePermission(permission: string): string {
  if (permission === 'admin') return 'Admin';
  if (permission === 'read_write') return 'Write';
  if (permission === 'read') return 'Read only';
  return permission;
}

function describePublicJoinPermission(permission: string): string {
  if (permission === 'read_write') return 'Join grants write access';
  return 'Join grants read-only access';
}

function describeAccessMode(accessMode: string): string {
  if (accessMode === 'public') return 'Public';
  if (accessMode === 'approval_required') return 'Approval required';
  return accessMode;
}

function toPublicChannelDetails(channel: PublicChannel): ChannelPageDetails {
  return {
    channelId: channel.channelId,
    slug: channel.slug,
    title: channel.title,
    description: channel.description,
    accessMode: channel.accessMode,
    publicJoinPermission: channel.publicJoinPermission ?? 'read',
    discoverable: channel.discoverable,
    lastMessageSeq: channel.lastMessageSeq,
  };
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
  const usableOwnedActors = ownedActors.filter(
    actor => !isDeregisteringOrDeregisteredInboxAgentState(actor.masumiRegistrationState)
  );
  const ownedActorsById = new Map(usableOwnedActors.map(actor => [actor.id, actor]));

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

  return (
    (defaultActor &&
      !isDeregisteringOrDeregisteredInboxAgentState(defaultActor.masumiRegistrationState)
      ? defaultActor
      : null) ??
    usableOwnedActors[0] ??
    null
  );
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

function senderDisplayName(identity: string): string {
  const trimmed = identity.trim();
  if (!trimmed) return 'Unknown';
  const atIndex = trimmed.indexOf('@');
  if (atIndex > 0) {
    return trimmed.slice(0, atIndex);
  }
  return trimmed;
}

function ChannelPage() {
  const { slug } = Route.useParams();
  const auth = useAuthSession();

  if (auth.status === 'authenticated') {
    return <AuthenticatedChannelPage slug={slug} />;
  }

  return <PublicChannelPageContent slug={slug} />;
}

function AuthenticatedChannelPage({ slug }: { slug: string }) {
  const workspace = useWorkspaceShell();

  return (
    <WorkspaceRouteShell
      workspace={workspace}
      section="channels"
      title={`#${slug}`}
      selectedChannelSlug={slug}
      signInReturnTo={`/channels/${slug}`}
      signedOutDescription="Sign in to join channels, post messages, and review access requests."
    >
      <AuthenticatedChannelPageContent embedded />
    </WorkspaceRouteShell>
  );
}

function PublicChannelPageContent({ slug }: { slug: string }) {
  const [channels, channelsReady, channelsError] = usePublicLiveTable<PublicChannel>(
    tables.publicChannel,
    'publicChannel'
  );
  const publicChannel = useMemo(
    () => channels.find(row => row.slug === slug) ?? null,
    [channels, slug]
  );
  const channel = useMemo<ChannelPageDetails | null>(
    () => (publicChannel ? toPublicChannelDetails(publicChannel) : null),
    [publicChannel]
  );
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
  const [decryptedByKey, setDecryptedByKey] = useState<Record<string, DecryptedChannelMessage>>({});

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

  useEffect(() => {
    return deferEffectStateUpdate(() => {
      setDecryptedByKey({});
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
        sortedMessages.map(async message => {
          try {
            const verified = await verifySignedChannelMessage({
              input: toSignatureInput(message),
              signature: message.signature,
              senderSigningPublicKey: message.senderSigningPublicKey,
            });
            const normalized = normalizeEncryptedMessagePayload(verified.payload);
            return [
              channelMessageKey(message),
              {
                status: 'ok',
                text: formatEncryptedMessageBody(normalized),
                contentType: normalized.contentType,
                headers: normalized.headers ?? null,
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
            sortedMessages.map(item => [
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
  }, [channel, sortedMessages]);

  const timelineMeta = useMemo(
    () =>
      sortedMessages.map(message => ({
        senderId: message.senderPublicIdentity,
        createdAtMs: Number(message.createdAt.microsSinceUnixEpoch / 1000n),
      })),
    [sortedMessages]
  );
  const groupedFlags = useMemo(() => computeGroupedFlags(timelineMeta), [timelineMeta]);
  const dayBoundaries = useMemo(() => computeDayBoundaries(timelineMeta), [timelineMeta]);
  const accessModeLabel = channel ? describeAccessMode(channel.accessMode) : '';
  const error = channelsError ?? messagesError;

  return (
    <main className="mx-auto flex h-screen w-full max-w-5xl flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:px-8">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/channels">
            <ArrowLeft size={16} />
            Channels
          </Link>
        </Button>
        <Button asChild size="sm">
          <a href={buildLoginHref(`/channels/${slug}`)}>
            <SignIn size={14} aria-hidden />
            Sign in
          </a>
        </Button>
      </div>

      {!channelsReady ? (
        <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
          <Skeleton className="h-24 w-full rounded-lg" />
          <div className="mt-4 space-y-3">
            <Skeleton className="h-16 w-3/4 rounded-lg" />
            <Skeleton className="h-16 w-2/3 rounded-lg" />
          </div>
        </div>
      ) : !channel ? (
        <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
          {error ? (
            <Alert variant="destructive" className="mb-4">
              <AlertTitle>Channel subscription failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <Alert>
            <AlertTitle>Channel not found</AlertTitle>
            <AlertDescription className="space-y-3">
              <span className="block">No public channel exists at /{slug}.</span>
              <Button asChild variant="outline">
                <a href={buildLoginHref(`/channels/${slug}`)}>Sign in</a>
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      ) : (
        <>
          <header className="flex flex-col gap-2 border-b bg-background/95 px-4 py-4 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:px-8">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="flex min-w-0 items-center gap-2 text-xl font-semibold tracking-tight md:text-2xl">
                    <Hash size={20} className="shrink-0 text-muted-foreground" />
                    <span className="truncate">{channel.title ?? channel.slug}</span>
                  </h1>
                  <Badge variant="secondary" className="gap-1">
                    {channel.accessMode === 'approval_required' ? <Lock size={11} /> : null}
                    {accessModeLabel}
                  </Badge>
                  {channel.accessMode === 'public' ? (
                    <Badge variant="outline">
                      {describePublicJoinPermission(channel.publicJoinPermission)}
                    </Badge>
                  ) : null}
                </div>
                <p className="mt-1 font-mono text-xs text-muted-foreground">/{channel.slug}</p>
                {channel.description ? (
                  <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{channel.description}</p>
                ) : null}
              </div>
              <Button asChild size="sm" variant="outline">
                <a href={buildLoginHref(`/channels/${channel.slug}`)}>Sign in</a>
              </Button>
            </div>
          </header>

          {error ? (
            <div className="px-4 pt-3 md:px-8">
              <Alert variant="destructive">
                <AlertTitle>Channel subscription failed</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            </div>
          ) : null}

          <div className="flex-1 overflow-y-auto px-4 py-4 md:px-8">
            {!messagesReady ? (
              <div className="space-y-3">
                <Skeleton className="h-16 w-3/4 rounded-lg" />
                <Skeleton className="h-16 w-2/3 rounded-lg" />
                <Skeleton className="h-16 w-1/2 rounded-lg" />
              </div>
            ) : sortedMessages.length === 0 ? (
              <EmptyState
                icon={ChatText}
                title="No messages yet"
                description="Public channel messages will appear here after a member posts."
              />
            ) : (
              <>
                {sortedMessages.length >= 2 ? (
                  <div className="mb-4 flex items-center gap-3 text-[11px] uppercase tracking-wider text-muted-foreground/70">
                    <div className="h-px flex-1 bg-border" />
                    <span>Beginning of channel</span>
                    <div className="h-px flex-1 bg-border" />
                  </div>
                ) : null}
                {sortedMessages.map((message, index) => {
                  const key = channelMessageKey(message);
                  const decrypted = decryptedByKey[key];
                  const createdAtMs = timelineMeta[index]?.createdAtMs ?? 0;
                  const showDayDivider = dayBoundaries[index];
                  const dayLabel = showDayDivider ? formatDayLabel(createdAtMs) : null;
                  const senderName = senderDisplayName(message.senderPublicIdentity);
                  const messageState = !decrypted
                    ? undefined
                    : decrypted.status === 'ok'
                      ? {
                          status: 'ok' as const,
                          bodyText: decrypted.text,
                          error: null,
                          contentType: decrypted.contentType,
                          headerNames: decrypted.headers?.map(h => h.name) ?? [],
                          headers: decrypted.headers,
                          unsupportedReasons: [],
                          revealedUnsupported: false,
                        }
                      : {
                          status: 'failed' as const,
                          bodyText: null,
                          error: decrypted.error,
                          contentType: null,
                          headerNames: [],
                          headers: null,
                          unsupportedReasons: [],
                          revealedUnsupported: false,
                        };
                  return (
                    <div key={key}>
                      {dayLabel ? <DayDivider label={dayLabel} /> : null}
                      <MessageItem
                        senderName={senderName}
                        senderIdentity={message.senderPublicIdentity}
                        timestamp={formatTimestamp(message.createdAt)}
                        messageState={messageState}
                        isOwnMessage={false}
                        groupedWithPrevious={groupedFlags[index]}
                      />
                    </div>
                  );
                })}
              </>
            )}
          </div>

          <div className="border-t bg-background px-4 py-3 md:px-8">
            <ChannelFooterCta
              channel={channel}
              authenticated={false}
              hasActor={false}
              membership={null}
              ownJoinRequest={null}
              joining={false}
              requesting={false}
              onJoin={() => undefined}
              onRequest={() => undefined}
            />
          </div>
        </>
      )}
    </main>
  );
}

function AuthenticatedChannelPageContent({ embedded = false }: { embedded?: boolean }) {
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
        publicJoinPermission: visibleChannel.publicJoinPermission,
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
        publicJoinPermission: publicChannel.publicJoinPermission ?? 'read',
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
  const [membersOpen, setMembersOpen] = useState(false);
  const [requestsOpen, setRequestsOpen] = useState(false);

  const feedScrollRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef<boolean>(true);
  const lastMessageKeyRef = useRef<string | null>(null);
  const [feedUnseenCount, setFeedUnseenCount] = useState(0);

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
      shouldAutoScrollRef.current = true;
      lastMessageKeyRef.current = null;
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
            const normalized = normalizeEncryptedMessagePayload(verified.payload);
            return [
              channelMessageKey(message),
              {
                status: 'ok',
                text: formatEncryptedMessageBody(normalized),
                contentType: normalized.contentType,
                headers: normalized.headers ?? null,
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

  const latestMessageKey = combinedMessages[combinedMessages.length - 1]
    ? channelMessageKey(combinedMessages[combinedMessages.length - 1]!)
    : null;

  useEffect(() => {
    const el = feedScrollRef.current;
    if (!el || !latestMessageKey) {
      return;
    }
    if (latestMessageKey === lastMessageKeyRef.current) {
      return;
    }
    const isFirstPaint = lastMessageKeyRef.current === null;
    lastMessageKeyRef.current = latestMessageKey;
    if (isFirstPaint || shouldAutoScrollRef.current) {
      el.scrollTop = el.scrollHeight;
      setFeedUnseenCount(0);
    } else {
      setFeedUnseenCount(count => count + 1);
    }
  }, [latestMessageKey]);

  const handleFeedScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    const nearBottom =
      target.scrollHeight - target.clientHeight - target.scrollTop <= SCROLL_LOAD_THRESHOLD_PX;
    shouldAutoScrollRef.current = nearBottom;
    if (nearBottom) {
      setFeedUnseenCount(0);
    }
  }, []);

  const scrollFeedToBottom = useCallback(() => {
    const el = feedScrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setFeedUnseenCount(0);
    shouldAutoScrollRef.current = true;
  }, []);

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
      setActionFeedback(
        `Joined channel with ${
          channel?.publicJoinPermission === 'read_write' ? 'read/write' : 'read-only'
        } access.`
      );
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
    const scrollEl = feedScrollRef.current;
    const prevScrollHeight = scrollEl?.scrollHeight ?? 0;
    const prevScrollTop = scrollEl?.scrollTop ?? 0;
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
      requestAnimationFrame(() => {
        const el = feedScrollRef.current;
        if (!el) return;
        el.scrollTop = prevScrollTop + (el.scrollHeight - prevScrollHeight);
      });
      if (rows.length === 0) {
        setActionFeedback('No older messages.');
      }
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

  async function handleSend(event: React.FormEvent) {
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
    shouldAutoScrollRef.current = true;
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
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to send message');
    } finally {
      setSending(false);
    }
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      if (draft.trim()) {
        void handleSend(event as unknown as React.FormEvent);
      }
    }
  }

  useEffect(() => {
    if (!actionFeedback) return;
    const timeout = window.setTimeout(() => setActionFeedback(null), 3500);
    return () => window.clearTimeout(timeout);
  }, [actionFeedback]);

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

  const timelineMeta = useMemo(
    () =>
      combinedMessages.map(message => ({
        senderId: message.senderPublicIdentity,
        createdAtMs: Number(message.createdAt.microsSinceUnixEpoch / 1000n),
      })),
    [combinedMessages]
  );
  const groupedFlags = useMemo(() => computeGroupedFlags(timelineMeta), [timelineMeta]);
  const dayBoundaries = useMemo(() => computeDayBoundaries(timelineMeta), [timelineMeta]);

  const accessModeLabel = channel ? describeAccessMode(channel.accessMode) : '';

  const composerPlaceholder = channel
    ? `Message #${channel.slug}`
    : 'Message';
  const Container = embedded ? 'div' : 'main';

  return (
    <Container
      className={cn(
        'mx-auto flex w-full max-w-5xl flex-col overflow-hidden',
        embedded ? 'h-[calc(100vh-8rem)] min-h-[520px]' : 'h-screen'
      )}
    >
      {embedded ? null : (
        <div className="flex items-center justify-between gap-2 border-b bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:px-8">
          <Button asChild variant="ghost" size="sm" className="-ml-2">
            <Link to="/channels">
              <ArrowLeft size={16} />
              Channels
            </Link>
          </Button>
          {!authenticatedSession ? (
            <Button asChild size="sm">
              <a href={buildLoginHref(`/channels/${slug}`)}>
                <SignIn size={14} aria-hidden />
                Sign in
              </a>
            </Button>
          ) : null}
        </div>
      )}

      {!pageReady ? (
        <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
          <Skeleton className="h-24 w-full rounded-lg" />
          <div className="mt-4 space-y-3">
            <Skeleton className="h-16 w-3/4 rounded-lg" />
            <Skeleton className="h-16 w-2/3 rounded-lg" />
          </div>
        </div>
      ) : !channel ? (
        <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
          {error ? (
            <Alert variant="destructive" className="mb-4">
              <AlertTitle>Channel subscription failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
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
        </div>
      ) : (
        <>
          <header className="flex flex-col gap-2 border-b bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:px-8">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="flex min-w-0 items-center gap-2 text-lg font-semibold tracking-tight md:text-xl">
                    <Hash size={18} className="shrink-0 text-muted-foreground" />
                    <span className="truncate">{channel.title ?? channel.slug}</span>
                    <span className="shrink-0 font-mono text-xs font-normal text-muted-foreground">
                      /{channel.slug}
                    </span>
                  </h1>
                  <Badge variant="secondary" className="gap-1">
                    {channel.accessMode === 'approval_required' ? (
                      <Lock size={11} />
                    ) : null}
                    {membership
                      ? describePermission(membership.permission)
                      : ownJoinRequest?.status === 'pending'
                        ? `${accessModeLabel} · Requested`
                        : accessModeLabel}
                  </Badge>
                  {channel.accessMode === 'public' && !membership ? (
                    <Badge variant="outline">
                      {describePublicJoinPermission(channel.publicJoinPermission)}
                    </Badge>
                  ) : null}
                </div>
                {channel.description ? (
                  <p className="mt-1 max-w-3xl text-xs text-muted-foreground">{channel.description}</p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {authenticatedSession ? (
                  <>
                    {activeActor && !membership && channel.accessMode === 'public' ? (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void handleJoin()}
                        disabled={joining}
                      >
                        {joining ? 'Joining…' : 'Join'}
                      </Button>
                    ) : null}
                    {activeActor && !membership && channel.accessMode === 'approval_required' ? (
                      <Button
                        type="button"
                        size="sm"
                        variant={ownJoinRequest?.status === 'pending' ? 'outline' : 'default'}
                        onClick={() => void handleRequestJoin()}
                        disabled={requesting || ownJoinRequest?.status === 'pending'}
                      >
                        {requesting
                          ? 'Requesting…'
                          : ownJoinRequest?.status === 'pending'
                            ? 'Requested'
                            : 'Request access'}
                      </Button>
                    ) : null}
                    {canListMembers ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button type="button" size="sm" variant="outline">
                            <DotsThreeVertical size={16} />
                            <span className="sr-only md:not-sr-only md:ml-1">Manage</span>
                            <CaretDown size={12} className="ml-1 hidden md:inline-block" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-52">
                          <DropdownMenuLabel>Channel</DropdownMenuLabel>
                          <DropdownMenuItem
                            onSelect={event => {
                              event.preventDefault();
                              setMembersOpen(true);
                              if (memberRowsForChannel.length === 0) {
                                void handleLoadMembers(true);
                              }
                            }}
                          >
                            <Users size={14} />
                            View members
                          </DropdownMenuItem>
                          {canManage ? (
                            <DropdownMenuItem
                              onSelect={event => {
                                event.preventDefault();
                                setRequestsOpen(true);
                              }}
                            >
                              <UserMinus size={14} />
                              Review requests
                              {pendingAdminRequests.length > 0 ? (
                                <Badge variant="default" className="ml-auto h-5 px-1.5">
                                  {pendingAdminRequests.length}
                                </Badge>
                              ) : null}
                            </DropdownMenuItem>
                          ) : null}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem asChild>
                            <Link to="/channels">
                              <ArrowLeft size={14} />
                              All channels
                            </Link>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </>
                ) : (
                  <Button asChild size="sm" variant="outline">
                    <a href={buildLoginHref(`/channels/${channel.slug}`)}>Sign in</a>
                  </Button>
                )}
              </div>
            </div>
          </header>

          {error || actionError ? (
            <div className="px-4 pt-3 md:px-8">
              <Alert variant="destructive">
                <AlertTitle>
                  {error ? 'Channel subscription failed' : 'Channel action failed'}
                </AlertTitle>
                <AlertDescription className="flex items-start justify-between gap-3">
                  <span className="min-w-0 flex-1">{error ?? actionError}</span>
                  {actionError && !error ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => setActionError(null)}
                      aria-label="Dismiss error"
                    >
                      <X size={12} />
                    </Button>
                  ) : null}
                </AlertDescription>
              </Alert>
            </div>
          ) : null}

          {actionFeedback ? (
            <div className="pointer-events-none fixed bottom-6 left-1/2 z-40 -translate-x-1/2 px-4">
              <div className="pointer-events-auto rounded-md border bg-background px-3 py-1.5 text-xs text-foreground shadow-lg">
                {actionFeedback}
              </div>
            </div>
          ) : null}

          <div className="relative flex-1 overflow-hidden">
          <div
            ref={feedScrollRef}
            onScrollCapture={handleFeedScroll}
            className="absolute inset-0 overflow-y-auto px-4 py-4 md:px-8"
          >
            {!channelMessagesReady ? (
              <div className="space-y-3">
                <Skeleton className="h-16 w-3/4 rounded-lg" />
                <Skeleton className="h-16 w-2/3 rounded-lg" />
                <Skeleton className="h-16 w-1/2 rounded-lg" />
              </div>
            ) : combinedMessages.length === 0 ? (
              <EmptyState
                icon={ChatText}
                title={
                  channel.accessMode === 'public'
                    ? 'No messages yet'
                    : membership
                      ? 'No messages yet'
                      : 'Join approval required'
                }
                description={
                  channel.accessMode === 'public'
                    ? 'Be the first to post something to this channel.'
                    : membership
                      ? 'Say hello to kick things off.'
                      : 'Request access to read channel history.'
                }
              />
            ) : (
              <>
                {canLoadOlder ? (
                  <div className="mb-3 flex justify-center">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => void handleLoadOlder()}
                      disabled={loadingOlder}
                      className="gap-1.5 text-muted-foreground hover:text-foreground"
                    >
                      <ArrowUp size={14} />
                      {loadingOlder ? 'Loading…' : 'Load older messages'}
                    </Button>
                  </div>
                ) : combinedMessages.length >= 2 ? (
                  <div className="mb-4 flex items-center gap-3 text-[11px] uppercase tracking-wider text-muted-foreground/70">
                    <div className="h-px flex-1 bg-border" />
                    <span>Beginning of channel</span>
                    <div className="h-px flex-1 bg-border" />
                  </div>
                ) : null}
                {combinedMessages.map((message, index) => {
                  const key = channelMessageKey(message);
                  const decrypted = decryptedByKey[key];
                  const createdAtMs = timelineMeta[index]?.createdAtMs ?? 0;
                  const showDayDivider = dayBoundaries[index];
                  const dayLabel = showDayDivider ? formatDayLabel(createdAtMs) : null;
                  const isOwn = Boolean(
                    activeActor && activeActor.publicIdentity === message.senderPublicIdentity
                  );
                  const senderName = senderDisplayName(message.senderPublicIdentity);
                  const messageState = !decrypted
                    ? undefined
                    : decrypted.status === 'ok'
                      ? {
                          status: 'ok' as const,
                          bodyText: decrypted.text,
                          error: null,
                          contentType: decrypted.contentType,
                          headerNames: decrypted.headers?.map(h => h.name) ?? [],
                          headers: decrypted.headers,
                          unsupportedReasons: [],
                          revealedUnsupported: false,
                        }
                      : {
                          status: 'failed' as const,
                          bodyText: null,
                          error: decrypted.error,
                          contentType: null,
                          headerNames: [],
                          headers: null,
                          unsupportedReasons: [],
                          revealedUnsupported: false,
                        };
                  return (
                    <div key={key}>
                      {dayLabel ? <DayDivider label={dayLabel} /> : null}
                      <MessageItem
                        senderName={senderName}
                        senderIdentity={message.senderPublicIdentity}
                        timestamp={formatTimestamp(message.createdAt)}
                        messageState={messageState}
                        isOwnMessage={isOwn}
                        groupedWithPrevious={groupedFlags[index]}
                      />
                    </div>
                  );
                })}
              </>
            )}
          </div>
            {feedUnseenCount > 0 ? (
              <button
                type="button"
                onClick={scrollFeedToBottom}
                className="absolute bottom-3 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-foreground px-3 py-1.5 text-xs font-medium text-background shadow-soft-md transition-transform hover:-translate-y-px"
              >
                <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                {feedUnseenCount} new message{feedUnseenCount === 1 ? '' : 's'}
              </button>
            ) : null}
          </div>

          <div className="border-t bg-background px-4 py-3 md:px-8">
            {authenticatedSession && activeActor && canSend ? (
              <MessageComposer
                value={draft}
                onChange={setDraft}
                onKeyDown={handleComposerKeyDown}
                onSubmit={handleSend}
                maxLength={MAX_CHANNEL_MESSAGE_CHARS}
                disabled={sending}
                placeholder={composerPlaceholder}
              />
            ) : (
              <ChannelFooterCta
                channel={channel}
                authenticated={Boolean(authenticatedSession)}
                hasActor={Boolean(activeActor)}
                membership={membership}
                ownJoinRequest={ownJoinRequest}
                joining={joining}
                requesting={requesting}
                onJoin={() => void handleJoin()}
                onRequest={() => void handleRequestJoin()}
              />
            )}
          </div>

          <MembersDialog
            open={membersOpen}
            onOpenChange={open => {
              setMembersOpen(open);
              if (open && memberRowsForChannel.length === 0 && canListMembers) {
                void handleLoadMembers(true);
              }
            }}
            members={memberRowsForChannel}
            canManage={canManage}
            loading={loadingMembers}
            onLoadMore={() => void handleLoadMembers(false)}
            onSetPermission={handleSetMemberPermission}
            onRemove={handleRemoveMember}
          />

          <RequestsDialog
            open={requestsOpen}
            onOpenChange={setRequestsOpen}
            requests={pendingAdminRequests}
            onResolve={handleResolveRequest}
          />
        </>
      )}
    </Container>
  );
}

function ChannelFooterCta({
  channel,
  authenticated,
  hasActor,
  membership,
  ownJoinRequest,
  joining,
  requesting,
  onJoin,
  onRequest,
}: {
  channel: ChannelPageDetails;
  authenticated: boolean;
  hasActor: boolean;
  membership: VisibleChannelMembershipRow | null;
  ownJoinRequest: VisibleChannelJoinRequestRow | null;
  joining: boolean;
  requesting: boolean;
  onJoin: () => void;
  onRequest: () => void;
}) {
  if (!authenticated) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-md border bg-muted/30 px-4 py-4 text-center">
        <p className="text-sm font-medium">Sign in to join this channel</p>
        <p className="text-xs text-muted-foreground">
          Anyone can read public channels without an account.
        </p>
        <Button asChild size="sm" className="mt-1">
          <a href={buildLoginHref(`/channels/${channel.slug}`)}>Sign in</a>
        </Button>
      </div>
    );
  }

  if (!hasActor) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-md border bg-muted/30 px-4 py-4 text-center">
        <p className="text-sm font-medium">No agent available</p>
        <p className="text-xs text-muted-foreground">
          Create or sync an agent before joining channels.
        </p>
        <Button asChild size="sm" variant="outline">
          <Link to="/agents">Agents</Link>
        </Button>
      </div>
    );
  }

  if (membership && !membership.active) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-md border bg-muted/30 px-4 py-4 text-center">
        <p className="text-sm font-medium">You were removed from this channel</p>
        <p className="text-xs text-muted-foreground">Contact an admin to rejoin.</p>
      </div>
    );
  }

  if (membership && membership.permission === 'read') {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-md border bg-muted/30 px-4 py-4 text-center">
        <p className="text-sm font-medium">Read-only access</p>
        <p className="text-xs text-muted-foreground">
          Ask an admin for write access to post here.
        </p>
      </div>
    );
  }

  if (channel.accessMode === 'public') {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-md border bg-muted/30 px-4 py-4 text-center">
        <p className="text-sm font-medium">Join this channel</p>
        <p className="text-xs text-muted-foreground">
          {describePublicJoinPermission(channel.publicJoinPermission)}.
        </p>
        <Button type="button" size="sm" onClick={onJoin} disabled={joining}>
          {joining ? 'Joining…' : 'Join channel'}
        </Button>
      </div>
    );
  }

  if (ownJoinRequest?.status === 'pending') {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-md border bg-muted/30 px-4 py-4 text-center">
        <p className="text-sm font-medium">Waiting for admin approval</p>
        <p className="text-xs text-muted-foreground">
          You'll be able to post once an admin approves your request.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-md border bg-muted/30 px-4 py-4 text-center">
      <p className="text-sm font-medium">Approval required to post</p>
      <Button type="button" size="sm" onClick={onRequest} disabled={requesting}>
        {requesting ? 'Requesting…' : 'Request access'}
      </Button>
    </div>
  );
}

function MembersDialog({
  open,
  onOpenChange,
  members,
  canManage,
  loading,
  onLoadMore,
  onSetPermission,
  onRemove,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  members: ChannelMemberListRow[];
  canManage: boolean;
  loading: boolean;
  onLoadMore: () => void;
  onSetPermission: (memberAgentDbId: bigint, permission: string) => void;
  onRemove: (memberAgentDbId: bigint) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users size={18} />
            Members
          </DialogTitle>
          <DialogDescription>
            {members.length === 0 && loading
              ? 'Loading channel members…'
              : `${members.length} member${members.length === 1 ? '' : 's'} loaded.`}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto">
          {members.length === 0 && !loading ? (
            <p className="py-4 text-center text-sm text-muted-foreground">No members yet.</p>
          ) : (
            <ul className="divide-y">
              {members.map(member => (
                <li
                  key={member.id.toString()}
                  className={cn(
                    'flex items-center gap-3 py-3',
                    !member.active && 'opacity-60'
                  )}
                >
                  <AgentAvatar
                    name={member.agentSlug}
                    identity={member.agentPublicIdentity}
                    size="md"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium">{member.agentSlug}</p>
                      {!member.active ? (
                        <Badge variant="secondary" className="text-[10px]">
                          removed
                        </Badge>
                      ) : null}
                    </div>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {member.agentPublicIdentity}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {canManage && member.active ? (
                      <>
                        <Select
                          value={member.permission}
                          onValueChange={value => onSetPermission(member.agentDbId, value)}
                        >
                          <SelectTrigger className="h-8 w-[110px] text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="read">Read only</SelectItem>
                            <SelectItem value="read_write">Write</SelectItem>
                            <SelectItem value="admin">Admin</SelectItem>
                          </SelectContent>
                        </Select>
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          aria-label={`Remove ${member.agentSlug}`}
                          onClick={() => onRemove(member.agentDbId)}
                        >
                          <UserMinus size={14} />
                        </Button>
                      </>
                    ) : (
                      <Badge variant="outline" className="text-[10px]">
                        {describePermission(member.permission)}
                      </Badge>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onLoadMore}
            disabled={loading || members.length === 0}
          >
            {loading ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RequestsDialog({
  open,
  onOpenChange,
  requests,
  onResolve,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requests: VisibleChannelJoinRequestRow[];
  onResolve: (
    requestId: bigint,
    action: 'approve' | 'reject',
    permission?: string
  ) => void | Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Join requests</DialogTitle>
          <DialogDescription>
            {requests.length === 0
              ? 'No pending requests.'
              : `${requests.length} pending request${requests.length === 1 ? '' : 's'}.`}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto">
          {requests.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              You're all caught up.
            </p>
          ) : (
            <ul className="space-y-2">
              {requests.map(request => (
                <RequestApprovalItem
                  key={request.id.toString()}
                  request={request}
                  onResolve={onResolve}
                />
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RequestApprovalItem({
  request,
  onResolve,
}: {
  request: VisibleChannelJoinRequestRow;
  onResolve: (
    requestId: bigint,
    action: 'approve' | 'reject',
    permission?: string
  ) => void | Promise<void>;
}) {
  const [permission, setPermission] = useState(
    request.permission === 'read_write' ? 'read_write' : 'read'
  );

  return (
    <li className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex items-center gap-3">
        <AgentAvatar
          name={request.requesterSlug}
          identity={request.requesterPublicIdentity}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{request.requesterSlug}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {request.requesterPublicIdentity}
          </p>
        </div>
        <Badge variant="outline" className="text-[10px]">
          requested {describePermission(request.permission)}
        </Badge>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Select
          value={permission}
          onValueChange={value =>
            setPermission(
              value === 'admin' || value === 'read_write' ? value : 'read'
            )
          }
        >
          <SelectTrigger className="h-9 sm:w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="read">Read only</SelectItem>
            <SelectItem value="read_write">Write</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            onClick={() => void onResolve(request.id, 'approve', permission)}
          >
            Approve
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void onResolve(request.id, 'reject')}
          >
            Reject
          </Button>
        </div>
      </div>
    </li>
  );
}
