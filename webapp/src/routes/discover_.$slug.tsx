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
  lookupMasumiNetworkAgent,
  type DiscoveredNetworkAgent,
} from '@/lib/published-actor-search';
import { useWorkspaceShell } from '@/features/workspace/use-workspace-shell';
import { WorkspaceRouteShell } from '@/features/workspace/workspace-route-shell';
import type { DbConnection } from '@/module_bindings';
import {
  isDeregisteringOrDeregisteredInboxAgentState,
  isFailedRegistrationInboxAgentState,
  isPendingMasumiInboxAgentState,
  isUnavailableForChatInboxAgentState,
} from '../../../shared/inbox-agent-registration';

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

function getDiscoveredAgentBadge(actor: DiscoveredNetworkAgent): {
  label: string;
  variant: 'secondary' | 'outline' | 'soft-warning' | 'soft-danger';
} | null {
  if (isFailedRegistrationInboxAgentState(actor.registrationState)) {
    return { label: 'Invalid', variant: 'soft-danger' };
  }
  if (isDeregisteringOrDeregisteredInboxAgentState(actor.registrationState)) {
    return {
      label:
        actor.registrationState === 'DeregistrationConfirmed'
          ? 'Deregistered'
          : 'Deregistering',
      variant: 'outline',
    };
  }
  if (isPendingMasumiInboxAgentState(actor.registrationState)) {
    return { label: 'Pending', variant: 'soft-warning' };
  }
  return actor.agentIdentifier ? { label: 'Registered', variant: 'secondary' } : null;
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
  const liveConnection =
    workspace.status === 'ready'
      ? (workspace.conn.getConnection?.() as DbConnection | null)
      : null;
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
    ? `${sessionKey}\u0000${params.slug}\u0000${liveConnection ? 'live' : 'pending'}`
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

    void lookupMasumiNetworkAgent({
      slug: params.slug,
      session,
      liveConnection,
    })
      .then(match => {
        if (cancelled) return;
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
  }, [liveConnection, lookupRequestKey, params.slug, session]);

  function openThreadWithAgent() {
    if (isUnavailableForChatInboxAgentState(agent?.registrationState)) {
      return;
    }

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
            {(() => {
              const badge = getDiscoveredAgentBadge(agent);
              const unavailableForChat = isUnavailableForChatInboxAgentState(
                agent.registrationState
              );
              const invalidRegistration = isFailedRegistrationInboxAgentState(
                agent.registrationState
              );

              return (
                <>
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
                  {badge ? (
                    <Badge variant={badge.variant} className="text-[10px]">
                      {badge.label === 'Registered' ? (
                        <ShieldCheck className="mr-0.5 h-3 w-3" />
                      ) : null}
                      {badge.label}
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

            {unavailableForChat ? (
              <Alert variant="destructive">
                <WarningCircle className="h-4 w-4" />
                <AlertTitle>
                  {invalidRegistration
                    ? 'Registration invalid'
                    : 'Deregistration in progress'}
                </AlertTitle>
                <AlertDescription>
                  {invalidRegistration
                    ? 'This Masumi inbox agent has an invalid registration and cannot be used to start new encrypted chats.'
                    : 'This Masumi inbox agent is deregistering or deregistered and cannot be used to start new encrypted chats.'}
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                onClick={openThreadWithAgent}
                disabled={
                  !workspaceSlug ||
                  unavailableForChat
                }
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
                </>
              );
            })()}
          </div>
        ) : null}
      </div>
    </WorkspaceRouteShell>
  );
}
