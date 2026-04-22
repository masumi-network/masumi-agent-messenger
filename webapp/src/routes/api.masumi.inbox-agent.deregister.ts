import { createFileRoute } from '@tanstack/react-router';
import {
  deregisterMasumiInboxAgentForSession,
} from '@/lib/inbox-agent-registration.server';
import { readAuthenticatedBrowserSession } from '@/lib/oidc-auth.server';
import {
  appendStandardSecurityHeaders,
  assertSameOriginUnsafeRequest,
} from '@/lib/security';
import type {
  SerializedMasumiActorRegistrationSubject,
  SerializedMasumiRegistrationResponse,
} from '../../../shared/inbox-agent-registration';

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

function parseSubject(value: unknown): SerializedMasumiActorRegistrationSubject {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Inbox-agent request payload is invalid');
  }

  const subject = value as Record<string, unknown>;
  if (typeof subject.slug !== 'string' || subject.slug.trim().length === 0) {
    throw new Error('Inbox-agent request payload is invalid');
  }

  // Ignore client-supplied `registration` on deregister. The server resolves the
  // authoritative `masumiInboxAgentId` by querying Masumi SaaS with the session's
  // OIDC token. Slug + OIDC binding is the trust anchor.
  return {
    slug: subject.slug,
    displayName: typeof subject.displayName === 'string' ? subject.displayName : null,
    registration: null,
  };
}

function deregistrationResponse(
  body: SerializedMasumiRegistrationResponse,
  cookies: string[]
): Response {
  const state = body.registration.registrationState;
  return jsonResponse(
    body,
    state === 'DeregistrationRequested' || state === 'DeregistrationInitiated'
      ? 202
      : 200,
    cookies
  );
}

export const Route = createFileRoute('/api/masumi/inbox-agent/deregister')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        assertSameOriginUnsafeRequest(request);

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
          const subject = parseSubject(await request.json());
          const result = await deregisterMasumiInboxAgentForSession({
            session,
            subject,
          });
          return deregistrationResponse(result, cookies);
        } catch (error) {
          return jsonResponse(
            {
              error:
                error instanceof Error
                  ? error.message
                  : 'Unable to deregister managed inbox agent',
            },
            400,
            cookies
          );
        }
      },
    },
  },
});
