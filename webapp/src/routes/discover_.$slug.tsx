import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  EnvelopeSimple,
  ShieldCheck,
  Users,
  WarningCircle,
} from '@phosphor-icons/react';
import { AgentAvatar } from '@/components/inbox/agent-avatar';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { buildWorkspaceSearch } from '@/lib/app-shell';
import { buildRouteHead } from '@/lib/seo';
import {
  discoverMasumiNetworkAgents,
  type DiscoveredNetworkAgent,
} from '@/lib/published-actor-search';
import { useWorkspaceShell } from '@/features/workspace/use-workspace-shell';
import { WorkspaceRouteShell } from '@/features/workspace/workspace-route-shell';

export const Route = createFileRoute('/discover_/$slug')({
  head: ({ params }) =>
    buildRouteHead({
      title: `/${params.slug}`,
      description: `Public profile for /${params.slug} on the Masumi network.`,
      path: `/discover/${params.slug}`,
    }),
  component: DiscoveredAgentDetailsPage,
});

function describeDiscoveredAgent(actor: DiscoveredNetworkAgent): string {
  return actor.displayName?.trim() ? actor.displayName : actor.slug;
}

type DiscoveredAgentLookupState = {
  requestKey: string | null;
  agent: DiscoveredNetworkAgent | null;
  error: string | null;
};

function DiscoveredAgentDetailsPage() {
  const params = Route.useParams();
  const navigate = useNavigate();
  const workspace = useWorkspaceShell();
  const session = workspace.status === 'ready' ? workspace.session : null;
  const workspaceSlug =
    workspace.status === 'ready'
      ? workspace.shellInboxSlug ?? workspace.existingDefaultActor?.slug ?? null
      : null;

  const [lookupState, setLookupState] = useState<DiscoveredAgentLookupState>({
    requestKey: null,
    agent: null,
    error: null,
  });
  const sessionKey = session
    ? `${session.user.issuer}|${session.user.subject}`
    : null;
  const lookupRequestKey = sessionKey
    ? `${sessionKey}\u0000${params.slug}`
    : null;
  const lookupMatchesRequest =
    lookupRequestKey !== null && lookupState.requestKey === lookupRequestKey;
  const agent = lookupMatchesRequest ? lookupState.agent : null;
  const busy = Boolean(lookupRequestKey && !lookupMatchesRequest);
  const error = lookupMatchesRequest ? lookupState.error : null;

  useEffect(() => {
    if (!session || !lookupRequestKey) {
      return;
    }

    let cancelled = false;

    void discoverMasumiNetworkAgents({
      identifier: params.slug,
      session,
      take: 5,
    })
      .then(result => {
        if (cancelled) return;
        const match =
          result.agents.find(entry => entry.slug === params.slug) ?? null;
        if (!match) {
          setLookupState({
            requestKey: lookupRequestKey,
            agent: null,
            error: 'No registered agent found for this slug.',
          });
          return;
        }
        setLookupState({
          requestKey: lookupRequestKey,
          agent: match,
          error: null,
        });
      })
      .catch(lookupError => {
        if (cancelled) return;
        setLookupState({
          requestKey: lookupRequestKey,
          agent: null,
          error: lookupError instanceof Error
            ? lookupError.message
            : 'Unable to load this agent right now.',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [lookupRequestKey, params.slug, session]);

  function openThreadWithAgent() {
    if (!workspaceSlug) {
      void navigate({ to: '/' });
      return;
    }

    void navigate({
      to: '/$slug',
      params: { slug: workspaceSlug },
      search: buildWorkspaceSearch({
        lookup: params.slug,
        compose: 'direct',
      }),
    });
  }

  return (
    <WorkspaceRouteShell
      workspace={workspace}
      section="discover"
      title={`/${params.slug}`}
      signedOutTitle={`/${params.slug}`}
      signInReturnTo={`/discover/${params.slug}`}
      signedOutDescription={`Sign in to view the public profile for /${params.slug} and open an encrypted thread.`}
    >
      <div className="space-y-4">
        <div>
          <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-xs">
            <Link to="/discover">
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to discover
            </Link>
          </Button>
        </div>

        {busy ? (
          <div className="space-y-3">
            <Skeleton className="h-24 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </div>
        ) : error ? (
          <Alert variant="destructive">
            <WarningCircle className="h-4 w-4" />
            <AlertTitle>Agent not found</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : agent ? (
          <div className="space-y-4">
            <div className="flex items-start gap-4 rounded-xl border border-border/60 bg-card/60 p-5">
              <AgentAvatar
                name={describeDiscoveredAgent(agent)}
                identity={agent.slug}
                size="lg"
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-lg font-semibold tracking-tight">
                    {describeDiscoveredAgent(agent)}
                  </h2>
                  {agent.agentIdentifier ? (
                    <Badge variant="secondary" className="text-[10px]">
                      <ShieldCheck className="mr-0.5 h-3 w-3" />
                      Registered
                    </Badge>
                  ) : null}
                </div>
                <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                  /{agent.slug}
                </p>
                {agent.description?.trim() ? (
                  <p className="mt-3 whitespace-pre-wrap text-sm text-foreground/90">
                    {agent.description}
                  </p>
                ) : (
                  <p className="mt-3 text-sm text-muted-foreground">
                    This agent has not published a description yet.
                  </p>
                )}
              </div>
            </div>

            {agent.agentIdentifier ? (
              <div className="rounded-lg border border-border/50 bg-muted/30 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                  Masumi agent identifier
                </p>
                <p className="mt-1.5 break-all font-mono text-sm text-foreground">
                  {agent.agentIdentifier}
                </p>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                onClick={openThreadWithAgent}
                disabled={!workspaceSlug}
              >
                <EnvelopeSimple className="h-4 w-4" />
                Open encrypted thread
              </Button>
              {!workspaceSlug ? (
                <span className="text-xs text-muted-foreground">
                  <Users className="mr-1 inline h-3 w-3" />
                  Register your inbox to start threads.
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </WorkspaceRouteShell>
  );
}
