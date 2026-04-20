import { createFileRoute } from '@tanstack/react-router';
import {
  findMasumiInboxAgentsForSession,
  listMasumiInboxAgentsForSession,
  lookupMasumiInboxAgentForSession,
} from '@/lib/inbox-agent-registration.server';
import { readAuthenticatedBrowserSession } from '@/lib/oidc-auth.server';
import { appendStandardSecurityHeaders } from '@/lib/security';
import type { SerializedMasumiInboxAgentSearchResponse } from '../../../shared/inbox-agent-registration';

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

function parseTake(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error('Search result count must be a positive integer.');
  }
  return parsed;
}

function parsePage(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error('Page must be a positive integer.');
  }
  return parsed;
}

export const Route = createFileRoute('/api/masumi/inbox-agent/find-agents')({
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
          const url = new URL(request.url);
          const search = url.searchParams.get('search')?.trim() ?? '';
          const take = parseTake(url.searchParams.get('take'));
          const page = parsePage(url.searchParams.get('page'));
          const rawMode = url.searchParams.get('mode');
          const mode =
            rawMode === 'browse' || rawMode === 'lookup' ? rawMode : 'search';

          const result =
            mode === 'lookup'
              ? await lookupMasumiInboxAgentForSession({
                  session,
                  slug: search,
                })
              : mode === 'browse' || !search
              ? await listMasumiInboxAgentsForSession({
                  session,
                  take,
                  page,
                })
              : await findMasumiInboxAgentsForSession({
                  session,
                  search,
                  take,
                  page,
                });

          return jsonResponse(
            result satisfies SerializedMasumiInboxAgentSearchResponse,
            200,
            cookies
          );
        } catch (error) {
          return jsonResponse(
            {
              error:
                error instanceof Error ? error.message : 'Unable to search inbox agents',
            },
            400,
            cookies
          );
        }
      },
    },
  },
});
