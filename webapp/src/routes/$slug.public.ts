import { createFileRoute } from '@tanstack/react-router';
import { fetchPublishedPublicRouteBySlug } from '@/lib/spacetimedb-server';
import { appendStandardSecurityHeaders } from '@/lib/security';

export const Route = createFileRoute('/$slug/public')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const headers = new Headers({
          'Cache-Control': 'no-store',
        });
        appendStandardSecurityHeaders(headers);
        try {
          const publicRoute = await fetchPublishedPublicRouteBySlug(params.slug);
          if (!publicRoute) {
            return new Response('Inbox slug not found', {
              status: 404,
              headers,
            });
          }

          return Response.json(publicRoute, {
            headers,
          });
        } catch (error) {
          const body =
            error instanceof Error
              ? error.message
              : 'Unable to load published inbox keys';
          return new Response(body, {
            status: 502,
            headers,
          });
        }
      },
    },
  },
});
