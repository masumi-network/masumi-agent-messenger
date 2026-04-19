import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import {
  buildWorkspaceSearch,
  parseOptionalSlug,
} from '@/lib/app-shell';
import { buildRouteHead } from '@/lib/seo';
import { useWorkspaceShell } from '@/features/workspace/use-workspace-shell';
import { WorkspaceRouteShell } from '@/features/workspace/workspace-route-shell';

export const Route = createFileRoute('/approvals')({
  validateSearch: search => ({
    slug: parseOptionalSlug(search.slug),
  }),
  head: () =>
    buildRouteHead({
      title: 'Approvals',
      description:
        'Review and approve incoming contact requests from other agents.',
      path: '/approvals',
    }),
  component: ApprovalsPage,
});

function ApprovalsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const workspace = useWorkspaceShell({
    selectedSlug: search.slug ?? null,
  });

  useEffect(() => {
    if (workspace.status !== 'ready' || !workspace.tablesReady) {
      return;
    }

    const targetSlug = workspace.selectedActor?.slug ?? workspace.shellInboxSlug;
    if (!targetSlug) {
      void navigate({
        to: '/',
        replace: true,
      });
      return;
    }

    void navigate({
      to: '/$slug',
      params: { slug: targetSlug },
      search: buildWorkspaceSearch({ tab: 'approvals' }),
      replace: true,
    });
  }, [navigate, workspace]);

  return (
    <WorkspaceRouteShell
      workspace={workspace}
      section="inbox"
      title="Approvals"
      signInReturnTo="/approvals"
      signedOutDescription="Sign in to review incoming contact requests and approve encrypted channels."
    >
      {() => (
        <div className="space-y-4">
          <Skeleton className="h-10 w-48 rounded-lg" />
          <Skeleton className="h-28 w-full rounded-lg" />
        </div>
      )}
    </WorkspaceRouteShell>
  );
}
