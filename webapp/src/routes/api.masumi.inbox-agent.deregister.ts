import { createFileRoute } from '@tanstack/react-router';
import {
  createMasumiRegistrationOperationalFailureResponse,
  deregisterMasumiInboxAgentForSession,
  masumiRegistrationClientErrorToHttpStatus,
  resolveTrustedOwnedRegistrationSubjectForSession,
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
    registration: null,
  };
}

function deregistrationResponse(
  body: SerializedMasumiRegistrationResponse,
  cookies: string[]
): Response {
  return jsonResponse(
    body,
    masumiRegistrationOutcomeToHttpStatus(body.registration.status),
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
          const requestedSubject = parseSubject(await request.json());
          let subject: SerializedMasumiActorRegistrationSubject;
          try {
            subject = await resolveTrustedOwnedRegistrationSubjectForSession({
              session,
              subject: requestedSubject,
            });
          } catch (error) {
            const clientStatus = masumiRegistrationClientErrorToHttpStatus(error);
            if (clientStatus !== null) {
              return jsonResponse(
                {
                  error:
                    error instanceof Error
                      ? error.message
                      : 'Unable to deregister managed inbox agent',
                },
                clientStatus,
                cookies
              );
            }
            return deregistrationResponse(
              createMasumiRegistrationOperationalFailureResponse({
                session,
                error,
                currentRegistration: requestedSubject.registration,
              }),
              cookies
            );
          }
          try {
            const result = await deregisterMasumiInboxAgentForSession({
              session,
              subject,
            });
            return deregistrationResponse(result, cookies);
          } catch (error) {
            const clientStatus = masumiRegistrationClientErrorToHttpStatus(error);
            if (clientStatus !== null) {
              return jsonResponse(
                {
                  error:
                    error instanceof Error
                      ? error.message
                      : 'Unable to deregister managed inbox agent',
                },
                clientStatus,
                cookies
              );
            }
            return deregistrationResponse(
              createMasumiRegistrationOperationalFailureResponse({
                session,
                error,
                currentRegistration: subject.registration,
              }),
              cookies
            );
          }
        } catch (error) {
          const clientStatus = masumiRegistrationClientErrorToHttpStatus(error);
          if (clientStatus !== null) {
            return jsonResponse(
              {
                error:
                  error instanceof Error
                    ? error.message
                    : 'Unable to deregister managed inbox agent',
              },
              clientStatus,
              cookies
            );
          }
          return deregistrationResponse(
            createMasumiRegistrationOperationalFailureResponse({
              session,
              error,
            }),
            cookies
          );
        }
      },
    },
  },
});
