import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { buildRouteHead } from '@/lib/seo';
import { useWorkspaceShell } from '@/features/workspace/use-workspace-shell';
import { WorkspaceRouteShell } from '@/features/workspace/workspace-route-shell';

export const Route = createFileRoute('/$slug/manage')({
  head: ({ params }) =>
    buildRouteHead({
      title: 'Inbox settings',
      description: `Configure inbox settings, policies, and registration for /${params.slug}.`,
      path: `/${params.slug}/manage`,
    }),
  component: ManageInboxRedirectPage,
});

function ManageInboxRedirectPage() {
  const params = Route.useParams();
  const navigate = useNavigate();
  const workspace = useWorkspaceShell({
    selectedSlug: params.slug,
  });

  useEffect(() => {
    if (workspace.status !== 'ready' || !workspace.tablesReady) {
      return;
    }

    void navigate({
      to: '/agents',
      replace: true,
    });
  }, [navigate, workspace]);

  return (
    <WorkspaceRouteShell
      workspace={workspace}
      section="inbox"
      title="Settings"
      signInReturnTo={`/${params.slug}/manage`}
      signedOutDescription="Manage inbox settings after signing in."
    >
      {() => (
        <div className="space-y-4">
          <Skeleton className="h-10 w-48 rounded-lg" />
          <Skeleton className="h-32 w-full rounded-lg" />
        </div>
      )}
    </WorkspaceRouteShell>
  );
}
