import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useDeferredValue, useEffect, useState } from 'react';
import {
  CaretLeft,
  CaretRight,
  Envelope,
  MagnifyingGlass,
  Users,
} from '@phosphor-icons/react';
import { AgentAvatar } from '@/components/inbox/agent-avatar';
import { EmptyState } from '@/components/inbox/empty-state';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { buildRouteHead } from '@/lib/seo';
import {
  discoverMasumiNetworkAgents,
  type DiscoveredNetworkAgent,
} from '@/lib/published-actor-search';
import { useWorkspaceShell } from '@/features/workspace/use-workspace-shell';
import { WorkspaceRouteShell } from '@/features/workspace/workspace-route-shell';

export const Route = createFileRoute('/discover')({
  head: () =>
    buildRouteHead({
      title: 'Discover agents',
      description:
        'Find other agents on the Masumi network and start a conversation.',
      path: '/discover',
    }),
  component: DiscoverPage,
});

function describeDiscoveredAgent(actor: DiscoveredNetworkAgent): string {
  return actor.displayName?.trim() ? actor.displayName : actor.slug;
}

function discoveredAgentKey(actor: DiscoveredNetworkAgent): string {
  return actor.slug;
}

type DiscoveryResultState = {
  requestKey: string | null;
  agents: DiscoveredNetworkAgent[];
  hasNextPage: boolean;
  error: string | null;
};

function DiscoverPage() {
  const navigate = useNavigate();
  const workspace = useWorkspaceShell();
  const session = workspace.status === 'ready' ? workspace.session : null;

  const [searchQuery, setSearchQuery] = useState('');
  const [discoveryPage, setDiscoveryPage] = useState(1);
  const [discoveryState, setDiscoveryState] = useState<DiscoveryResultState>({
    requestKey: null,
    agents: [],
    hasNextPage: false,
    error: null,
  });
  const deferredQuery = useDeferredValue(searchQuery.trim());
  const sessionKey = session
    ? `${session.user.issuer}|${session.user.subject}`
    : null;
  const discoveryRequestKey = sessionKey
    ? `${sessionKey}\u0000${deferredQuery}\u0000${discoveryPage}`
    : null;
  const discoveryMatchesRequest =
    discoveryRequestKey !== null && discoveryState.requestKey === discoveryRequestKey;
  const discoveredAgents = discoveryMatchesRequest ? discoveryState.agents : [];
  const discoveryHasNextPage = discoveryMatchesRequest
    ? discoveryState.hasNextPage
    : false;
  const discoveryLoaded = discoveryMatchesRequest;
  const discoveryBusy = Boolean(discoveryRequestKey && !discoveryMatchesRequest);
  const discoveryError = discoveryMatchesRequest ? discoveryState.error : null;

  const existingDefaultActor =
    workspace.status === 'ready' ? workspace.existingDefaultActor : null;
  const needsBootstrapRedirect =
    workspace.status === 'ready' && workspace.tablesReady && !existingDefaultActor;

  useEffect(() => {
    if (!needsBootstrapRedirect) {
      return;
    }

    void navigate({
      to: '/',
      replace: true,
    });
  }, [navigate, needsBootstrapRedirect]);

  useEffect(() => {
    if (!session || !discoveryRequestKey) {
      return;
    }

    let cancelled = false;

    void discoverMasumiNetworkAgents({
      identifier: deferredQuery || undefined,
      session,
      take: 20,
      page: discoveryPage,
    })
      .then(result => {
        if (cancelled) return;
        setDiscoveryState({
          requestKey: discoveryRequestKey,
          agents: result.agents,
          hasNextPage: result.hasNextPage,
          error: null,
        });
      })
      .catch(lookupError => {
        if (cancelled) return;
        const message =
          lookupError instanceof Error
            ? lookupError.message
            : 'Unable to search registered agents right now.';
        if (message === 'No published inbox actor found for that slug or email.') {
          setDiscoveryState({
            requestKey: discoveryRequestKey,
            agents: [],
            hasNextPage: false,
            error: null,
          });
          return;
        }
        setDiscoveryState({
          requestKey: discoveryRequestKey,
          agents: [],
          hasNextPage: false,
          error: message,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [deferredQuery, discoveryPage, discoveryRequestKey, session]);

  return (
    <WorkspaceRouteShell
      workspace={workspace}
      section="discover"
      title="Discover agents"
      signInReturnTo="/discover"
      signedOutDescription="Sign in to search for agents and start conversations."
    >
      {needsBootstrapRedirect ? (
        <div className="space-y-4">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-64 w-full rounded-lg" />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="relative max-w-md">
            <MagnifyingGlass
              className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={searchQuery}
              onChange={event => {
                setSearchQuery(event.target.value);
                setDiscoveryPage(1);
              }}
              placeholder="Search by slug or email..."
              className="pl-9"
            />
          </div>

          {discoveryBusy || !discoveryLoaded ? (
            <div className="space-y-2">
              <Skeleton className="h-14 w-full rounded-md" />
              <Skeleton className="h-14 w-full rounded-md" />
              <Skeleton className="h-14 w-full rounded-md" />
            </div>
          ) : discoveryError ? (
            <Alert variant="destructive">
              <AlertDescription>{discoveryError}</AlertDescription>
            </Alert>
          ) : discoveredAgents.length === 0 && !deferredQuery ? (
            <EmptyState
              icon={Users}
              title="No registered agents available"
              description="Registered inbox agents will appear here. Search by slug or email above."
            />
          ) : discoveredAgents.length === 0 ? (
            <EmptyState
              icon={MagnifyingGlass}
              title="No agents found"
              description="No verified agents match your search."
            />
          ) : (
            <div className="space-y-1.5">
              {discoveredAgents.map(actor => {
                const key = discoveredAgentKey(actor);
                const displayName = describeDiscoveredAgent(actor);
                const description = actor.description?.trim();
                const email = actor.linkedEmail?.trim();

                return (
                  <Link
                    key={key}
                    to="/discover/$slug"
                    params={{ slug: actor.slug }}
                    className="flex w-full items-start gap-3 rounded-md border border-transparent px-3 py-3 text-left transition-colors hover:border-border/60 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  >
                    <AgentAvatar
                      name={displayName}
                      identity={actor.slug}
                      size="lg"
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-baseline gap-2">
                        <p className="truncate text-sm font-semibold">{displayName}</p>
                        <span className="truncate font-mono text-[11px] text-muted-foreground">
                          /{actor.slug}
                        </span>
                      </div>
                      {email ? (
                        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <Envelope className="h-3 w-3 shrink-0" aria-hidden />
                          <span className="truncate font-mono">{email}</span>
                        </p>
                      ) : null}
                      {description ? (
                        <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                          {description}
                        </p>
                      ) : null}
                    </div>
                  </Link>
                );
              })}
            </div>
          )}

          {discoveryLoaded && discoveredAgents.length > 0 ? (
            <div className="flex items-center justify-start gap-2 pt-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={discoveryBusy || discoveryPage <= 1}
                onClick={() => setDiscoveryPage(current => Math.max(1, current - 1))}
              >
                <CaretLeft className="h-4 w-4" />
                Prev
              </Button>
              <span className="min-w-12 text-center text-xs text-muted-foreground">
                {discoveryPage}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={discoveryBusy || !discoveryHasNextPage}
                onClick={() => setDiscoveryPage(current => current + 1)}
              >
                Next
                <CaretRight className="h-4 w-4" />
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </WorkspaceRouteShell>
  );
}
