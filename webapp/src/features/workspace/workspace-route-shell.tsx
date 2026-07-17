import { SignIn, Tray, WarningCircle } from '@phosphor-icons/react';
import { useNavigate } from '@tanstack/react-router';
import { buildLoginHref } from '@/lib/auth-session';
import { InboxShell } from '@/components/app/inbox-shell';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { setActiveActorIdentity } from '@/lib/agent-session';
import type {
  WorkspaceShellReadyState,
  WorkspaceShellState,
} from './use-workspace-shell';
import type {
  AppShellSection,
  SecurityPanel,
} from '@/lib/app-shell';

type WorkspaceRouteShellProps = {
  workspace: WorkspaceShellState;
  section: AppShellSection;
  title?: string;
  selectedChannelSlug?: string | null;
  selectedDiscoverSlug?: string | null;
  securityPanel?: SecurityPanel;
  signInReturnTo: string;
  signedOutDescription: string;
  signedOutTitle?: string;
  children:
    | React.ReactNode
    | ((workspace: WorkspaceShellReadyState) => React.ReactNode);
};

export function WorkspaceRouteShell({
  workspace,
  section,
  title,
  selectedChannelSlug,
  selectedDiscoverSlug,
  securityPanel,
  signInReturnTo,
  signedOutDescription,
  signedOutTitle,
  children,
}: WorkspaceRouteShellProps) {
  const navigate = useNavigate();

  if (workspace.status === 'loading') {
    return (
      <main className="space-y-5 p-4 md:p-6">
        <Skeleton className="h-10 w-48 rounded-lg" />
        <Skeleton className="h-32 w-full rounded-lg" />
      </main>
    );
  }

  if (workspace.status === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-md space-y-6">
          <div className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-destructive/30 bg-destructive/10">
              <WarningCircle className="h-6 w-6 text-destructive" aria-hidden />
            </div>
            <h1 className="text-xl font-semibold tracking-tight">
              Authentication unavailable
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {workspace.auth.error ??
                'The auth provider did not respond. Check your connection, then retry.'}
            </p>
          </div>
          <Button onClick={() => void workspace.auth.refresh()} className="w-full">
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (workspace.status === 'signed_out') {
    const heroTitle = signedOutTitle ?? title ?? 'Masumi Agent Messenger';
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-md">
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-xl border border-primary/20 bg-primary/10">
              <Tray className="h-7 w-7 text-primary" aria-hidden />
            </div>
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
              Masumi Agent Messenger
            </p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight">{heroTitle}</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {signedOutDescription}
            </p>
          </div>

          <div className="rounded-xl border border-border/60 bg-card/60 p-6 shadow-sm backdrop-blur">
            <Button asChild className="w-full" size="lg">
              <a href={buildLoginHref(signInReturnTo)}>
                <SignIn className="h-4 w-4" aria-hidden />
                Sign in with Masumi
              </a>
            </Button>
            <p className="mt-4 text-center text-xs text-muted-foreground">
              Encrypted agent-to-agent inbox on the Masumi network. Keys stay in
              the browser.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (workspace.status === 'verified_email_required') {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-md space-y-6">
          <div className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-destructive/30 bg-destructive/10">
              <WarningCircle className="h-6 w-6 text-destructive" aria-hidden />
            </div>
            <h1 className="text-xl font-semibold tracking-tight">
              Verified email required
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              masumi-agent-messenger binds each inbox to a verified email claim. Sign out,
              then sign in with a provider that exposes a verified email.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (workspace.status !== 'ready') {
    return null;
  }

  const usableAgents = workspace.ownedInboxAgents.filter(
    entry => !entry.deregistered
  );
  const selectionUnavailable =
    workspace.tablesReady &&
    usableAgents.length > 0 &&
    !workspace.selectedActor;
  const handleSelectAgent = async (slug: string) => {
    setActiveActorIdentity({
      email: workspace.email,
      slug,
      accountIdentifier: slug,
    });

    if (section === 'channels') {
      if (selectedChannelSlug) {
        await navigate({
          to: '/channels/$slug',
          params: { slug: selectedChannelSlug },
          search: { agent: slug },
        });
      } else {
        await navigate({
          to: '/channels',
          search: { agent: slug, tab: 'mine' },
        });
      }
      return;
    }

    if (section === 'discover') {
      if (selectedDiscoverSlug) {
        await navigate({
          to: '/discover/$slug',
          params: { slug: selectedDiscoverSlug },
          search: { agent: slug },
        });
      } else {
        await navigate({
          to: '/discover',
          search: { agent: slug },
        });
      }
      return;
    }

    if (section === 'agents') {
      await navigate({
        to: '/agents',
        search: { agent: slug },
      });
      return;
    }

    if (section === 'security') {
      await navigate({
        to: '/security',
        search: {
          agent: slug,
          panel: securityPanel,
        },
      });
      return;
    }

    await navigate({
      to: '/$slug',
      params: { slug },
      search: {
        thread: undefined,
        compose: undefined,
        lookup: undefined,
        tab: undefined,
      },
    });
  };

  return (
    <InboxShell
      section={section}
      title={title}
      sessionEmail={workspace.session.user.email ?? ''}
      currentInboxSlug={workspace.selectedActor?.slug ?? null}
      connected={workspace.connected}
      connectionError={workspace.connectionError}
      pendingApprovals={workspace.approvalView.pendingIncomingCount}
      channelNavEntries={workspace.channelNavEntries}
      selectedChannelSlug={selectedChannelSlug}
      ownedAgents={usableAgents
        .map(entry => ({
          id: entry.actor.id,
          slug: entry.actor.slug,
          displayName: entry.actor.displayName,
          publicIdentity: entry.actor.publicIdentity,
        }))}
      onSelectAgent={handleSelectAgent}
    >
      {selectionUnavailable ? (
        <Alert variant="warning">
          <WarningCircle aria-hidden />
          <AlertTitle>Agent unavailable</AlertTitle>
          <AlertDescription>
            This workspace is not available for the signed-in account. Choose
            an agent from the selector in the header to continue.
          </AlertDescription>
        </Alert>
      ) : typeof children === 'function' ? (
        children(workspace)
      ) : (
        children
      )}
    </InboxShell>
  );
}
