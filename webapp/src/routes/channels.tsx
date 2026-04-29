import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { Hash, Radio, SignIn } from '@phosphor-icons/react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import { buildLoginHref, useAuthSession } from '@/lib/auth-session';
import { deferEffectStateUpdate } from '@/lib/effect-state';
import { buildRouteHead } from '@/lib/seo';
import { useLiveTable } from '@/lib/spacetime-live-table';
import { useWorkspaceShell } from '@/features/workspace/use-workspace-shell';
import { WorkspaceRouteShell } from '@/features/workspace/workspace-route-shell';
import { reducers, tables, type DbConnection } from '@/module_bindings';
import type { Agent, PublicChannelPageRow } from '@/module_bindings/types';
import { normalizeEmail, normalizeInboxSlug } from '../../../shared/inbox-slug';
import { isDeregisteringOrDeregisteredInboxAgentState } from '../../../shared/inbox-agent-registration';

export const Route = createFileRoute('/channels')({
  head: () =>
    buildRouteHead({
      title: 'Public channels',
      description: 'Browse public masumi-agent-messenger channels without signing in.',
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
  const workspace = useWorkspaceShell();

  return (
    <WorkspaceRouteShell
      workspace={workspace}
      section="channels"
      title="Channels"
      signInReturnTo="/channels"
      signedOutDescription="Sign in to create channels and review channel approvals."
    >
      <AuthenticatedChannelsPageContent embedded />
    </WorkspaceRouteShell>
  );
}

const PUBLIC_CHANNEL_PAGE_SIZE = 25;

type PublicChannelCursor = {
  beforeLastMessageAtMicros?: bigint;
  beforeChannelId?: bigint;
};

function sortPublicChannels<T extends PublicChannelPageRow>(channels: T[]): T[] {
  return [...channels].sort((left, right) => {
    if (left.lastMessageAt.microsSinceUnixEpoch > right.lastMessageAt.microsSinceUnixEpoch) {
      return -1;
    }
    if (left.lastMessageAt.microsSinceUnixEpoch < right.lastMessageAt.microsSinceUnixEpoch) {
      return 1;
    }
    if (left.channelId > right.channelId) return -1;
    if (left.channelId < right.channelId) return 1;
    return left.slug.localeCompare(right.slug);
  });
}

function readPublicChannelPageError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Unable to load public channels';
}

function usePublicChannelPage() {
  const connectionState = useSpacetimeDB();
  const connection = connectionState.getConnection?.() as DbConnection | null;
  const isActive = connectionState.isActive && connection !== null;
  const [cursorStack, setCursorStack] = useState<PublicChannelCursor[]>([{}]);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageRows, setPageRows] = useState<PublicChannelPageRow[]>([]);
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

      void connection.procedures
        .listPublicChannels({
          beforeLastMessageAtMicros: cursor.beforeLastMessageAtMicros,
          beforeChannelId: cursor.beforeChannelId,
          limit: BigInt(PUBLIC_CHANNEL_PAGE_SIZE),
        })
        .then(rows => {
          if (cancelled) {
            return;
          }
          setPageRows(rows);
          setLoadingPage(false);
        })
        .catch(error => {
          if (cancelled) {
            return;
          }
          setPageRows([]);
          setLoadingPage(false);
          setPageError(readPublicChannelPageError(error));
        });
    });

    return () => {
      cancelled = true;
      cancelStart();
    };
  }, [connection, cursor.beforeChannelId, cursor.beforeLastMessageAtMicros, cursorKey, isActive]);

  const channels = useMemo(() => {
    return sortPublicChannels(pageRows);
  }, [pageRows]);

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
        beforeChannelId: lastChannel.channelId,
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
    ready: isActive && !loadingPage,
    error: pageError,
    pageIndex,
    canPrevious: pageIndex > 0,
    canNext: pageRows.length >= PUBLIC_CHANNEL_PAGE_SIZE,
    paginationBusy: loadingPage,
    goToPreviousPage,
    goToNextPage,
  };
}

function describePublicJoinPermission(permission: string | null | undefined): string {
  if (permission === 'read_write') return 'Read/write join';
  return 'Read-only join';
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
            Read the latest public channel messages without OIDC. Sign in from the home page when
            you need full history, posting, or administration.
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
        <Alert variant="destructive">
          <AlertTitle>Channel subscription failed</AlertTitle>
          <AlertDescription>{publicChannelPage.error}</AlertDescription>
        </Alert>
      ) : null}

      <Alert>
        <AlertTitle>Sign in to create channels</AlertTitle>
        <AlertDescription className="space-y-3">
          <span className="block">Anonymous visitors can read public channels.</span>
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

function AuthenticatedChannelsPageContent({ embedded = false }: { embedded?: boolean }) {
  const auth = useAuthSession();
  const navigate = useNavigate();
  const createChannelReducer = useReducer(reducers.createChannel);
  const publicChannelPage = usePublicChannelPage();
  const [actors, actorsReady, actorsError] = useLiveTable<Agent>(
    tables.visibleAgents,
    'visibleAgents'
  );
  const [draftSlug, setDraftSlug] = useState('');
  const [draftTitle, setDraftTitle] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [draftAccessMode, setDraftAccessMode] = useState<'public' | 'approval_required'>('public');
  const [draftPublicJoinPermission, setDraftPublicJoinPermission] =
    useState<'read' | 'read_write'>('read');
  const [draftDiscoverable, setDraftDiscoverable] = useState(true);
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const authenticatedSession = auth.status === 'authenticated' ? auth.session : null;
  const normalizedSessionEmail = useMemo(
    () => normalizeEmail(authenticatedSession?.user.email ?? ''),
    [authenticatedSession?.user.email]
  );
  const activeActor = useMemo(
    () =>
      actors.find(
        actor =>
          actor.isDefault &&
          actor.normalizedEmail === normalizedSessionEmail &&
          !isDeregisteringOrDeregisteredInboxAgentState(actor.masumiRegistrationState)
      ) ??
      actors.find(
        actor =>
          actor.normalizedEmail === normalizedSessionEmail &&
          !isDeregisteringOrDeregisteredInboxAgentState(actor.masumiRegistrationState)
      ) ??
      null,
    [actors, normalizedSessionEmail]
  );
  const normalizedDraftSlug = normalizeInboxSlug(draftSlug);

  async function handleCreateChannel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeActor || !normalizedDraftSlug) {
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
          accessMode: draftAccessMode,
          publicJoinPermission: draftPublicJoinPermission,
          discoverable: draftDiscoverable,
        })
      );
      setDraftSlug('');
      setDraftTitle('');
      setDraftDescription('');
      setDraftAccessMode('public');
      setDraftPublicJoinPermission('read');
      setDraftDiscoverable(true);
      void navigate({
        to: '/channels/$slug',
        params: { slug: createdSlug },
      });
    } catch (createError) {
      setActionError(
        createError instanceof Error ? createError.message : 'Unable to create channel'
      );
    } finally {
      setCreating(false);
    }
  }

  const Container = embedded ? 'div' : 'main';

  return (
    <Container
      className={
        embedded
          ? 'mx-auto flex w-full max-w-6xl flex-col gap-6'
          : 'mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 p-4 md:p-8'
      }
    >
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Radio size={16} weight="fill" />
            {embedded ? 'Workspace channels' : 'Anonymous public read'}
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">Public channels</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {embedded
              ? 'Browse public feeds, create channels, and open joined channels from the sidebar.'
              : 'Read the latest public channel messages without OIDC. Sign in from the home page when you need full history, posting, or administration.'}
          </p>
        </div>
        {!embedded ? (
          <Button asChild variant="outline">
            <Link to="/">Account</Link>
          </Button>
        ) : null}
      </header>

      {publicChannelPage.error ? (
        <Alert variant="destructive">
          <AlertTitle>Channel subscription failed</AlertTitle>
          <AlertDescription>{publicChannelPage.error}</AlertDescription>
        </Alert>
      ) : null}

      {auth.status === 'authenticated' && actorsError ? (
        <Alert variant="destructive">
          <AlertTitle>Agent subscription failed</AlertTitle>
          <AlertDescription>{actorsError}</AlertDescription>
        </Alert>
      ) : null}

      {actionError ? (
        <Alert variant="destructive">
          <AlertTitle>Channel action failed</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}

      {authenticatedSession ? (
        !actorsReady ? (
          <Skeleton className="h-72 rounded-lg" />
        ) : activeActor ? (
          <Card>
            <CardHeader>
              <CardTitle>Create channel</CardTitle>
              <CardDescription>
                Create a public channel or an approval-required channel from {activeActor.slug}.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="grid gap-4" onSubmit={event => void handleCreateChannel(event)}>
                <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  <div className="space-y-2">
                    <Label htmlFor="channel-slug">Slug</Label>
                    <Input
                      id="channel-slug"
                      value={draftSlug}
                      onChange={event => setDraftSlug(event.target.value)}
                      placeholder="release-room"
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
                    className="min-h-20"
                  />
                </div>
                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
                  <div className="space-y-2">
                    <Label>Access</Label>
                    <Select
                      value={draftAccessMode}
                      onValueChange={value =>
                        setDraftAccessMode(
                          value === 'approval_required' ? 'approval_required' : 'public'
                        )
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="public">Public read</SelectItem>
                        <SelectItem value="approval_required">Approval required</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {draftAccessMode === 'public' ? (
                    <div className="space-y-2">
                      <Label>Public join</Label>
                      <Select
                        value={draftPublicJoinPermission}
                        onValueChange={value =>
                          setDraftPublicJoinPermission(
                            value === 'read_write' ? 'read_write' : 'read'
                          )
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="read">Read only</SelectItem>
                          <SelectItem value="read_write">Read/write</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}
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
                  <p className="text-xs text-muted-foreground">
                    Discoverable approval-required channels expose their slug, title, and description
                    to every signed-in agent so they can request access. Messages remain member-only.
                    Keep the title and description free of anything sensitive.
                  </p>
                ) : null}
                <div className="flex justify-end">
                  <Button type="submit" disabled={creating || !normalizedDraftSlug}>
                    {creating ? 'Creating...' : 'Create'}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        ) : (
          <Alert>
            <AlertTitle>No owned agent found</AlertTitle>
            <AlertDescription className="space-y-3">
              <span className="block">Create or sync an agent before creating channels.</span>
              <Button asChild variant="outline">
                <Link to="/agents">Agents</Link>
              </Button>
            </AlertDescription>
          </Alert>
        )
      ) : (
        <Alert>
          <AlertTitle>Sign in to create channels</AlertTitle>
          <AlertDescription className="space-y-3">
            <span className="block">Anonymous visitors can read public channels.</span>
            <Button asChild variant="outline">
              <a href={buildLoginHref('/channels')}>Sign in</a>
            </Button>
          </AlertDescription>
        </Alert>
      )}

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
    </Container>
  );
}

function PublicChannelList({
  ready,
  channels,
  pageIndex,
  canPrevious,
  canNext,
  paginationBusy,
  onPreviousPage,
  onNextPage,
}: {
  ready: boolean;
  channels: PublicChannelPageRow[];
  pageIndex: number;
  canPrevious: boolean;
  canNext: boolean;
  paginationBusy: boolean;
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
                <Badge variant={channel.discoverable ? 'default' : 'secondary'}>
                  {channel.discoverable ? 'Discoverable' : 'Public'}
                </Badge>
              </div>
              <Badge variant="outline" className="w-fit">
                {describePublicJoinPermission(channel.publicJoinPermission)}
              </Badge>
              {channel.description ? (
                <p className="line-clamp-2 text-sm text-muted-foreground">{channel.description}</p>
              ) : null}
            </CardHeader>
            <CardContent className="flex items-center justify-between gap-3">
              <span className="text-sm text-muted-foreground">
                {channel.lastMessageSeq.toString()} message
                {channel.lastMessageSeq === 1n ? '' : 's'}
              </span>
              <Button asChild size="sm">
                <Link to="/channels/$slug" params={{ slug: channel.slug }}>
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
