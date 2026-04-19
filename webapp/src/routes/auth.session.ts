import { createFileRoute } from '@tanstack/react-router';
import { readBrowserAuthSession } from '@/lib/oidc-auth.server';

export const Route = createFileRoute('/auth/session')({
  server: {
    handlers: {
      GET: async ({ request }) => readBrowserAuthSession(request),
    },
  },
});
