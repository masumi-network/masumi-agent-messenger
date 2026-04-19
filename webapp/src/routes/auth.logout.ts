import { createFileRoute } from '@tanstack/react-router';
import { logoutOidcSession } from '@/lib/oidc-auth.server';
import { appendStandardSecurityHeaders } from '@/lib/security';

export const Route = createFileRoute('/auth/logout')({
  server: {
    handlers: {
      GET: async () => {
        const headers = new Headers({
          Allow: 'POST',
          'Cache-Control': 'no-store',
        });
        appendStandardSecurityHeaders(headers, {
          includeDocumentCsp: true,
          isDev: import.meta.env.DEV,
        });
        return new Response('Use POST to sign out.', {
          status: 405,
          headers,
        });
      },
      POST: async ({ request }) => logoutOidcSession(request),
    },
  },
});
