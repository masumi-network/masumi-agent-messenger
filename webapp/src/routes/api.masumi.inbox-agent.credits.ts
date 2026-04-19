import { createFileRoute } from '@tanstack/react-router';
import { loadMasumiCreditsForSession } from '@/lib/inbox-agent-registration.server';
import { readAuthenticatedBrowserSession } from '@/lib/oidc-auth.server';
import { appendStandardSecurityHeaders } from '@/lib/security';

function jsonResponse(body: unknown, status = 200, cookies: string[] = []): Response {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
  });
  for (const cookie of cookies) {
    headers.append('Set-Cookie', cookie);
  }
  appendStandardSecurityHeaders(headers);
  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}

export const Route = createFileRoute('/api/masumi/inbox-agent/credits')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { session, cookies } = await readAuthenticatedBrowserSession(request);
        if (!session) {
          return jsonResponse(
            {
              error: 'Sign in again to continue.',
            },
            401,
            cookies
          );
        }

        try {
          const creditsRemaining = await loadMasumiCreditsForSession(session);
          return jsonResponse(
            {
              creditsRemaining,
            },
            200,
            cookies
          );
        } catch (error) {
          return jsonResponse(
            {
              error:
                error instanceof Error
                  ? error.message
                  : 'Unable to load Masumi credits',
            },
            502,
            cookies
          );
        }
      },
    },
  },
});
