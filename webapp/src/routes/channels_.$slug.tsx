import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CaretDown,
  ChatText,
  DotsThreeVertical,
  GearSix,
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
import { Label } from '@/components/ui/label';
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
import { KeyVaultDialog } from '@/components/key-vault-form';
import { loadStoredAgentKeyPair } from '@/lib/agent-session';
import { buildLoginHref, useAuthSession } from '@/lib/auth-session';
import {
  getChannelMessageSigningPublicKey,
  resolveChannelMessageSigningKeys,
} from '@/lib/channel-signing-keys';
import { isChannelFeedReady } from '@/lib/channel-feed-state';
import { deferEffectStateUpdate } from '@/lib/effect-state';
import { formatDayLabel } from '@/lib/format-relative-time';
import { computeDayBoundaries, computeGroupedFlags } from '@/lib/group-messages';
import {
  usePublicChannelLookup,
  usePublicChannelMessagesLookup,
} from '@/lib/public-channel';
import { buildRouteHead } from '@/lib/seo';
import { useLiveTable } from '@/lib/spacetime-live-table';
import {
  readAllOwnedAgents,
  readPendingChannelJoinRequests,
} from '@/lib/spacetime-procedure-reads';
import { useProcedureSnapshot } from '@/lib/spacetime-procedure-snapshot';
import { formatTimestamp } from '@/lib/thread-format';
import { cn } from '@/lib/utils';
import {
  matchesPublishedActorKeys,
  toActorIdentity,
} from '@/features/workspace/actor-settings';
import { parseOptionalSlug } from '@/lib/app-shell';
import { useWorkspaceShell } from '@/features/workspace/use-workspace-shell';
import { WorkspaceRouteShell } from '@/features/workspace/workspace-route-shell';
import { useKeyVault } from '@/hooks/use-key-vault';
import {
  isKeyVaultLockedError,
  isOidcTokenExpiredError,
} from '@/lib/session-recovery';
import { DbConnection, reducers, tables } from '@/module_bindings';
import type {
  Agent,
  AccountChangeSignal,
  ChannelMessage as ChannelMessageRow,
  ChannelJoinRequest,
  ChannelMember,
  Channel,
} from '@/module_bindings/types';
import {
  prepareChannelMessage,
  verifySignedChannelMessage,
  type ChannelMessageSignatureInput,
} from '../../../shared/channel-crypto';
import { fromHex, toHex } from '../../../shared/crypto-utils';
import { randomSenderMessageId } from '../../../shared/agent-crypto';
import {
  formatEncryptedMessageBody,
  normalizeEncryptedMessagePayload,
  type EncryptedMessageHeader,
} from '../../../shared/message-format';

const MAX_CHANNEL_MESSAGE_CHARS = 10_000;
const SCROLL_LOAD_THRESHOLD_PX = 80;
const PUBLIC_CHANNEL_RECENT_PAGE_SIZE = 25n;
const CHANNEL_HISTORY_PAGE_SIZE = 10;
const CHANNEL_MEMBER_PAGE_SIZE = 10;

export const Route = createFileRoute('/channels_/$slug')({
  validateSearch: search => ({
    agent: parseOptionalSlug(search.agent),
  }),
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
  accessMode: ChannelAccessMode;
  discoverable: boolean;
  lastMessageId: bigint;
};

type ChannelAccessMode = 'public' | 'approval_required';

type CombinedChannelMessage = ChannelMessageRow;

function describePermission(permission: { tag: string }): string {
  if (permission.tag === 'Admin') return 'Admin';
  if (permission.tag === 'ReadWrite') return 'Write';
  if (permission.tag === 'Read') return 'Read only';
  return permission.tag;
}

function describeAccessMode(accessMode: { tag: string } | string): string {
  const tag = typeof accessMode === 'string' ? accessMode : accessMode.tag;
  if (tag === 'Public' || tag === 'public') return 'Public';
  if (tag === 'ApprovalRequired' || tag === 'approval_required') return 'Approval required';
  return tag;
}

function normalizeAccessMode(accessMode: { tag: string } | string): ChannelAccessMode {
  const tag = typeof accessMode === 'string' ? accessMode : accessMode.tag;
  return tag === 'ApprovalRequired' || tag === 'approval_required' ? 'approval_required' : 'public';
}

function toPublicChannelDetails(channel: Channel): ChannelPageDetails {
  return {
    channelId: channel.id,
    slug: channel.slug,
    title: channel.title,
    description: channel.description,
    accessMode: normalizeAccessMode(channel.accessMode),
    discoverable: channel.discoverable,
    lastMessageId: channel.lastMessageId,
  };
}

function toSignatureInput(message: {
  channelId: bigint;
  senderPublicIdentity: string;
  senderMessageId: bigint;
  senderSigningKeyVersion: number;
  plaintext: string;
  replyToMessageId?: bigint | null;
}): ChannelMessageSignatureInput {
  return {
    channelId: message.channelId,
    senderPublicIdentity: message.senderPublicIdentity,
    senderMessageId: message.senderMessageId,
    senderSigningKeyVersion: message.senderSigningKeyVersion,
    plaintext: message.plaintext,
    replyToMessageId: message.replyToMessageId ?? null,
  };
}

function channelMessageKey(message: { id: bigint; channelId: bigint }): string {
  return `${message.channelId.toString()}:${message.id.toString()}`;
}

function mergeChannelMessageRows(
  current: ChannelMessageRow[],
  incoming: ChannelMessageRow[]
): ChannelMessageRow[] {
  const byKey = new Map<string, ChannelMessageRow>();
  for (const message of current) {
    byKey.set(channelMessageKey(message), message);
  }
  for (const message of incoming) {
    byKey.set(channelMessageKey(message), message);
  }
  return Array.from(byKey.values());
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
    return 'Your local keys are missing or out of sync. Restore or reset keys before reading this channel.';
  }
  if (text.includes('sign in') || text.includes('channel member')) {
    return 'Sign in as a channel member to read this message.';
  }
  return 'This message could not be read. Try reloading; if the issue persists, the sender may have rotated keys.';
}

function isRetryableChannelSendError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('senderSigningKeyVersion must match')
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
  const search = Route.useSearch();
  const auth = useAuthSession();

  if (auth.status === 'authenticated') {
    return <AuthenticatedChannelPage slug={slug} selectedSlug={search.agent ?? null} />;
  }

  return <PublicChannelPageContent slug={slug} />;
}

function AuthenticatedChannelPage({
  slug,
  selectedSlug,
}: {
  slug: string;
  selectedSlug: string | null;
}) {
  const workspace = useWorkspaceShell({ selectedSlug });

  return (
    <WorkspaceRouteShell
      workspace={workspace}
      section="channels"
      title={`#${slug}`}
      selectedChannelSlug={slug}
      signInReturnTo={`/channels/${slug}`}
      signedOutDescription="Sign in to join channels, post messages, and review access requests."
    >
      {readyWorkspace => (
        <AuthenticatedChannelPageContent
          embedded
          activeActor={readyWorkspace.selectedActor}
        />
      )}
    </WorkspaceRouteShell>
  );
}

function PublicChannelPageContent({ slug }: { slug: string }) {
  const [publicChannel, channelsReady, channelsError] = usePublicChannelLookup({
    channelSlug: slug,
  });
  const channel = useMemo<ChannelPageDetails | null>(
    () => (publicChannel ? toPublicChannelDetails(publicChannel) : null),
    [publicChannel]
  );
  const channelId = channel?.channelId ?? 0n;
  // The new schema dropped the public mirror table — anonymous viewers rely
  // on the paginated lookup procedure instead of a live subscription.
  const liveMessages = useMemo<ChannelMessageRow[]>(() => [], []);
  const liveMessagesReady = true;
  const [messages, messagesReady, messagesError, reloadMessages] = usePublicChannelMessagesLookup({
    channelSlug: slug,
    enabled: channel !== null,
    limit: PUBLIC_CHANNEL_RECENT_PAGE_SIZE,
  });
  const [decryptedByKey, setDecryptedByKey] = useState<Record<string, DecryptedChannelMessage>>({});
  const connectionState = useSpacetimeDB();
  const connection = connectionState.getConnection?.() as DbConnection | null;
  const liveMessagesRefreshKey = useMemo(
    () => liveMessages.map(message => `${message.id.toString()}:${message.id.toString()}`).join('|'),
    [liveMessages]
  );

  const sortedMessages = useMemo(
    () =>
      [...messages]
        .filter(message => message.channelId === channelId)
        .sort((left, right) => {
          if (left.id < right.id) return -1;
          if (left.id > right.id) return 1;
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
    if (channel?.accessMode === 'public' && liveMessagesReady) {
      reloadMessages();
    }
  }, [channel, liveMessagesReady, liveMessagesRefreshKey, reloadMessages]);

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
      const resolvedSigningKeys = await resolveChannelMessageSigningKeys(connection, sortedMessages);
      const entries = await Promise.all(
        sortedMessages.map(async message => {
          try {
            const senderSigningPublicKey = getChannelMessageSigningPublicKey(
              message,
              resolvedSigningKeys
            );
            if (!senderSigningPublicKey) {
              throw new Error('Unable to resolve sender signing key');
            }

            const verified = await verifySignedChannelMessage({
              input: toSignatureInput(message),
              signature: toHex(message.signature),
              senderSigningPublicKey,
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
  }, [channel, connection, sortedMessages]);

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
          <Link to="/channels" search={{ agent: undefined, tab: 'public' }}>
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
                      {'See channel access mode'}
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

function AuthenticatedChannelPageContent({
  embedded = false,
  activeActor,
}: {
  embedded?: boolean;
  activeActor: Agent | null;
}) {
  const { slug } = Route.useParams();
  const navigate = useNavigate();
  const auth = useAuthSession();
  const vault = useKeyVault();
  const connectionState = useSpacetimeDB();
  const connection = connectionState.getConnection?.() as DbConnection | null;
  const approveChannelJoinReducer = useReducer(reducers.approveChannelJoin);
  const joinPublicChannelReducer = useReducer(reducers.joinPublicChannel);
  const rejectChannelJoinReducer = useReducer(reducers.rejectChannelJoin);
  const removeChannelMemberReducer = useReducer(reducers.removeChannelMember);
  const sendChannelMessageReducer = useReducer(reducers.sendChannelMessage);
  const requestChannelJoinReducer = useReducer(reducers.requestChannelJoin);
  const updateChannelMemberPermissionReducer = useReducer(reducers.updateChannelMemberPermission);
  const updateChannelSettingsReducer = useReducer(reducers.updateChannelSettings);
  const [publicChannel, channelsReady, channelsError] = usePublicChannelLookup({
    channelSlug: slug,
  });
  const visibleChannelQuery = useMemo(
    () => tables.visible_channels.where(row => row.slug.eq(slug)),
    [slug]
  );
  const [visible_channels, visible_channelsReady, visible_channelsError] = useLiveTable<Channel>(
    visibleChannelQuery,
    'visible_channels'
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
  const visibleChannel = useMemo(
    () => visible_channels.find(row => row.slug === slug) ?? null,
    [slug, visible_channels]
  );
  const channel = useMemo<ChannelPageDetails | null>(() => {
    if (visibleChannel) {
      return {
        channelId: visibleChannel.id,
        slug: visibleChannel.slug,
        title: visibleChannel.title,
        description: visibleChannel.description,
        accessMode: normalizeAccessMode(visibleChannel.accessMode),
        discoverable: visibleChannel.discoverable,
        lastMessageId: visibleChannel.lastMessageId,
      };
    }
    if (publicChannel) {
      return {
        channelId: publicChannel.id,
        slug: publicChannel.slug,
        title: publicChannel.title,
        description: publicChannel.description,
        accessMode: normalizeAccessMode(publicChannel.accessMode),
        discoverable: publicChannel.discoverable,
        lastMessageId: publicChannel.lastMessageId,
      };
    }
    return null;
  }, [publicChannel, visibleChannel]);
  const channelId = channel?.channelId ?? 0n;
  const membershipQuery = useMemo(
    () => tables.visible_channel_memberships.where(row => row.channelId.eq(channelId)),
    [channelId]
  );
  const [memberships, membershipsReady, membershipsError] = useLiveTable<ChannelMember>(
    membershipQuery,
    'visible_channel_memberships',
    { enabled: channel !== null }
  );
  const [allJoinRequests, joinRequestsReady, joinRequestsError] =
    useProcedureSnapshot<ChannelJoinRequest>(
      readPendingChannelJoinRequests,
      accountSignal?.channelJoinRequestsVersion.toString() ?? null
    );
  const joinRequests = useMemo(
    () =>
      channel === null
        ? []
        : allJoinRequests.filter(row => row.channelId === channelId),
    [allJoinRequests, channel, channelId]
  );
  // Anonymous public mirror and live message-body subscriptions were dropped;
  // channel bodies are loaded through paginated procedures.
  const liveMessages = useMemo<ChannelMessageRow[]>(() => [], []);
  const liveMessagesReady = true;
  const [messages, messagesReady, messagesError, reloadMessages] = usePublicChannelMessagesLookup({
    channelSlug: slug,
    enabled: channel !== null && channel.accessMode === 'public',
    limit: PUBLIC_CHANNEL_RECENT_PAGE_SIZE,
  });
  const [historyMessages, setHistoryMessages] = useState<ChannelMessageRow[]>([]);
  const [historyReady, setHistoryReady] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [memberRows, setMemberRows] = useState<ChannelMember[]>([]);
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [vaultDialogOpen, setVaultDialogOpen] = useState(false);

  const feedScrollRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef<boolean>(true);
  const lastMessageKeyRef = useRef<string | null>(null);
  const liveMessagesRefreshKey = useMemo(
    () => liveMessages.map(message => `${message.id.toString()}:${message.id.toString()}`).join('|'),
    [liveMessages]
  );
  const [feedUnseenCount, setFeedUnseenCount] = useState(0);

  const authenticatedSession = auth.status === 'authenticated' ? auth.session : null;
  const membership = useMemo(
    () =>
      activeActor
        ? memberships.find(
            row => row.channelId === channelId && row.agentDbId === activeActor.id && row.active
          ) ?? null
        : null,
    [activeActor, channelId, memberships]
  );
  const alternativeChannelActors = useMemo(() => {
    if (!activeActor) {
      return [];
    }
    const activeMemberIds = new Set(
      memberships
        .filter(row => row.active && row.agentDbId !== activeActor.id)
        .map(row => row.agentDbId)
    );
    return actors
      .filter(actor => activeMemberIds.has(actor.id))
      .sort((left, right) => left.slug.localeCompare(right.slug));
  }, [activeActor, actors, memberships]);
  const canSend =
    membership?.permission.tag === 'ReadWrite' || membership?.permission.tag === 'Admin';
  const canManage = membership?.permission.tag === 'Admin';
  const canListMembers = Boolean(membership);
  const canReadChannelHistory = Boolean(
    authenticatedSession &&
      activeActor &&
      channel &&
      (channel.accessMode === 'public' || membership)
  );
  const ownJoinRequest = useMemo(
    () =>
      activeActor
        ? joinRequests.find(
            request =>
              request.channelId === channelId &&
              request.requesterAgentDbId === activeActor.id
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
              activeActor !== null &&
              request.requesterAgentDbId !== activeActor.id &&
              request.status.tag === 'Pending'
          )
        : [],
    [activeActor, canManage, channelId, joinRequests]
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
          if (left.id < right.id) return -1;
          if (left.id > right.id) return 1;
          return Number(left.id - right.id);
        }),
    [channelId, messages]
  );
  const combinedMessages = useMemo(() => {
    const byKey = new Map<string, CombinedChannelMessage>();
    for (const message of historyMessagesForChannel) {
      byKey.set(channelMessageKey(message), message);
    }
    for (const message of sortedMessages) {
      byKey.set(channelMessageKey(message), message);
    }
    return Array.from(byKey.values()).sort((left, right) => {
      if (left.id < right.id) return -1;
      if (left.id > right.id) return 1;
      return Number(left.id - right.id);
    });
  }, [historyMessagesForChannel, sortedMessages]);
  const earliestLoadedMessageId = combinedMessages[0]?.id ?? null;
  const canLoadOlder = Boolean(
    authenticatedSession &&
      activeActor &&
      channel &&
      earliestLoadedMessageId !== null &&
      earliestLoadedMessageId > 0n
  );

  useEffect(() => {
    return deferEffectStateUpdate(() => {
      setHistoryMessages([]);
      setHistoryReady(false);
      setHistoryError(null);
      setMemberRows([]);
      setDecryptedByKey({});
      setActionError(null);
      setActionFeedback(null);
      shouldAutoScrollRef.current = true;
      lastMessageKeyRef.current = null;
    });
  }, [channelId]);

  useEffect(() => {
    if (channel && liveMessagesReady) {
      reloadMessages();
    }
  }, [channel, liveMessagesReady, liveMessagesRefreshKey, reloadMessages]);

  useEffect(() => {
    let cancelled = false;
    if (!canReadChannelHistory || !connection || !channel || !activeActor) {
      const cancelReady = deferEffectStateUpdate(() => {
        if (!cancelled) {
          setHistoryReady(true);
          setHistoryError(null);
        }
      });
      return () => {
        cancelled = true;
        cancelReady();
      };
    }

    const cancelClearError = deferEffectStateUpdate(() => {
      if (!cancelled) {
        setHistoryError(null);
      }
    });
    void connection.procedures
      .listChannelMessages({
        channelId: channel.channelId,
        beforeMessageId: undefined,
        limit: CHANNEL_HISTORY_PAGE_SIZE,
      })
      .then(rows => {
        if (cancelled) {
          return;
        }
        setHistoryMessages(current => mergeChannelMessageRows(current, rows));
        setHistoryReady(true);
      })
      .catch(error => {
        if (cancelled) {
          return;
        }
        setHistoryError(error instanceof Error ? error.message : 'Unable to load channel messages');
        setHistoryReady(true);
      });

    return () => {
      cancelled = true;
      cancelClearError();
    };
  }, [
    activeActor,
    canReadChannelHistory,
    channel,
    connection,
  ]);

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
      const resolvedSigningKeys = await resolveChannelMessageSigningKeys(connection, combinedMessages);
      const entries = await Promise.all(
        combinedMessages.map(async message => {
          try {
            const senderSigningPublicKey = getChannelMessageSigningPublicKey(
              message,
              resolvedSigningKeys
            );
            if (!senderSigningPublicKey) {
              throw new Error('Unable to resolve sender signing key');
            }

            const verified = await verifySignedChannelMessage({
              input: toSignatureInput(message),
              signature: toHex(message.signature),
              senderSigningPublicKey,
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
  }, [channel, combinedMessages, connection]);

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

  function reportChannelActionError(error: unknown, fallback: string) {
    if (isOidcTokenExpiredError(error)) {
      setActionError(null);
      setActionFeedback('Sign-in session expired. Reconnecting…');
      void auth.refresh();
      return;
    }
    if (isKeyVaultLockedError(error)) {
      setActionError(null);
      setActionFeedback(null);
      setVaultDialogOpen(true);
      return;
    }
    setActionError(error instanceof Error ? error.message : fallback);
  }

  async function handleJoin() {
    if (!activeActor) {
      return;
    }
    setJoining(true);
    setActionError(null);
    setActionFeedback(null);
    try {
      if (!channel?.channelId) {
        throw new Error('Channel must be loaded before joining.');
      }
      await Promise.resolve(
        joinPublicChannelReducer({
          agentDbId: activeActor.id,
          channelId: channel.channelId,
        })
      );
      setActionFeedback('Joined channel.');
    } catch (error) {
      reportChannelActionError(error, 'Unable to join channel');
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
      if (!channel?.channelId) {
        throw new Error('Channel must be loaded before requesting access.');
      }
      await Promise.resolve(
        requestChannelJoinReducer({
          agentDbId: activeActor.id,
          channelId: channel.channelId,
          requestedPermission: { tag: 'Read' },
        })
      );
      setActionFeedback('Requested channel access.');
    } catch (error) {
      reportChannelActionError(error, 'Unable to request channel access');
    } finally {
      setRequesting(false);
    }
  }

  async function handleResolveRequest(
    requestId: bigint,
    action: 'approve' | 'reject'
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
      reportChannelActionError(error, 'Unable to update channel request');
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
        channelId: channel.channelId,
        afterId: afterMemberId,
        limit: CHANNEL_MEMBER_PAGE_SIZE,
      });
      setMemberRows(current => (reset ? rows : [...current, ...rows]));
    } catch (error) {
      reportChannelActionError(error, 'Unable to load channel members');
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
    const tagged: { tag: 'Read' } | { tag: 'ReadWrite' } | { tag: 'Admin' } =
      permission === 'admin'
        ? { tag: 'Admin' }
        : permission === 'read_write'
          ? { tag: 'ReadWrite' }
          : { tag: 'Read' };
    try {
      await Promise.resolve(
        updateChannelMemberPermissionReducer({
          agentDbId: activeActor.id,
          channelId: channel.channelId,
          targetAgentDbId: memberAgentDbId,
          permission: tagged,
        })
      );
      setMemberRows(rows =>
        rows.map(row =>
          row.channelId === channel.channelId && row.agentDbId === memberAgentDbId
            ? { ...row, permission: tagged }
            : row
        )
      );
      setActionFeedback('Updated member permission.');
    } catch (error) {
      reportChannelActionError(error, 'Unable to update permission');
    }
  }

  async function handleUpdateChannelSettings(settings: {
    accessMode: ChannelAccessMode;
    discoverable: boolean;
  }) {
    if (!channel || !activeActor || !canManage) {
      return;
    }
    setSavingSettings(true);
    setActionError(null);
    setActionFeedback(null);
    try {
      await Promise.resolve(
        updateChannelSettingsReducer({
          agentDbId: activeActor.id,
          channelId: channel.channelId,
          title: undefined,
          description: undefined,
          accessMode:
            settings.accessMode === 'public'
              ? { tag: 'Public' }
              : { tag: 'ApprovalRequired' },
          discoverable: settings.discoverable,
          defaultPermission: undefined,
        })
      );
      setSettingsOpen(false);
      setActionFeedback('Updated channel settings.');
    } catch (error) {
      reportChannelActionError(error, 'Unable to update channel settings');
    } finally {
      setSavingSettings(false);
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
          targetAgentDbId: memberAgentDbId,
        })
      );
      setMemberRows(rows =>
        rows.map(row =>
          row.channelId === channel.channelId && row.agentDbId === memberAgentDbId
            ? { ...row, active: false, permission: { tag: 'Read' } as const }
            : row
        )
      );
      setActionFeedback('Removed channel member.');
    } catch (error) {
      reportChannelActionError(error, 'Unable to remove member');
    }
  }

  async function handleLoadOlder() {
    if (!connection || !channel || !activeActor || !earliestLoadedMessageId) {
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
        channelId: channel.channelId,
        beforeMessageId: earliestLoadedMessageId,
        limit: CHANNEL_HISTORY_PAGE_SIZE,
      });
      setHistoryMessages(current => {
        return mergeChannelMessageRows(current, rows);
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
      reportChannelActionError(error, 'Unable to load older messages');
    } finally {
      setLoadingOlder(false);
    }
  }

  async function runSendAttempt(body: string) {
    if (!connection) {
      throw new Error('Not connected to the realtime service.');
    }
    const freshActors = await readAllOwnedAgents(connection);
    const freshVisibleChannel =
      (Array.from(connection.db.visible_channels.iter()) as Channel[]).find(
        row => row.slug === slug
      ) ?? null;
    const freshPublicChannel = publicChannel?.slug === slug ? publicChannel : null;
    const freshChannelId = freshVisibleChannel?.id ?? freshPublicChannel?.id;
    if (!freshChannelId) {
      throw new Error('Channel is unavailable.');
    }
    const freshMemberships = Array.from(
      connection.db.visible_channel_memberships.iter()
    ) as ChannelMember[];
    const freshActor =
      activeActor === null
        ? null
        : freshActors.find(actor => actor.id === activeActor.id) ?? null;
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
      throw new Error('Local key pair is missing. Restore or reset keys before sending.');
    }
    if (!matchesPublishedActorKeys(freshActor, keyPair)) {
      throw new Error('Local key pair does not match the published agent keys.');
    }
    const senderMessageId = randomSenderMessageId();
    const prepared = await prepareChannelMessage({
      channelId: freshChannelId,
      senderPublicIdentity: freshActor.publicIdentity,
      senderMessageId,
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
        senderMessageId,
        senderSigningKeyVersion: prepared.senderSigningKeyVersion,
        plaintext: prepared.plaintext,
        signature: fromHex(prepared.signature),
        replyToMessageId: undefined,
      })
    );
  }

  async function handleSend(event: React.FormEvent) {
    event.preventDefault();
    if (!channel || !activeActor || !membership || !canSend) {
      return;
    }
    if (!vault.loading && !vault.unlocked) {
      setActionError(null);
      setVaultDialogOpen(true);
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
      reportChannelActionError(error, 'Unable to send message');
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
      ? visible_channelsError ??
        actorsError ??
        membershipsError ??
        joinRequestsError ??
        historyError
      : null);
  const authenticatedTablesReady =
    auth.status !== 'authenticated' ||
    (visible_channelsReady &&
      actorsReady &&
      membershipsReady &&
      joinRequestsReady);
  const pageReady = channelsReady && authenticatedTablesReady;
  const channelMessagesReady = isChannelFeedReady({
    accessMode: channel?.accessMode ?? null,
    historyReady,
    publicMessagesReady: messagesReady,
    canReadAuthenticatedHistory: canReadChannelHistory,
  });

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
            <Link
              to="/channels"
              search={{ agent: activeActor?.slug, tab: 'mine' }}
            >
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
                      : ownJoinRequest?.status.tag === 'Pending'
                        ? `${accessModeLabel} · Requested`
                        : accessModeLabel}
                  </Badge>
                  {activeActor ? (
                    <Badge variant="outline" className="font-mono font-normal">
                      Agent /{activeActor.slug}
                    </Badge>
                  ) : null}
                  {channel.accessMode === 'public' && !membership ? (
                    <Badge variant="outline">
                      {'See channel access mode'}
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
                        variant={ownJoinRequest?.status.tag === 'Pending' ? 'outline' : 'default'}
                        onClick={() => void handleRequestJoin()}
                        disabled={requesting || ownJoinRequest?.status.tag === 'Pending'}
                      >
                        {requesting
                          ? 'Requesting…'
                          : ownJoinRequest?.status.tag === 'Pending'
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
                          {canManage ? (
                            <DropdownMenuItem
                              onSelect={event => {
                                event.preventDefault();
                                setSettingsOpen(true);
                              }}
                            >
                              <GearSix size={14} />
                              Settings
                            </DropdownMenuItem>
                          ) : null}
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
                            <Link
                              to="/channels"
                              search={{ agent: activeActor?.slug, tab: 'mine' }}
                            >
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
            ) : authenticatedSession &&
              activeActor &&
              !membership &&
              alternativeChannelActors.length > 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 rounded-md border bg-muted/30 px-4 py-4 text-center">
                <div className="space-y-1">
                  <p className="text-sm font-medium">Joined with another agent</p>
                  <p className="text-xs text-muted-foreground">
                    Switch agent context to open this channel with its existing membership.
                  </p>
                </div>
                <div className="flex flex-wrap justify-center gap-2">
                  {alternativeChannelActors.map(actor => (
                    <Button
                      key={actor.id.toString()}
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        void navigate({
                          to: '/channels/$slug',
                          params: { slug },
                          search: { agent: actor.slug },
                        });
                      }}
                    >
                      Switch to /{actor.slug}
                    </Button>
                  ))}
                </div>
              </div>
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

          {settingsOpen ? (
            <ChannelSettingsDialog
              open={settingsOpen}
              onOpenChange={setSettingsOpen}
              channel={channel}
              saving={savingSettings}
              onSave={handleUpdateChannelSettings}
            />
          ) : null}

          <KeyVaultDialog
            open={vaultDialogOpen && !vault.loading && !vault.unlocked}
            onOpenChange={setVaultDialogOpen}
            mode={vault.initialized ? 'unlock' : 'setup'}
            busy={vault.submitting}
            error={vault.error}
            title={vault.initialized ? 'Unlock Private Keys' : 'Create Private Key Vault'}
            description={
              activeActor
                ? `Unlock the local vault to sign channel messages as /${activeActor.slug}.`
                : 'Unlock the local vault to sign channel messages.'
            }
            submitLabel={vault.initialized ? 'Unlock keys' : 'Create vault'}
            onSubmit={async (passphrase, _confirmPassphrase) => {
              await vault.handleSubmit(passphrase);
              setVaultDialogOpen(false);
              setActionFeedback(
                activeActor
                  ? `Keys unlocked for /${activeActor.slug}. Send again when ready.`
                  : 'Keys unlocked. Send again when ready.'
              );
            }}
          />

          <MembersDialog
            open={membersOpen}
            onOpenChange={open => {
              setMembersOpen(open);
              if (open && memberRowsForChannel.length === 0 && canListMembers) {
                void handleLoadMembers(true);
              }
            }}
            members={memberRowsForChannel}
            actorById={new Map(actors.map(actor => [actor.id, actor]))}
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
            actorById={new Map(actors.map(actor => [actor.id, actor]))}
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
  membership: ChannelMember | null;
  ownJoinRequest: ChannelJoinRequest | null;
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
          <Link
            to="/agents"
            search={{ agent: undefined }}
          >
            Agents
          </Link>
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

  if (membership && membership.permission.tag === 'Read') {
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
          {'See channel access mode'}.
        </p>
        <Button type="button" size="sm" onClick={onJoin} disabled={joining}>
          {joining ? 'Joining…' : 'Join channel'}
        </Button>
      </div>
    );
  }

  if (ownJoinRequest?.status.tag === 'Pending') {
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

function ChannelSettingsDialog({
  open,
  onOpenChange,
  channel,
  saving,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channel: ChannelPageDetails;
  saving: boolean;
  onSave: (settings: {
    accessMode: ChannelAccessMode;
    discoverable: boolean;
  }) => void | Promise<void>;
}) {
  const [accessMode, setAccessMode] = useState<ChannelAccessMode>(channel.accessMode);
  const [discoverable, setDiscoverable] = useState(channel.discoverable);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GearSix size={18} />
            Channel settings
          </DialogTitle>
          <DialogDescription>/{channel.slug}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={event => {
            event.preventDefault();
            void onSave({ accessMode, discoverable });
          }}
        >
          <div className="space-y-2">
            <Label>Access</Label>
            <Select
              value={accessMode}
              onValueChange={value =>
                setAccessMode(value === 'approval_required' ? 'approval_required' : 'public')
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="public">Public</SelectItem>
                <SelectItem value="approval_required">Approval required</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <label className="flex h-10 items-center gap-2 rounded-md border px-3 text-sm">
            <input
              type="checkbox"
              checked={discoverable}
              onChange={event => setDiscoverable(event.currentTarget.checked)}
              className="h-4 w-4"
            />
            Discoverable
          </label>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MembersDialog({
  open,
  onOpenChange,
  members,
  actorById,
  canManage,
  loading,
  onLoadMore,
  onSetPermission,
  onRemove,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  members: ChannelMember[];
  actorById: Map<bigint, Agent>;
  canManage: boolean;
  loading: boolean;
  onLoadMore: () => void;
  onSetPermission: (memberAgentDbId: bigint, permission: string) => void;
  onRemove: (memberAgentDbId: bigint) => void;
}) {
  function memberSlug(member: ChannelMember): string {
    return actorById.get(member.agentDbId)?.slug ?? `agent#${member.agentDbId.toString()}`;
  }
  function memberPublicIdentity(member: ChannelMember): string {
    return (
      actorById.get(member.agentDbId)?.publicIdentity ?? `agent#${member.agentDbId.toString()}`
    );
  }
  function permissionToValue(permission: ChannelMember['permission']): string {
    if (permission.tag === 'Admin') return 'admin';
    if (permission.tag === 'ReadWrite') return 'read_write';
    return 'read';
  }
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
                    name={memberSlug(member)}
                    identity={memberPublicIdentity(member)}
                    size="md"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium">{memberSlug(member)}</p>
                      {!member.active ? (
                        <Badge variant="secondary" className="text-[10px]">
                          removed
                        </Badge>
                      ) : null}
                    </div>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {memberPublicIdentity(member)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {canManage && member.active ? (
                      <>
                        <Select
                          value={permissionToValue(member.permission)}
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
                          aria-label={`Remove ${memberSlug(member)}`}
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
  actorById,
  onResolve,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requests: ChannelJoinRequest[];
  actorById: Map<bigint, Agent>;
  onResolve: (
    requestId: bigint,
    action: 'approve' | 'reject'
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
                  actorById={actorById}
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
  actorById,
  onResolve,
}: {
  request: ChannelJoinRequest;
  actorById: Map<bigint, Agent>;
  onResolve: (
    requestId: bigint,
    action: 'approve' | 'reject'
  ) => void | Promise<void>;
}) {
  const requester = actorById.get(request.requesterAgentDbId);
  const requesterSlug =
    requester?.slug ?? `agent#${request.requesterAgentDbId.toString()}`;
  const requesterPublicIdentity =
    requester?.publicIdentity ?? `agent#${request.requesterAgentDbId.toString()}`;

  return (
    <li className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex items-center gap-3">
        <AgentAvatar
          name={requesterSlug}
          identity={requesterPublicIdentity}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{requesterSlug}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {requesterPublicIdentity}
          </p>
        </div>
        <Badge variant="outline" className="text-[10px]">
          requested {describePermission(request.permission)}
        </Badge>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            onClick={() => void onResolve(request.id, 'approve')}
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
