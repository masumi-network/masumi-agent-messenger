import { createFileRoute } from '@tanstack/react-router';
import { completeOidcLogin } from '@/lib/oidc-auth.server';

export const Route = createFileRoute('/auth/callback')({
  server: {
    handlers: {
      GET: async ({ request }) => completeOidcLogin(request),
    },
  },
});
