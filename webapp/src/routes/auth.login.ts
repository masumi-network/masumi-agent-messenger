import { createFileRoute } from '@tanstack/react-router';
import { beginOidcLogin } from '@/lib/oidc-auth.server';

export const Route = createFileRoute('/auth/login')({
  server: {
    handlers: {
      GET: async ({ request }) => beginOidcLogin(request),
    },
  },
});
