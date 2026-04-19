import { createFileRoute } from '@tanstack/react-router';
import {
  syncMasumiInboxAgentRegistrationForSession,
} from '@/lib/inbox-agent-registration.server';
import { readAuthenticatedBrowserSession } from '@/lib/oidc-auth.server';
import {
  appendStandardSecurityHeaders,
  assertSameOriginUnsafeRequest,
} from '@/lib/security';
import {
  masumiRegistrationOutcomeToHttpStatus,
  type SerializedMasumiActorRegistrationSubject,
  type SerializedMasumiRegistrationResponse,
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

  return {
    slug: subject.slug,
    displayName: typeof subject.displayName === 'string' ? subject.displayName : null,
    registration:
      typeof subject.registration === 'object' && subject.registration !== null
        ? (subject.registration as SerializedMasumiActorRegistrationSubject['registration'])
        : null,
  };
}

function registrationResponse(
  body: SerializedMasumiRegistrationResponse,
  cookies: string[]
): Response {
  return jsonResponse(
    body,
    masumiRegistrationOutcomeToHttpStatus(body.registration.status),
    cookies
  );
}

export const Route = createFileRoute('/api/masumi/inbox-agent/sync')({
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
          const result = await syncMasumiInboxAgentRegistrationForSession({
            session,
            subject,
          });
          return registrationResponse(result, cookies);
        } catch (error) {
          return jsonResponse(
            {
              error:
                error instanceof Error
                  ? error.message
                  : 'Unable to sync managed inbox-agent registration',
            },
            400,
            cookies
          );
        }
      },
    },
  },
});
