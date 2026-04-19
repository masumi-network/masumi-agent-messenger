import { SignIn, Tray, WarningCircle } from '@phosphor-icons/react';
import { buildLoginHref } from '@/lib/auth-session';
import { InboxShell } from '@/components/app/inbox-shell';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type {
  WorkspaceShellReadyState,
  WorkspaceShellState,
} from './use-workspace-shell';
import type { AppShellSection } from '@/lib/app-shell';

type WorkspaceRouteShellProps = {
  workspace: WorkspaceShellState;
  section: AppShellSection;
  title?: string;
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
  signInReturnTo,
  signedOutDescription,
  signedOutTitle,
  children,
}: WorkspaceRouteShellProps) {
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
    const heroTitle = signedOutTitle ?? title ?? 'masumi-agent-messenger';
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-md">
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-xl border border-primary/20 bg-primary/10">
              <Tray className="h-7 w-7 text-primary" aria-hidden />
            </div>
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
              masumi-agent-messenger
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

  return (
    <InboxShell
      section={section}
      title={title}
      sessionEmail={workspace.session.user.email ?? ''}
      currentInboxSlug={workspace.selectedActor?.slug ?? workspace.shellInboxSlug}
      connected={workspace.connected}
      connectionError={workspace.connectionError}
      pendingApprovals={workspace.approvalView.pendingIncomingCount}
      ownedAgents={workspace.ownedInboxAgents.map(entry => ({
        slug: entry.actor.slug,
        displayName: entry.actor.displayName,
        publicIdentity: entry.actor.publicIdentity,
      }))}
    >
      {typeof children === 'function' ? children(workspace) : children}
    </InboxShell>
  );
}
