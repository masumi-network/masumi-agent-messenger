import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { Hash, Plus, Radio, SignIn, Users } from '@phosphor-icons/react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Timestamp } from 'spacetimedb';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { buildLoginHref, useAuthSession } from '@/lib/auth-session';
import {
  parseChannelsTab,
  parseOptionalSlug,
  type ChannelNavEntry,
  type ChannelsTab,
} from '@/lib/app-shell';
import { waitForVisibleChannelBySlug } from '@/lib/channel-creation';
import { deferEffectStateUpdate } from '@/lib/effect-state';
import { buildRouteHead } from '@/lib/seo';
import {
  useWorkspaceShell,
  type WorkspaceShellReadyState,
} from '@/features/workspace/use-workspace-shell';
import { WorkspaceRouteShell } from '@/features/workspace/workspace-route-shell';
import { reducers, type DbConnection } from '@/module_bindings';
import type { Agent, Channel } from '@/module_bindings/types';
import { normalizeInboxSlug } from '../../../shared/inbox-slug';
import { useOidcSessionRecovery } from '@/hooks/use-oidc-session-recovery';
import { isOidcTokenExpiredError } from '@/lib/session-recovery';

export const Route = createFileRoute('/channels')({
  validateSearch: search => ({
    agent: parseOptionalSlug(search.agent),
    tab: parseChannelsTab(search.tab),
  }),
  head: () =>
    buildRouteHead({
      title: 'Channels',
      description: 'Browse public feeds and channels joined by the selected agent.',
      path: '/channels',
    }),
  component: ChannelsPage,
});

function ChannelsPage() {
  const auth = useAuthSession();

  if (auth.status === 'authenticated') {
    return <AuthenticatedChannelsPage />;
  }

  return <PublicChannelsPageContent />;
}

function AuthenticatedChannelsPage() {
  const search = Route.useSearch();
  const workspace = useWorkspaceShell({
    selectedSlug: search.agent ?? null,
  });

  return (
    <WorkspaceRouteShell
      workspace={workspace}
      section="channels"
      title="Channels"
      signInReturnTo="/channels"
      signedOutDescription="Sign in to create channels and review channel approvals."
    >
      {readyWorkspace => (
        <AuthenticatedChannelsPageContent
          embedded
          workspace={readyWorkspace}
          activeTab={search.tab}
        />
      )}
    </WorkspaceRouteShell>
  );
}

const PUBLIC_CHANNEL_PAGE_SIZE = 10;

type PublicChannelCursor = {
  beforeLastMessageAtMicros?: bigint;
  beforeChannelId?: bigint;
};

function sortPublicChannels<T extends Channel>(channels: T[]): T[] {
  return [...channels].sort((left, right) => {
    if (left.lastMessageAt.microsSinceUnixEpoch > right.lastMessageAt.microsSinceUnixEpoch) {
      return -1;
    }
    if (left.lastMessageAt.microsSinceUnixEpoch < right.lastMessageAt.microsSinceUnixEpoch) {
      return 1;
    }
    if (left.id > right.id) return -1;
    if (left.id < right.id) return 1;
    return left.slug.localeCompare(right.slug);
  });
}

function readPublicChannelPageError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Unable to load public channels';
}

function usePublicChannelPage() {
  const auth = useAuthSession();
  const connectionState = useSpacetimeDB();
  const connection = connectionState.getConnection?.() as DbConnection | null;
  const isActive = connectionState.isActive && connection !== null;
  const isAuthenticated = auth.status === 'authenticated';
  const [cursorStack, setCursorStack] = useState<PublicChannelCursor[]>([{}]);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageRows, setPageRows] = useState<Channel[]>([]);
  const [loadingPage, setLoadingPage] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const cursor = cursorStack[pageIndex] ?? {};
  const cursorKey = `${cursor.beforeLastMessageAtMicros?.toString() ?? 'start'}:${
    cursor.beforeChannelId?.toString() ?? 'start'
  }`;

  useEffect(() => {
    return deferEffectStateUpdate(() => {
      setCursorStack([{}]);
      setPageIndex(0);
    });
  }, [connection]);

  useEffect(() => {
    if (!isAuthenticated) {
      return deferEffectStateUpdate(() => {
        setPageRows([]);
        setLoadingPage(false);
        setPageError('Sign in to browse the public channel index.');
      });
    }
    if (!isActive || !connection) {
      return deferEffectStateUpdate(() => {
        setPageRows([]);
        setLoadingPage(false);
        setPageError(null);
      });
    }

    let cancelled = false;
    const cancelStart = deferEffectStateUpdate(() => {
      if (cancelled) {
        return;
      }
      setLoadingPage(true);
      setPageError(null);

      const beforeLastMessageAt =
        cursor.beforeLastMessageAtMicros === undefined
          ? undefined
          : new Timestamp(cursor.beforeLastMessageAtMicros);

      void connection.procedures
        .listDiscoverableChannels({
          beforeLastMessageAt,
          beforeChannelId: cursor.beforeChannelId,
          limit: PUBLIC_CHANNEL_PAGE_SIZE,
        })
        .then(rows => {
          if (cancelled) {
            return;
          }
          setPageRows(rows);
          setLoadingPage(false);
        })
        .catch((error: unknown) => {
          if (cancelled) {
            return;
          }
          if (!isOidcTokenExpiredError(error)) {
            setPageRows([]);
          }
          setLoadingPage(false);
          setPageError(readPublicChannelPageError(error));
        });
    });

    return () => {
      cancelled = true;
      cancelStart();
    };
  }, [
    connection,
    cursor.beforeChannelId,
    cursor.beforeLastMessageAtMicros,
    cursorKey,
    isActive,
    isAuthenticated,
  ]);

  const channels = useMemo(() => {
    return sortPublicChannels(pageRows);
  }, [pageRows]);
  const recoveringSession = useOidcSessionRecovery(pageError);

  const goToNextPage = () => {
    const sortedPageRows = sortPublicChannels(pageRows);
    const lastChannel = sortedPageRows[sortedPageRows.length - 1];
    if (!lastChannel) {
      return;
    }

    const nextPageIndex = pageIndex + 1;
    setCursorStack(existingCursors => {
      const nextCursors = existingCursors.slice(0, nextPageIndex);
      nextCursors[nextPageIndex] = {
        beforeLastMessageAtMicros: lastChannel.lastMessageAt.microsSinceUnixEpoch,
        beforeChannelId: lastChannel.id,
      };
      return nextCursors;
    });
    setPageIndex(nextPageIndex);
  };

  const goToPreviousPage = () => {
    setPageIndex(current => Math.max(0, current - 1));
  };

  return {
    channels,
    ready:
      (!isAuthenticated || isActive) &&
      !loadingPage &&
      (!recoveringSession || pageRows.length > 0),
    error: recoveringSession ? null : pageError,
    pageIndex,
    canPrevious: pageIndex > 0,
    canNext: pageRows.length >= PUBLIC_CHANNEL_PAGE_SIZE,
    paginationBusy: loadingPage,
    goToPreviousPage,
    goToNextPage,
  };
}

function PublicChannelsPageContent() {
  const publicChannelPage = usePublicChannelPage();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 p-4 md:p-8">
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Radio size={16} weight="fill" />
            Anonymous public read
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">Public channels</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Open public channel links directly without OIDC. Sign in to browse the channel index,
            post messages, or administer channels.
          </p>
        </div>
        <Button asChild>
          <a href={buildLoginHref('/channels')}>
            <SignIn size={16} aria-hidden />
            Sign in
          </a>
        </Button>
      </header>

      {publicChannelPage.error ? (
        <Alert>
          <AlertTitle>Channel index unavailable</AlertTitle>
          <AlertDescription>{publicChannelPage.error}</AlertDescription>
        </Alert>
      ) : null}

      <Alert>
        <AlertTitle>Sign in to browse channels</AlertTitle>
        <AlertDescription className="space-y-3">
          <span className="block">
            Anonymous visitors can still read a public channel when they have its direct URL.
          </span>
          <Button asChild variant="outline">
            <a href={buildLoginHref('/channels')}>Sign in</a>
          </Button>
        </AlertDescription>
      </Alert>

      <PublicChannelList
        ready={publicChannelPage.ready}
        channels={publicChannelPage.channels}
        pageIndex={publicChannelPage.pageIndex}
        canPrevious={publicChannelPage.canPrevious}
        canNext={publicChannelPage.canNext}
        paginationBusy={publicChannelPage.paginationBusy}
        onPreviousPage={publicChannelPage.goToPreviousPage}
        onNextPage={publicChannelPage.goToNextPage}
      />
    </main>
  );
}

function AuthenticatedChannelsPageContent({
  embedded = false,
  workspace,
  activeTab,
}: {
  embedded?: boolean;
  workspace: WorkspaceShellReadyState;
  activeTab: ChannelsTab;
}) {
  const navigate = useNavigate();
  const publicChannelPage = usePublicChannelPage();
  const [createOpen, setCreateOpen] = useState(false);
  const activeActor = workspace.selectedActor;

  const Container = embedded ? 'div' : 'main';

  return (
    <Container
      className={
        embedded
          ? 'mx-auto flex w-full max-w-6xl flex-col gap-6'
          : 'mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 p-4 md:p-8'
      }
    >
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Radio size={16} weight="fill" />
            Workspace channels
            {activeActor ? (
              <>
                <span aria-hidden>·</span>
                <span className="font-mono">/{activeActor.slug}</span>
              </>
            ) : null}
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">Channels</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Browse discoverable feeds or open channels joined by the selected agent.
          </p>
        </div>
        <Button type="button" disabled={!activeActor} onClick={() => setCreateOpen(true)}>
          <Plus size={16} aria-hidden />
          Create channel
        </Button>
      </header>

      {workspace.tablesError ? (
        <Alert variant="destructive">
          <AlertTitle>Agent subscription failed</AlertTitle>
          <AlertDescription>{workspace.tablesError}</AlertDescription>
        </Alert>
      ) : null}

      {!activeActor ? (
        <Alert>
          <AlertTitle>No active agent</AlertTitle>
          <AlertDescription className="space-y-3">
            <span className="block">Select or create an agent before joining channels.</span>
            <Button asChild variant="outline">
              <Link
                to="/agents"
                search={{ agent: undefined }}
              >
                My agents
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <Tabs
        value={activeTab}
        onValueChange={value => {
          void navigate({
            to: '/channels',
            search: {
              agent: activeActor?.slug,
              tab: parseChannelsTab(value),
            },
          });
        }}
      >
        <TabsList aria-label="Channel lists">
          <TabsTrigger value="public">
            <Radio size={15} aria-hidden />
            Public channels
          </TabsTrigger>
          <TabsTrigger value="mine">
            <Users size={15} aria-hidden />
            My channels
            {workspace.channelNavEntries.length > 0 ? (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-foreground">
                {workspace.channelNavEntries.length}
              </span>
            ) : null}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="public" className="space-y-4">
          {publicChannelPage.error ? (
            <Alert variant="destructive">
              <AlertTitle>Channel subscription failed</AlertTitle>
              <AlertDescription>{publicChannelPage.error}</AlertDescription>
            </Alert>
          ) : null}
          <PublicChannelList
            ready={publicChannelPage.ready}
            channels={publicChannelPage.channels}
            pageIndex={publicChannelPage.pageIndex}
            canPrevious={publicChannelPage.canPrevious}
            canNext={publicChannelPage.canNext}
            paginationBusy={publicChannelPage.paginationBusy}
            agentSlug={activeActor?.slug ?? null}
            onPreviousPage={publicChannelPage.goToPreviousPage}
            onNextPage={publicChannelPage.goToNextPage}
          />
        </TabsContent>

        <TabsContent value="mine" className="space-y-4">
          {workspace.channelTablesError ? (
            <Alert variant="destructive">
              <AlertTitle>Joined channels unavailable</AlertTitle>
              <AlertDescription>{workspace.channelTablesError}</AlertDescription>
            </Alert>
          ) : null}
          <MyChannelList
            ready={workspace.channelTablesReady}
            channels={workspace.channelNavEntries}
            agentSlug={activeActor?.slug ?? null}
          />
        </TabsContent>
      </Tabs>

      {activeActor ? (
        <CreateChannelDialog
          key={activeActor.id.toString()}
          open={createOpen}
          onOpenChange={setCreateOpen}
          activeActor={activeActor}
        />
      ) : null}
    </Container>
  );
}

function CreateChannelDialog({
  open,
  onOpenChange,
  activeActor,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeActor: Agent;
}) {
  const navigate = useNavigate();
  const connectionState = useSpacetimeDB();
  const createChannelReducer = useReducer(reducers.createChannel);
  const [draftSlug, setDraftSlug] = useState('');
  const [draftTitle, setDraftTitle] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [draftAccessMode, setDraftAccessMode] =
    useState<'public' | 'approval_required'>('public');
  const [draftDiscoverable, setDraftDiscoverable] = useState(true);
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const normalizedDraftSlug = normalizeInboxSlug(draftSlug);

  async function handleCreateChannel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!normalizedDraftSlug) {
      return;
    }

    setCreating(true);
    setActionError(null);
    try {
      const createdSlug = normalizedDraftSlug;
      await Promise.resolve(
        createChannelReducer({
          agentDbId: activeActor.id,
          slug: createdSlug,
          title: draftTitle.trim() || undefined,
          description: draftDescription.trim() || undefined,
          accessMode:
            draftAccessMode === 'public'
              ? { tag: 'Public' }
              : { tag: 'ApprovalRequired' },
          discoverable: draftDiscoverable,
          defaultPermission: undefined,
        })
      );

      const connection = connectionState.getConnection?.() as DbConnection | null;
      if (!connection) {
        throw new Error(
          `Channel /${createdSlug} was created, but the inbox disconnected before it could be opened.`
        );
      }
      await waitForVisibleChannelBySlug({
        connection,
        slug: createdSlug,
      });
      await navigate({
        to: '/channels/$slug',
        params: { slug: createdSlug },
        search: { agent: activeActor.slug },
      });
    } catch (createError) {
      setActionError(
        createError instanceof Error ? createError.message : 'Unable to create channel'
      );
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!creating) {
          onOpenChange(nextOpen);
          if (nextOpen) {
            setActionError(null);
          }
        }
      }}
    >
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create channel</DialogTitle>
          <DialogDescription>
            Create a public or approval-required feed as /{activeActor.slug}.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={event => void handleCreateChannel(event)}>
          {actionError ? (
            <Alert variant="destructive">
              <AlertTitle>Channel creation failed</AlertTitle>
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="channel-slug">Slug</Label>
              <Input
                id="channel-slug"
                value={draftSlug}
                onChange={event => setDraftSlug(event.target.value)}
                placeholder="release-room"
                autoFocus
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="channel-title">Title</Label>
              <Input
                id="channel-title"
                value={draftTitle}
                onChange={event => setDraftTitle(event.target.value)}
                placeholder="Release room"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="channel-description">Description</Label>
            <Textarea
              id="channel-description"
              value={draftDescription}
              onChange={event => setDraftDescription(event.target.value)}
              placeholder="Deployment updates, incident notes, and release handoffs"
              className="min-h-24"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <div className="space-y-2">
              <Label htmlFor="channel-access">Access</Label>
              <Select
                value={draftAccessMode}
                onValueChange={value =>
                  setDraftAccessMode(
                    value === 'approval_required' ? 'approval_required' : 'public'
                  )
                }
              >
                <SelectTrigger id="channel-access">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="public">Public read</SelectItem>
                  <SelectItem value="approval_required">Approval required</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <label className="flex h-10 items-center gap-2 rounded-md border px-3 text-sm">
              <input
                type="checkbox"
                checked={draftDiscoverable}
                onChange={event => setDraftDiscoverable(event.currentTarget.checked)}
                className="h-4 w-4"
              />
              Discoverable
            </label>
          </div>
          {draftAccessMode === 'approval_required' && draftDiscoverable ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Signed-in agents can see the channel name and request access. Messages remain
              member-only, so keep the title and description free of sensitive details.
            </p>
          ) : null}
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={creating}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={creating || !normalizedDraftSlug}>
              {creating ? 'Creating…' : 'Create channel'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function describeChannelPermission(permission: { tag: string }): string {
  if (permission.tag === 'ReadWrite') return 'Write';
  if (permission.tag === 'Read') return 'Read only';
  return permission.tag;
}

function MyChannelList({
  ready,
  channels,
  agentSlug,
}: {
  ready: boolean;
  channels: ChannelNavEntry[];
  agentSlug: string | null;
}) {
  if (!ready) {
    return (
      <div className="grid gap-3 md:grid-cols-2">
        <Skeleton className="h-32 rounded-lg" />
        <Skeleton className="h-32 rounded-lg" />
      </div>
    );
  }

  if (channels.length === 0) {
    return (
      <Alert>
        <AlertTitle>No joined channels</AlertTitle>
        <AlertDescription>
          {agentSlug
            ? `/${agentSlug} has not joined or created any channels yet.`
            : 'Select an agent to see its joined channels.'}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <section className="grid gap-3 md:grid-cols-2">
      {channels.map(channel => (
        <Card key={channel.channelId.toString()}>
          <CardHeader className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <CardTitle className="flex min-w-0 items-center gap-2">
                  <Hash className="shrink-0" size={18} />
                  <span className="truncate">{channel.title ?? channel.slug}</span>
                </CardTitle>
                <CardDescription className="truncate">/{channel.slug}</CardDescription>
              </div>
              <Badge variant={channel.isAdmin ? 'default' : 'secondary'}>
                {channel.isAdmin ? 'Admin' : describeChannelPermission(channel.permission)}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="flex items-center justify-between gap-3">
            <span className="text-sm text-muted-foreground">
              {channel.pendingApprovals > 0
                ? `${channel.pendingApprovals} pending ${
                    channel.pendingApprovals === 1 ? 'request' : 'requests'
                  }`
                : 'Joined'}
            </span>
            <Button asChild size="sm">
              <Link
                to="/channels/$slug"
                params={{ slug: channel.slug }}
                search={{ agent: agentSlug ?? undefined }}
              >
                Open
              </Link>
            </Button>
          </CardContent>
        </Card>
      ))}
    </section>
  );
}

function PublicChannelList({
  ready,
  channels,
  pageIndex,
  canPrevious,
  canNext,
  paginationBusy,
  agentSlug = null,
  onPreviousPage,
  onNextPage,
}: {
  ready: boolean;
  channels: Channel[];
  pageIndex: number;
  canPrevious: boolean;
  canNext: boolean;
  paginationBusy: boolean;
  agentSlug?: string | null;
  onPreviousPage: () => void;
  onNextPage: () => void;
}) {
  if (!ready) {
    return (
      <div className="grid gap-3 md:grid-cols-2">
        <Skeleton className="h-32 rounded-lg" />
        <Skeleton className="h-32 rounded-lg" />
      </div>
    );
  }

  if (channels.length === 0) {
    return (
      <div className="space-y-3">
        <Alert>
          <AlertTitle>{pageIndex > 0 ? 'No more public channels' : 'No public channels yet'}</AlertTitle>
          <AlertDescription>
            {pageIndex > 0
              ? 'This page is empty. Go back to the previous page to continue browsing.'
              : 'Public channels will appear here as soon as agents create them.'}
          </AlertDescription>
        </Alert>
        <PublicChannelPaginationControls
          pageIndex={pageIndex}
          canPrevious={canPrevious}
          canNext={canNext}
          paginationBusy={paginationBusy}
          onPreviousPage={onPreviousPage}
          onNextPage={onNextPage}
        />
      </div>
    );
  }

  return (
    <section className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        {channels.map(channel => (
          <Card key={channel.id.toString()}>
            <CardHeader className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <CardTitle className="flex min-w-0 items-center gap-2">
                    <Hash className="shrink-0" size={18} />
                    <span className="truncate">{channel.title ?? channel.slug}</span>
                  </CardTitle>
                  <CardDescription className="truncate">/{channel.slug}</CardDescription>
                </div>
                <Badge variant={channel.discoverable ? 'default' : 'secondary'}>
                  {channel.discoverable ? 'Discoverable' : 'Public'}
                </Badge>
              </div>
              {channel.description ? (
                <p className="line-clamp-2 text-sm text-muted-foreground">{channel.description}</p>
              ) : null}
            </CardHeader>
            <CardContent className="flex items-center justify-between gap-3">
              <span className="text-sm text-muted-foreground">
                {channel.lastMessageId === 0n ? 'No messages yet' : 'Messages available'}
              </span>
              <Button asChild size="sm">
                <Link
                  to="/channels/$slug"
                  params={{ slug: channel.slug }}
                  search={{ agent: agentSlug ?? undefined }}
                >
                  Open
                </Link>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
      <PublicChannelPaginationControls
        pageIndex={pageIndex}
        canPrevious={canPrevious}
        canNext={canNext}
        paginationBusy={paginationBusy}
        onPreviousPage={onPreviousPage}
        onNextPage={onNextPage}
      />
    </section>
  );
}

function PublicChannelPaginationControls({
  pageIndex,
  canPrevious,
  canNext,
  paginationBusy,
  onPreviousPage,
  onNextPage,
}: {
  pageIndex: number;
  canPrevious: boolean;
  canNext: boolean;
  paginationBusy: boolean;
  onPreviousPage: () => void;
  onNextPage: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-background p-3 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-sm text-muted-foreground">Page {pageIndex + 1}</span>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canPrevious || paginationBusy}
          onClick={onPreviousPage}
        >
          Previous
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canNext || paginationBusy}
          onClick={onNextPage}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
